import { join } from 'node:path';
import { homedir } from 'node:os';
import { terminalRecoveryEligible } from './terminal-event-recovery.js';
import { spawnOwnedProcess } from './owned-process.js';
import { BrowserWorkerPoolManager, BrowserPoolAdmissionError, type BrowserProvider, type BrowserSlot } from './browser-worker-pool.js';
import { monitorPoolDecision, progressPoolDecision } from './browser-worker-pool-graph.js';
import { webHelmDaemonRequest } from './webhelm-daemon-client.js';

export type BrowserReceipt = { status: string; thread_id?: string | null; thread_url?: string | null; verified_by?: string | null };
export type PoolSubmission = {
  provider: BrowserProvider; executionId: string; timeoutMs: number;
  /** Optional isolated store for test-owned pools and nondefault deployments. */
  pool?: BrowserWorkerPoolManager;
  build: () => Promise<{action: 'new-thread'|'new-turn';config:Record<string,unknown>}>;
  recover?: (threadId: string) => Promise<Record<string,unknown>>;
  onActivity?: (message: string) => void | Promise<void>;
  /** Recovery is telemetry only; it must not synthesize task.progress. */
  onRecovery?: (threadId: string, verifiedBy: string) => void | Promise<void>;
  monitorIntervalMs?: number; // injection for deterministic runtime tests
  recoveryMinMs?: number;
  heartbeatIntervalMs?: number;
  completionRecoveryGraceMs?: number;
};
export type PooledRun = { submitted: Promise<string>; promise: Promise<string>; release: () => Promise<void>; cancel: () => void };
const WORKSPACE = 'Neo';
const WORKSPACE_CAPACITY = 6;
let pendingWorkspaceProvision: Promise<void> | undefined;
async function ensureNeoWorkspace(): Promise<void> {
  if (!pendingWorkspaceProvision) {
    pendingWorkspaceProvision = (async () => {
      // Shared setup must outlive cancellation by one waiting Worker.
      await cliCommand(['ensure']);
      await webHelmDaemonRequest({op:'workspace-create',name:WORKSPACE,pool_size:WORKSPACE_CAPACITY});
    })();
    void pendingWorkspaceProvision.finally(() => {pendingWorkspaceProvision=undefined;}).catch(() => {});
  }
  await pendingWorkspaceProvision;
}

const OUTPUT_LIMIT = 2_000_000;
let manager: BrowserWorkerPoolManager | undefined;
export const browserWorkerPool = (): BrowserWorkerPoolManager => manager ??= new BrowserWorkerPoolManager();

function cliCommand(args: string[], input?: string, signal?: AbortSignal): Promise<string> {
  const executable = process.env.AGENTS_RELAY_WEBHELM_COMMAND || join(homedir(), '.local/bin/webhelm');
  return new Promise((resolve,reject)=>{
    const child = spawnOwnedProcess(executable,args,{
      invocation:'browser-worker-pool:webhelm',signal,
      timeoutMs: args[0]==='session' && args[1]==='exec' ? 25_000 : 150_000,
      spawn:{shell:false,stdio:[input===undefined?'ignore':'pipe','pipe','pipe']},
    });
    let out='',err='';
    child.stdout?.on('data',(part:Buffer)=>{out=(out+part.toString()).slice(-OUTPUT_LIMIT);});
    child.stderr?.on('data',(part:Buffer)=>{err=(err+part.toString()).slice(-20000);});
    child.on('error',reject);
    child.on('close',code=>code===0?resolve(out.trim()):reject(Error(err.trim()||out.trim()||`WebHelm exited ${code}`)));
    if(input!==undefined) child.stdin?.end(input);
  });
}
function parseEnvelope(value: string): Record<string,unknown> {
  const entries = value.trim().split(/\r?\n/);
  for(let i=entries.length-1;i>=0;i--){
    try {
      const result=JSON.parse(entries[i]) as Record<string,unknown>;
      if(result.result && typeof result.result==='object') {
        const inner=result.result as Record<string,unknown>;
        if(inner.ok===false) throw Error(String(inner.error||inner.message||'WebHelm action failed'));
        if(typeof inner.stdout==='string' && inner.stdout.trim()) {
          try {return parseEnvelope(inner.stdout);} catch { /* some actions return plain text */ }
        }
        if(inner.value && typeof inner.value==='object') return inner.value as Record<string,unknown>;
        return inner;
      }
      if(typeof result.stdout==='string' && result.stdout.trim()){
        try {return parseEnvelope(result.stdout);} catch { /* not a structured stdout */ }
      }
      if(result.value && typeof result.value==='object')return result.value as Record<string,unknown>;
      return result;
    } catch(error) { if(i===0) throw error; }
  }
  throw Error('WebHelm returned no structured result');
}
async function configRun(provider: BrowserProvider, action: string, sessionId: string, config: Record<string,unknown>, signal?: AbortSignal): Promise<Record<string,unknown>> {
  return parseEnvelope(JSON.stringify(await webHelmDaemonRequest({
    op:'platform-run', platform:provider, action, session_id:sessionId, config,
    auto_session:false, workspace:WORKSPACE,
  },{signal,timeoutMs:150_000})));
}
/** Verify release by exact Session ID; a transient navigation error may
 * already have returned the Tab to helm.html but left daemon ownership active.
 * Never free the Relay lease without stop/read-back evidence. */
async function stopWebHelmSessionVerified(sessionId: string): Promise<void> {
  let lastError: Error = new Error('WebHelm Session release was not verified');
  for(let attempt=0;attempt<2;attempt++){
    try {
      const result=await webHelmDaemonRequest({op:'stop',session_id:sessionId},{timeoutMs:45_000});
      if(result.returned_to_idle === true || result.already_closed === true) return;
      lastError=new Error('WebHelm stop returned no verified idle tab receipt');
    }catch(error){lastError=error instanceof Error?error:new Error(String(error));}
    // Idempotent recovery: a lost response is not a failed stop if the
    // daemon independently confirms this exact Session is no longer owned.
    try{
      const state=await webHelmDaemonRequest({op:'list'},{timeoutMs:15_000});
      const sessions=state.sessions;
      if(Array.isArray(sessions) && !sessions.some(row=>
        typeof row==='object' && row!==null && (row as {session_id?:unknown}).session_id===sessionId))return;
    }catch{ /* no proof: keep the original lease */ }
    if(attempt===0)await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw lastError;
}

/** Poll only real assistant output, not page uptime or the browser keepalive. */
const OBSERVE = `const url=(await page_info()).url;
const state=await js('(()=>{const nodes=[...document.querySelectorAll(\"[data-message-author-role=assistant], [data-role=assistant], .assistant-message, .markdown\")];const text=(nodes.at(-1)?.innerText||\"\").slice(-16000);const generating=!!document.querySelector(\"button[aria-label*=Stop],button[aria-label*=stop],[data-testid=stop-button]\");const stream=window.__webhelmZStream?.entries?.at(-1);return {text, generating, streamLength: stream?.body?.length||0, streamState: stream?.state||null}})()');
console.log(JSON.stringify({url,state}));`;
type Observation={url?:string;state?:{text?:string;generating?:boolean;streamLength?:number;streamState?:string|null}};
function fingerprint(data:Observation):string{return `${data.state?.text||''}|${data.state?.streamLength||0}`;}

export function pooledWebHelmRun(request: PoolSubmission, signal: AbortSignal): PooledRun {
  const pool=request.pool ?? browserWorkerPool();
  let lease:BrowserSlot|undefined;
  let sessionId:string|undefined;
  let released=false;
  let stopped=false;
  let monitor:ReturnType<typeof setInterval>|undefined;
  let heartbeatTimer:ReturnType<typeof setInterval>|undefined;
  let pendingHeartbeat:Promise<void>|undefined;
  let completionRecoveryTimer:ReturnType<typeof setTimeout>|undefined;
  let pendingProbe:Promise<void>|undefined, pendingCompletionRecovery:Promise<void>|undefined;
  let stopping:Promise<void>|undefined;
  let observedAt=Date.now(), lastFingerprint='', sampled=false;
  let recoveries=0, monitoring=false, threadId:string|undefined;
  let submissionAttempted=false, verifiedSubmitted=false, uncertain=false, recoveryOutcomeUncertain=false;
  let providerPreflightFailed=false;
  const stop = ():Promise<void>=>{
    if(stopping)return stopping;
    stopped=true;
    if(monitor)clearInterval(monitor);
    if(heartbeatTimer)clearInterval(heartbeatTimer);
    if(completionRecoveryTimer)clearTimeout(completionRecoveryTimer);
    stopping=(async()=>{
      // Clearing the interval does not cancel an already running WebHelm
      // command. Drain it before closing the session or releasing the slot.
      await Promise.allSettled([pendingProbe,pendingCompletionRecovery,pendingHeartbeat]);
      if(!lease)return;
      if(uncertain){pool.quarantine(lease);return;}
      if(!sessionId){pool.release(lease);return;}
      try { await stopWebHelmSessionVerified(sessionId);pool.release(lease); }
      catch { pool.quarantine(lease); }
    })();
    return stopping;
  };
  const release=async():Promise<void>=>{released=true;if(lease)await stop();};
  const cancel=():void=>{
    released=true;
    if(!lease)return;
    if(verifiedSubmitted || submissionAttempted) {
      uncertain=true;
      pool.quarantine(lease);
    }
    // Cancel must halt keepalives and probes even when delivery is uncertain.
    // Leave the quarantined Session open; WebHelm can reclaim it on demand
    // after its last_used_at expires without falsely freeing the Relay slot.
    void stop().catch(()=>{});
  };
  const canRecoverTerminal=():boolean=>terminalRecoveryEligible({
    hasSession:!!sessionId, hasThread:!!threadId, terminalObserved:false, recoveryAttempts:recoveries,
    outcomeUncertain:recoveryOutcomeUncertain, cancelled:stopped||released||uncertain,
  });
  const sendRecovery=async():Promise<void>=>{
    if(!request.recover||!sessionId||!threadId||!canRecoverTerminal())return;
    recoveries++;
    const cfg=await request.recover(threadId);
    try{
      const answer=await configRun(request.provider,'new-turn',sessionId,cfg);
      if(!['submitted','completed'].includes(String(answer.status)) || !answer.verified_by)
        throw Error('Recovery turn not independently verified');
      await request.onRecovery?.(threadId,String(answer.verified_by));
    }catch(error){
      // An ambiguous recovery can already have been delivered. Preserve the original session.
      recoveryOutcomeUncertain=true;uncertain=true;
      if(lease)pool.quarantine(lease);
      throw error;
    }
  };
  const probe=async():Promise<void>=>{
    if(stopped||monitoring||!sessionId||!lease?.threadUrl)return;
    monitoring=true;
    try {
      const now=Date.now();
      const observation=parseEnvelope(JSON.stringify(await webHelmDaemonRequest({
        op:'exec', session_id:sessionId, code:OBSERVE,
      },{timeoutMs:45_000}))) as Observation;
      if(observation.url && observation.url.split('?')[0].replace(/\/$/,'')!==lease.threadUrl.replace(/\/$/,'')) return;
      const current=fingerprint(observation);
      if(!sampled){sampled=true;lastFingerprint=current;return;}
      const fresh=current!==lastFingerprint && current!=='|0';
      if(progressPoolDecision(fresh)==='extendTimeout'){
        lastFingerprint=current;observedAt=now;pool.touch(lease);
        // Relay correlates task.progress with the original execution and re-arms its inactivity watchdog.
        await request.onActivity?.('Browser Worker produced new assistant output');
      }
      const due=now-observedAt>=Math.max(request.recoveryMinMs ?? 60_000,Math.round(request.timeoutMs*.6)) &&
        !observation.state?.generating && canRecoverTerminal() && !!request.recover;
      if(monitorPoolDecision(due)==='recoverTurn' && request.recover && threadId){
        // Count before the send. An ambiguous response must never cause automatic retransmission.
        observedAt=now;
        await sendRecovery(); // A recovery receipt cannot extend Relay's inactivity deadline.
      }
    } catch {
      // An uncertain browser operation is not a verified task failure. Leave its lease reserved.
      // Terminal-event recovery and Relay's Task Graph retain authority.
    } finally {monitoring=false;}
  };
  const promise=(async():Promise<string>=>{
    try {
      lease=await pool.acquire(request.provider,request.executionId,signal);
      if(released || signal.aborted)throw Error('Browser worker cancelled before submission');
      // Provider code must be present before opening any site or submitting work.
      let profile:Record<string,unknown>;
      try {profile=parseEnvelope(await cliCommand(['platform','profile',request.provider],undefined,signal));}
      catch(error) {providerPreflightFailed=true;throw error;}
      if(profile.platform!==request.provider)throw Error(`WebHelm platform ${request.provider} missing`);
      let session:Record<string,unknown>;
      try {
        await ensureNeoWorkspace();
        session=await webHelmDaemonRequest({op:'start',workspace:WORKSPACE},{signal,timeoutMs:60_000});
      }
      catch(error) {providerPreflightFailed=true;throw error;}
      if(typeof session.session_id!=='string')throw Error('No WebHelm session ID');
      sessionId=session.session_id;
      pool.bindSession(lease,sessionId);
      if (session.workspace !== WORKSPACE || session.workspace_supported !== true) {
        throw Error('WebHelm returned a Session outside the provisioned Neo Workspace');
      }
      // Keep session last_used_at fresh without mutating the worker's model progress.
      const heartbeatPeriod = Math.max(1000,Math.min(request.heartbeatIntervalMs ?? 45_000,60_000));
      heartbeatTimer=setInterval(()=>{
        if(stopped || !sessionId || pendingHeartbeat) return;
        const active=webHelmDaemonRequest({op:'heartbeat',session_id:sessionId},{timeoutMs:15_000})
          .then(reply=>{if(reply.alive!==true)throw Error('WebHelm rejected Session heartbeat');})
          .catch(()=>{ /* Transport liveness is never a Relay task.progress event. */ })
          .finally(()=>{if(pendingHeartbeat===active)pendingHeartbeat=undefined;});
        pendingHeartbeat=active;
      },heartbeatPeriod);
      heartbeatTimer.unref();
      if(released || signal.aborted)throw Error('Browser worker cancelled before submission');
      const cfg=await request.build();
      submissionAttempted=true;
      const receipt=await configRun(request.provider,cfg.action,sessionId,cfg.config,signal);
      if(!['submitted','completed'].includes(String(receipt.status)) || !receipt.verified_by)
        throw Error('Submission outcome unknown: no verified receipt');
      verifiedSubmitted=true;
      const url=typeof receipt.thread_url==='string' ? receipt.thread_url :
        typeof receipt.thread_id==='string' ? `https://${request.provider==='z'?'chat.z.ai':'chatgpt.com'}/c/${receipt.thread_id}` : '';
      pool.bindThread(lease,url);
      threadId=String(receipt.thread_id||new URL(url).pathname.split('/').at(-1));
      pool.reportHealthy(request.provider);
      if(released){await stop();return JSON.stringify(receipt);}
      // Completion proof is independent of CDP polling. Give the worker time to emit
      // its correlated terminal event; the terminal event closes this lease before recovery.
      if(receipt.status==='completed' && request.recover){
        completionRecoveryTimer=setTimeout(()=>{
          pendingCompletionRecovery=sendRecovery().catch(()=>{});
        },request.completionRecoveryGraceMs ?? 12_000);
        completionRecoveryTimer.unref();
      }
      monitor=setInterval(()=>{
        if(monitoring || stopped)return;
        const running=probe();
        pendingProbe=running;
        void running.then(
          ()=>{if(pendingProbe===running)pendingProbe=undefined;},
          ()=>{if(pendingProbe===running)pendingProbe=undefined;},
        );
      },request.monitorIntervalMs ?? 30_000);
      monitor.unref();
      return JSON.stringify(receipt);
    } catch(error) {
      // Safe pre-submission errors can be rejected to Relay for immediate rerouting.
      // A submission whose outcome is uncertain is quarantined, not retried or released.
      const safe = !submissionAttempted;
      const cancelled = released || signal.aborted;
      const reason = error instanceof Error ? error.message : String(error);
      const rejection = safe && !cancelled && !(error instanceof BrowserPoolAdmissionError)
        ? new BrowserPoolAdmissionError('PROVIDER_UNAVAILABLE', `${request.provider} pre-submission failure: ${reason}`)
        : error;
      // A local prompt/configuration error is not evidence that the remote provider is down.
      if (safe && !cancelled && providerPreflightFailed && lease && !(error instanceof BrowserPoolAdmissionError))
        pool.reportPreSubmissionOutage(request.provider);
      if(lease && !stopped){
        if(!safe){uncertain=true;pool.quarantine(lease);}
        await stop();
      }
      throw rejection;
    }
  })();
  return {promise,submitted:promise,release,cancel};
}
