/** Production Browser Pool + real WebHelm/ChatGPT/Z.ai sites, opt-in only.
 * Every submitted prompt is an inert isolated test. No Relay jobs or side effects.
 * Never touch existing user sessions, use a disposable isolated SQLite store.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

if (process.env.RELAY_BROWSER_POOL_LIVE !== '1') {
  console.log(JSON.stringify({outcome:'NOT_RUN',reason:'Set RELAY_BROWSER_POOL_LIVE=1 to use real browser providers'}));
  process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),'relay-browser-pool-live-'));
process.env.AGENTS_RELAY_STORE_DIR=root;
const {pooledWebHelmRun,browserWorkerPool}=await import('../../dist/browser-worker-runtime.js');
const {BrowserPoolAdmissionError}=await import('../../dist/browser-worker-pool.js');
const {webHelmDaemonRequest}=await import('../../dist/webhelm-daemon-client.js');
await webHelmDaemonRequest({op:'workspace-create',name:'Relay',pool_size:6});
const capacity=await webHelmDaemonRequest({op:'capacity',workspace:'Relay'});
assert.ok(Number(capacity.available)>=5,`Need 5 free browser tab slots; found ${capacity.available}. Never disrupt other sessions.`);
const pool=browserWorkerPool();
const opened=[];const evidence=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const log=(name,data)=>{const row={name,at:new Date().toISOString(),...data};evidence.push(row);console.log(JSON.stringify(row));};
async function submitted(run,provider){
  const receipt=JSON.parse(await Promise.race([run.submitted,pause(100000).then(()=>{throw Error(provider+' submission deadline exceeded');})]));
  assert.equal(receipt.status,'submitted');
  assert.ok(receipt.verified_by,'Missing verification evidence');
  assert.match(receipt.thread_url,provider==='z'?/^https:\/\/chat\.z\.ai\/c\/[\w-]+$/:/^https:\/\/chatgpt\.com\/c\/[\w-]+$/);
  return receipt;
}
function run(provider,label,options={}){
  const id=`live-${label}-${randomUUID()}`;
  const request={provider,executionId:id,timeoutMs:300000,monitorIntervalMs:600,recoveryMinMs:240000,
    onActivity:message=>log('observed-output',{provider,label,message}),
    build:async()=>{
      if(options.failBeforeSubmission)throw Error('Injected isolated pre-submission site failure');
      return {action:'new-thread',config: provider==='z'
        ? {message:`Safe Browser Pool live E2E ${label}. Reply only: POOL-E2E-${label}.`,wait:false,timeout_seconds:90}
        : {message:`Safe Browser Pool live E2E ${label}. Reply only: POOL-E2E-${label}.`,temporary:false}};
    },
  };
  const instance=pooledWebHelmRun(request,new AbortController().signal);
  opened.push(instance);
  return instance;
}
try{
  const z=run('z','Z-HEALTHY');
  const zReceipt=await submitted(z,'z');
  log('z-real-submitted',{url:zReceipt.thread_url,leased:pool.snapshot('z').leased});
  const first=run('chatgpt','CHAT-1');
  const firstReceipt=await submitted(first,'chatgpt');
  const second=run('chatgpt','CHAT-2');
  const secondReceipt=await submitted(second,'chatgpt');
  const third=run('chatgpt','CHAT-3');
  const thirdReceipt=await submitted(third,'chatgpt');
  assert.equal(pool.snapshot('chatgpt').leased,3);
  log('three-real-chatgpt-slots',{leased:3,urls:[firstReceipt.thread_url,secondReceipt.thread_url,thirdReceipt.thread_url]});
  const fourth=run('chatgpt','CHAT-QUEUED');
  await pause(1700);
  const queued=pool.snapshot('chatgpt');
  assert.equal(queued.queued,1,'Fourth live worker must wait on the queue');
  assert.equal(queued.leased,3);
  assert.equal(pool.snapshot('z').leased,1,'Independent Z provider keeps its own lease');
  log('queue-waiting',{queued:queued.queued,leased:queued.leased});
  await first.release();
  const fourthReceipt=await submitted(fourth,'chatgpt');
  assert.equal(pool.snapshot('chatgpt').queued,0);
  assert.equal(pool.snapshot('chatgpt').leased,3);
  log('queue-woke-up',{url:fourthReceipt.thread_url,leased:3});
  await Promise.all([second.release(),third.release(),fourth.release(),z.release()]);
  assert.equal(pool.snapshot('chatgpt').leased,0);
  assert.equal(pool.snapshot('z').leased,0);
  const broken=run('z','Z-OUTAGE',{failBeforeSubmission:true});
  await assert.rejects(broken.submitted,error=>error instanceof BrowserPoolAdmissionError&&error.code==='PROVIDER_UNAVAILABLE');
  assert.equal(pool.snapshot('z').health,'HEALTHY','Local pre-submit errors must not trip provider breaker');
  // Inject an independently observed provider outage. This is a controlled fault, not a site outage.
  pool.reportPreSubmissionOutage('z',1000);
  assert.equal(pool.snapshot('z').health,'UNAVAILABLE');
  await assert.rejects(pool.acquire('z','z-fast-fail'),error=>error.code==='PROVIDER_UNAVAILABLE');
  log('fault-fast-rejection',{health:pool.snapshot('z').health,leased:pool.snapshot('z').leased});
  await pause(1200); // Circuit cooldown expires and allows the next real browser probe.
  assert.equal(pool.snapshot('z').health,'HEALTHY');
  const healed=run('z','Z-HEALED');
  const healedReceipt=await submitted(healed,'z');
  assert.equal(pool.snapshot('z').leased,1);
  await healed.release();
  log('provider-healed',{url:healedReceipt.thread_url,leased:pool.snapshot('z').leased});
  assert.equal(pool.snapshot('z').leased,0);
  assert.equal(pool.snapshot('chatgpt').leased,0);
  assert.equal(pool.snapshot('chatgpt').quarantined+pool.snapshot('z').quarantined,0,'All verified terminal releases must be clean');
  log('PASS',{outcome:'PASS',realBrowserSites:['chatgpt','z'],submittedThreads:6,queueWakeups:1,preSubmissionFaults:1});
}finally{
  await Promise.allSettled(opened.map(run=>run.release()));
  const remaining={chatgpt:pool.snapshot('chatgpt'),z:pool.snapshot('z')};
  log('cleanup',{remaining});
  pool.close();
  await rm(root,{recursive:true,force:true});
}
