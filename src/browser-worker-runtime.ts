import { randomUUID } from 'node:crypto';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnOwnedProcess } from './owned-process.js';
import { BrowserWorkerPoolManager, BrowserPoolAdmissionError, type BrowserProvider, type BrowserSlot } from './browser-worker-pool.js';
import { monitorPoolDecision, progressPoolDecision } from './browser-worker-pool-graph.js';

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
  const file=join(process.env.TMPDIR||'/tmp',`relay-browser-pool-${randomUUID()}.json`);
  try {
    await writeFile(file,JSON.stringify(config),{mode:0o600,flag:'wx'});
    return parseEnvelope(await cliCommand(['platform','run',provider,action,'--session-id',sessionId,'--config',file],undefined,signal));
  } finally { await unlink(file).catch(()=>{}); }
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
  let completionRecoveryTimer:ReturnType<typeof setTimeout>|undefined;
  let browserKeepAliveAt=0, observedAt=Date.now(), lastFingerprint='', sampled=false;
  let recoveries=0, monitoring=false, threadId:string|undefined;
  let submissionAttempted=false, verifiedSubmitted=false, uncertain=false, recoveryOutcomeUncertain=false;
  let providerPreflightFailed=false;
  const stop = async ():Promise<void>=>{
    if(stopped)return;
    stopped=true;
    if(monitor)clearInterval(monitor);
    if(completionRecoveryTimer)clearTimeout(completionRecoveryTimer);
    if(!lease)return;
    if(uncertain){pool.quarantine(lease);return;}
    if(!sessionId){pool.release(lease);return;}
    try { await cliCommand(['session','stop',sessionId]);pool.release(lease); }
    catch { pool.quarantine(lease); }
  };
  const release=async():Promise<void>=>{released=true;if(lease)await stop();};
  const cancel=():void=>{released=true;if(!lease)return;if(verifiedSubmitted || submissionAttempted){uncertain=true;pool.quarantine(lease);}else void stop().catch(()=>{});};
  const sendRecovery=async():Promise<void>=>{
    if(stopped||released||uncertain||recoveryOutcomeUncertain||!sessionId||!threadId||!request.recover||recoveries>=2)return;
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
      // Chrome's lastAccessed may only update on tab activation. Never classify this as Worker progress.
      if(now-browserKeepAliveAt>=(request.heartbeatIntervalMs ?? 120_000)){
        await cliCommand(['session','exec',sessionId], 'await activate_tab();');
        browserKeepAliveAt=now;
      }
      const observation=parseEnvelope(await cliCommand(['session','exec',sessionId],OBSERVE)) as Observation;
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
        !observation.state?.generating && !recoveryOutcomeUncertain && recoveries<2 && !!request.recover && !!threadId;
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
      try {session=parseEnvelope(await cliCommand(['session','start','--workspace',WORKSPACE],undefined,signal));}
      catch(error) {providerPreflightFailed=true;throw error;}
      if(typeof session.session_id!=='string')throw Error('No WebHelm session ID');
      sessionId=session.session_id;
      pool.bindSession(lease,sessionId);
      // Preserve WebHelm's existing extension lifecycle. Pool capacity is six tabs total.
      await cliCommand(['session','exec',sessionId],`await workspace_resize(${JSON.stringify(WORKSPACE)},6);`);
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
        completionRecoveryTimer=setTimeout(()=>{void sendRecovery().catch(()=>{});},request.completionRecoveryGraceMs ?? 12_000);
        completionRecoveryTimer.unref();
      }
      monitor=setInterval(()=>{void probe();},request.monitorIntervalMs ?? 30_000);
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
        else await stop();
      }
      throw rejection;
    }
  })();
  return {promise,submitted:promise,release,cancel};
}
