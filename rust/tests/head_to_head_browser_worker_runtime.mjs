// Direct original Node public browser-worker-runtime.ts vs native Rust entry.
// Both run against disposable AF_UNIX WebHelm daemon, real owned CLI process
// and separate SQLite Browser Pools. No production browser or user session.
import test from 'node:test';
import assert from 'node:assert/strict';
import {BrowserWorkerPoolManager} from '../../dist/browser-worker-pool.js';
import {browserWorkerPool,pooledWebHelmRun} from '../../dist/browser-worker-runtime.js';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {once} from 'node:events';
const binary=resolve('rust/target/debug/relay-rust2-parity');
const root=mkdtempSync(join(tmpdir(),'rust2-browser-runtime-headtohead-'));
const socketPath=join(root,'webhelm.sock');
const cliPath=binary;
const cases=[
 {provider:'chatgpt',behavior:'release',mode:'normal'},
 {provider:'z',behavior:'release',mode:'normal'},
 {provider:'chatgpt',behavior:'release',mode:'ambiguous'},
 {provider:'z',behavior:'cancel',mode:'normal'},
 {provider:'chatgpt',behavior:'release',mode:'stop-fail'},
 {provider:'z',behavior:'activity',mode:'activity'},
 {provider:'z',behavior:'recovery',mode:'recovery'},
 {provider:'z',behavior:'recovery-uncertain',mode:'recovery-uncertain'},
 {provider:'chatgpt',behavior:'recovery-callback-fails',mode:'recovery-callback-fails'},
];
let mode='normal';
let activeProvider='chatgpt';
let received=[];
let execCount=0;
const server=createServer(conn=>{
 let input='';
 conn.setEncoding('utf8');
 conn.on('data',part=>{
  input+=part;
  if(!input.includes('\n'))return;
  const request=JSON.parse(input.split('\n')[0]);
  received.push(request.op==='platform-run'&&request.action==='new-turn'
    ?'platform-run-new-turn':request.op);
  let response;
  if(request.op==='workspace-create')response={ok:true};
  else if(request.op==='start')response={session_id:'fixture-session-1',workspace:'Relay',workspace_supported:true};
  else if(request.op==='platform-run'){
   const result={status:'submitted',thread_id:'fixture-thread-123',
    thread_url:'https://'+(request.platform==='z'?'chat.z.ai':'chatgpt.com')+'/c/fixture-thread-123',
    verified_by:mode==='ambiguous'||(mode==='recovery-uncertain'&&request.action==='new-turn')
     ?'':'matching-user-turn'};
   response={result:{ok:true,stdout:JSON.stringify(result)}};
  }else if(request.op==='stop'){
   response=mode==='stop-fail'?{error:'stop failed'}:{returned_to_idle:true};
  }else if(request.op==='list')response={sessions:[{session_id:'fixture-session-1'}]};
  else if(request.op==='heartbeat')response={alive:true};
  else if(request.op==='exec'){
   execCount+=1;
   response={ok:true,stdout:JSON.stringify({
    url:'https://'+(activeProvider==='z'?'chat.z.ai':'chatgpt.com')+'/c/fixture-thread-123',
    state:{text:mode==='activity'&&execCount>1?'new assistant output':'',
     streamLength:0,generating:false}
   })};
  }else response={ok:true};
  conn.end(JSON.stringify(response)+'\n');
 });
});
async function withFixture(fn){
 const existing={
  command:process.env.AGENTS_RELAY_WEBHELM_COMMAND,
  workspace:process.env.AGENTS_RELAY_WEBHELM_WORKSPACE,
  socket:process.env.WEBHELM_SOCKET,
 };
 process.env.AGENTS_RELAY_WEBHELM_COMMAND=cliPath;
 process.env.AGENTS_RELAY_WEBHELM_WORKSPACE='Relay';
 process.env.WEBHELM_SOCKET=socketPath;
 try{return await fn();}
 finally{
  for(const [name,value] of [['AGENTS_RELAY_WEBHELM_COMMAND',existing.command],
   ['AGENTS_RELAY_WEBHELM_WORKSPACE',existing.workspace],
   ['WEBHELM_SOCKET',existing.socket]]){
    if(value===undefined)delete process.env[name];else process.env[name]=value;
  }
 }
}
function normalized(receipt,accepted,pool,provider,err,
 activity=false,heartbeat=false,recovered=false,recoveryTurns=0){
 const snap=pool.snapshot(provider);
 return {accepted,activity,heartbeat,recovered,recoveryTurns,status:receipt?.status??null,
  threadId:receipt?.thread_id??null,threadUrl:receipt?.thread_url??null,
  verifiedBy:receipt?.verified_by??null,
  idle:snap.idle,leased:snap.leased,quarantined:snap.quarantined,
  health:snap.health,
  error:accepted?'':String(err).includes('Submission outcome unknown')
   ?'uncertain-submission':'other-failure'};
}
async function original(f,index){
 const pool=new BrowserWorkerPoolManager({path:join(root,'node-'+index+'.sqlite'),
  capacity:1,pollMs:5,queueWaitMs:1500});
 let receipt=null,accepted=false,error='';
 const activities=[],recoveries=[];
 try{
  const run=pooledWebHelmRun({
   pool,provider:f.provider,executionId:'cert-browser-runtime-execution',
   timeoutMs:f.behavior.startsWith('recovery')?100:90000,
   monitorIntervalMs:f.behavior==='activity'||f.behavior.startsWith('recovery')?20:60000,
   heartbeatIntervalMs:f.behavior==='activity'?1000:60000,
   recoveryMinMs:f.behavior.startsWith('recovery')?40:120000,
   recover:f.behavior.startsWith('recovery')
    ?async id=>({thread_id:id,message:'Verify exact terminal EventBus'}):undefined,
   onActivity:message=>activities.push(message),
   onRecovery:(thread,verified)=>{
    if(f.behavior==='recovery-callback-fails')throw Error('callback failure after send');
    recoveries.push({thread,verified});
   },
   build:async()=>({action:'new-thread',config:{message:'isolated parity fixture',wait:false}}),
  },new AbortController().signal);
  try{receipt=JSON.parse(await run.submitted);accepted=true;}
  catch(e){error=e.message;}
  if(accepted&&f.behavior==='activity'){
   await new Promise(resolvePromise=>setTimeout(resolvePromise,1300));
  }
  if(accepted&&f.behavior.startsWith('recovery')){
   await new Promise(resolvePromise=>setTimeout(resolvePromise,650));
  }
  if(accepted&&f.behavior==='cancel')run.cancel();
  else await run.release();
  // Node cancellation quarantines synchronously; health and activity are
  // observed before a final disposal/close.
  return normalized(receipt,accepted,pool,f.provider,error,
   activities.length>0,received.includes('heartbeat'),
   recoveries.some(x=>x.thread==='fixture-thread-123'&&x.verified),
   received.filter(op=>op==='platform-run-new-turn').length);
 }finally{pool.close();}
}
function native(f,index){
 return new Promise((resolvePromise,reject)=>{
  const child=spawn(binary,[],{cwd:process.cwd()});
  let out='',err='';
  child.stdout.on('data',value=>out+=value);
  child.stderr.on('data',value=>err+=value);
  child.on('error',reject);
  child.on('close',code=>{
   if(code!==0)return reject(new Error('Rust parity process failed '+code+' '+err));
   try{
    const message=JSON.parse(out.trim());
    if(!message.ok)return reject(new Error(message.error));
    resolvePromise(message.value);
   }catch(e){reject(e);}
  });
  child.stdin.end(JSON.stringify({op:'certBrowserWorkerRuntime',
   poolPath:join(root,'rust-'+index+'.sqlite'),socketPath,cliPath,
   provider:f.provider,behavior:f.behavior})+'\n');
 });
}
test('original Node/Rust public Browser Worker Runtime real IPC, lease and quarantine parity',async()=>{
 assert.equal(typeof browserWorkerPool,'function');
 await new Promise((resolvePromise,reject)=>server.listen(socketPath,resolvePromise).once('error',reject));
 try{
  for(let i=0;i<cases.length;i++){
   const f=cases[i];mode=f.mode;activeProvider=f.provider;received=[];execCount=0;
   const a=await withFixture(()=>original(f,i));
   const aOperations=[...received];
   received=[];execCount=0;
   const b=await native(f,i);
   const bOperations=[...received];
   assert.deepEqual(b,a,'Browser public runtime mismatch '+JSON.stringify(f));
   if(f.behavior!=='activity'&&!f.behavior.startsWith('recovery')){
    assert.deepEqual(bOperations,aOperations,
      'Real WebHelm IPC operation mismatch '+JSON.stringify(f));
   }else if(f.behavior==='activity'){
    assert.equal(bOperations.filter(op=>op==='heartbeat').length,1);
    assert.equal(bOperations.filter(op=>op==='exec').length,2);
    assert.ok(aOperations.some(op=>op==='heartbeat'));
    assert.ok(aOperations.some(op=>op==='exec'));
   }else{
    assert.equal(bOperations.filter(op=>op==='platform-run-new-turn').length,1,
     'Rust must never retransmit a recovery that may have been delivered');
    assert.equal(aOperations.filter(op=>op==='platform-run-new-turn').length,1,
     'Node must never retransmit an ambiguous recovery');
   }
  }
 }finally{
  await new Promise(resolvePromise=>server.close(resolvePromise));
  rmSync(root,{recursive:true,force:true});
 }
});
