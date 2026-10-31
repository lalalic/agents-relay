/** Real Z.ai same-thread recovery Turn + separate model progress evidence. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
if(process.env.RELAY_BROWSER_POOL_LIVE!=='1'){
  console.log(JSON.stringify({outcome:'NOT_RUN',reason:'Explicit RELAY_BROWSER_POOL_LIVE=1 required'}));process.exit(0);
}
const root=await mkdtemp(join(tmpdir(),'relay-browser-pool-real-recovery-'));
process.env.AGENTS_RELAY_STORE_DIR=root;
const {pooledWebHelmRun,browserWorkerPool}=await import('../../dist/browser-worker-runtime.js');
const seen={progress:[],recovery:[]};
let finish;
const completed=new Promise(resolve=>finish=resolve);
const run=pooledWebHelmRun({
  provider:'z',executionId:`live-recovery-${randomUUID()}`,timeoutMs:1500,
  monitorIntervalMs:45000,heartbeatIntervalMs:45000,recoveryMinMs:8500,completionRecoveryGraceMs:3000,
  onActivity:message=>{seen.progress.push({message,at:new Date().toISOString()});console.log(JSON.stringify({event:'real-worker-output',message}));},
  onRecovery:(threadId,verifiedBy)=>{seen.recovery.push({threadId,verifiedBy});console.log(JSON.stringify({event:'verified-original-thread-recovery',threadId,verifiedBy}));finish();},
  build:async()=>({action:'new-thread',config:{message:'Safe Browser Pool recovery E2E. Respond with only POOL-RECOVERY-ORIGINAL. This is an inert test.',wait:true,timeout_seconds:90}}),
  recover:async threadId=>({thread_id:threadId,wait:false,timeout_seconds:90,message:'Safe Browser Pool terminal recovery E2E. The original worker completed the message but no Relay terminal event was sent. Reply only POOL-RECOVERY-VERIFIED; do not publish any Relay events.'}),
},new AbortController().signal);
try{
  const receipt=JSON.parse(await run.submitted);
  assert.equal(receipt.status,'completed');
  assert.match(receipt.thread_url,/^https:\/\/chat\.z\.ai\/c\/[\w-]+$/);
  console.log(JSON.stringify({event:'initial-browser-thread',url:receipt.thread_url,verified:receipt.verified_by}));
  await Promise.race([completed,new Promise((_,reject)=>setTimeout(()=>reject(Error('No verified recovery Turn within 90 seconds')),90000))]);
  assert.equal(seen.recovery.length,1);
  assert.equal(seen.recovery[0].threadId,receipt.thread_id);
  console.log(JSON.stringify({outcome:'PASS',recoveryTurns:seen.recovery.length,outputProgressEvents:seen.progress.length,sourceThreadUrl:receipt.thread_url}));
}finally{
  await run.release();
  console.log(JSON.stringify({event:'cleanup',snapshot:browserWorkerPool().snapshot('z')}));
  browserWorkerPool().close();await rm(root,{recursive:true,force:true});
}
