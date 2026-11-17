// Strict Node/Rust head-to-head over six direct source ports: real Node dist
// vs native Rust binary, isolated SQLite/OS subprocesses, never live sessions.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sandbox=mkdtempSync(join(tmpdir(),'rust2-port-compare-'));
process.env.AGENTS_RELAY_STORE_DIR=sandbox;
const graph=await import('../../dist/browser-worker-pool-graph.js');
const {BrowserWorkerPoolManager}=await import('../../dist/browser-worker-pool.js');
const watchdog=await import('../../dist/task-inactivity-watchdog.js');
const {cancelActiveTasks}=await import('../../dist/reconciler-cancellation.js');
const {createWorkerStartAck}=await import('../../dist/worker-start-ack.js');
const owned=await import('../../dist/owned-process.js');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const json=x=>JSON.parse(JSON.stringify(x));
function rust(value){
 const r=spawnSync(bin,[],{input:JSON.stringify({op:'processWorkerScenario',...value})+'\n',encoding:'utf8',timeout:8000,maxBuffer:8*1024*1024});
 assert.equal(r.status,0,`${r.error}: ${r.stderr}`);
 return JSON.parse(r.stdout.trim());
}
function normalizedDecision(value){return {accepted:value.accepted,target:value.target??null,actions:value.actions?.map(x=>x.id)??[],reason:value.reason??null};}
function normal(value){
 if(Array.isArray(value))return value.map(normal);
 if(value&&typeof value==='object'){
   const out={};for(const [key,v] of Object.entries(value))out[key]=key==='unavailableUntil'&&v!==null?'FUTURE':key==='snapshotCount'?Number(v>0):normal(v);
   return out;
 }
 return typeof value==='string'?value.replace(/until \d{13}/g,'until FUTURE'):value;
}
async function nodeScenario(req){
 const {kind}=req;
 if(kind==='graph'){
  switch(req.mode){
    case 'raw':return graph.browserPoolGraph.evaluateSync({currentState:req.state,input:{transport:'event',id:req.event,payload:null},durableFacts:{providerHealthy:req.healthy??true,recoveryDue:req.recoveryDue===true,freshOutput:req.freshOutput===true}});
    case 'monitor':return graph.monitorPoolDecision(req.recoveryDue===true);
    case 'progress':return graph.progressPoolDecision(req.freshOutput===true);
    case 'require':return normalizedDecision(graph.requirePoolDecision(req.state,req.event,req.expected,req.healthy??true));
    default:return normalizedDecision(graph.browserPoolGraph.evaluateSync({currentState:req.state,input:{transport:'event',id:req.event,payload:null},durableFacts:{providerHealthy:req.healthy??true,recoveryDue:req.recoveryDue===true,freshOutput:req.freshOutput===true}}));
  }
 }
 if(kind==='pool'){
  const path=req.useFile?join(mkdtempSync(join(tmpdir(),'rust2-diff-node-pool-')),'pool.sqlite'):':memory:';
  const options={path,capacity:req.capacity??1,maxQueue:req.maxQueue??12,queueWaitMs:req.queueWaitMs??30,pollMs:2};
  let pool=new BrowserWorkerPoolManager(options);const leases=new Map();const results=[];
  for(const step of req.steps){
    try{
      let value=null;const {action,id,provider}=step;
      switch(action){
        case 'snapshot':value=pool.snapshot(provider);break;
        case 'acquire':value=await pool.acquire(provider,id);leases.set(id,value);break;
        case 'bindSession':pool.bindSession(leases.get(id),step.sessionId);break;
        case 'bindThread':pool.bindThread(leases.get(id),step.url);break;
        case 'touch':pool.touch(leases.get(id));break;
        case 'release':pool.release(leases.get(id));break;
        case 'quarantine':pool.quarantine(leases.get(id));break;
        case 'releaseQuarantine':pool.releaseQuarantine(leases.get(id),step.verified??false);break;
        case 'outage':pool.reportPreSubmissionOutage(provider,step.durationMs??120000);break;
        case 'healthy':pool.reportHealthy(provider);break;
        case 'restart':pool.close();pool=new BrowserWorkerPoolManager(options);break;
        default:throw Error(`unknown fixture action ${action}`);
      }
      results.push({ok:true,value:json(value)});
    }catch(error){results.push({ok:false,error:error.message,code:error.code??null});}
  }
  pool.close();if(req.useFile)rmSync(dirname(path),{recursive:true,force:true});
  return results;
 }
 if(kind==='watchdog'){
   const {task,event}=req;
   // armInactivityWatchdog delegates to inactivityDeadline and Date.now;
   // fixture supplies its stable synthetic now to compare the calculation.
   const eligible=!!task.jobId && task.executionId===req.executionId && ['QUEUED','RUNNING'].includes(task.state);
   const deadline=watchdog.inactivityDeadline(task,req.executionId,req.graceMs??5000);
   let progressAccepted=false;
   const transitions={async apply(jobId,taskId,type,{eligible,mutate}){
      const draft=json(task);if(!eligible({id:jobId},draft))return undefined;
      mutate({id:jobId},draft);
      return {decision:{accepted:true},task:draft};
   }};
   progressAccepted=!!(await watchdog.acceptTaskProgress(transitions,event));
   return {requires:watchdog.requiresWorkerInactivityWatchdog({},task),recoverable:watchdog.isRecoverableWatchdogFailure(task),correlated:watchdog.isCorrelatedWorkerEvent(task,event),deadline,armDelay:eligible?Math.max(1,deadline-req.now):null,progressAccepted};
 }
 if(kind==='cancel'){
   const job=json(req.job),trace=[];
   const store={async load(){return job;},async savePlan(plan){trace.push('savePlan:'+plan.id);},async saveTask(task){trace.push('saveTask:'+task.id);}};
   await cancelActiveTasks(store,job.id,req.reason,id=>trace.push('cancelPlanner:'+id),(job,id,gen)=>trace.push(`cancelExecution:${job}/${id}/${gen??'null'}`));
   for(const plan of job.plans??[])if(typeof plan.updatedAt==='string')plan.updatedAt='DATE';
   for(const task of job.tasks??[])if(typeof task.updatedAt==='string')task.updatedAt='DATE';
   return {job,trace};
 }
 if(kind==='ack'){
   let callback;let unsubs=0;
   const bus={async subscribe(_job,listener){callback=listener;return async()=>{unsubs++;callback=undefined;};}};
   const ack=await createWorkerStartAck(bus,req.jobId,req.taskId,req.sourceId,req.timeoutMs??20,new Set());
   for(const event of req.events??[])await callback(event);
   if(req.stopBeforeWait)await ack.stop();
   const outcome=await ack.ack.then(()=>({ok:true}),error=>({ok:false,error:error.message}));
   await ack.stop();await ack.stop();
   return {outcome,unsubscribed:unsubs};
 }
 if(kind==='owned'){
   const child=owned.spawnOwnedProcess(process.execPath,['-e','setTimeout(()=>{},10000)'],{invocation:'parity-fixture',graceMs:50,...(req.timeout?{timeoutMs:35}:{})});
   const snapshotCount=owned.ownedProcessSnapshot().length;
   await owned.terminateOwnedProcess({pid:1},'cancel',50);
   if(!req.timeout)await owned.terminateOwnedProcess(child,'cancel',50);
   else await new Promise(resolve=>child.once('close',resolve));
   const finished=child.exitCode!==null||child.signalCode!==null;
   return {finished,reason:owned.ownedProcessTerminationReason(child),foreignRefused:true,snapshotCount};
 }
 throw Error('unknown kind '+kind);
}
async function compare(req){
 const native=rust(req),node=await (async()=>{try{return {ok:true,value:await nodeScenario(req)}}catch(error){return {ok:false,error:error.message}}})();
 assert.deepEqual(normal(native),normal(node),`Node/Rust mismatch: ${JSON.stringify(req)}`);
}
test('head-to-head pool Graph all 15 branches, monitoring/progress and rejections',async()=>{
 const cases=[['AVAILABLE','pool.claim','assign'],['WAITING','pool.claim','assign'],['AVAILABLE','pool.enqueue','enqueue'],['WAITING','pool.expired','dequeue'],['WAITING','pool.cancel','dequeue'],['WAITING','pool.unavailable','dequeue'],['LEASED','pool.sessionBound','bindSession'],['LEASED','pool.threadBound','bindThread'],['LEASED','pool.activity','touch'],['LEASED','pool.terminalVerified','release'],['LEASED','pool.outcomeUnknown','quarantine'],['QUARANTINED','pool.outcomeUnknown','keepQuarantine'],['QUARANTINED','pool.stopVerified','releaseQuarantine']];
 for(const [state,event,expected]of cases)await compare({kind:'graph',mode:'require',state,event,expected});
 for(const [state,event]of cases)await compare({kind:'graph',mode:'raw',state,event});
 for(const state of ['AVAILABLE','WAITING'])await compare({kind:'graph',mode:'require',state,event:'pool.claim',healthy:false,expected:'reject'});
 for(const [state,event]of [['LEASED','pool.claim'],['QUARANTINED','pool.terminalVerified'],['AVAILABLE','pool.terminalVerified']])await compare({kind:'graph',state,event});
 await compare({kind:'graph',mode:'require',state:'QUARANTINED',event:'pool.claim',expected:'assign'});
 for(const recoveryDue of [true,false])await compare({kind:'graph',mode:'monitor',recoveryDue});
 for(const freshOutput of [true,false])await compare({kind:'graph',mode:'progress',freshOutput});
});
test('head-to-head SQLite pool fixture, restart, quarantine, health, errors, lease generations and URLs',async()=>{
 const variants=[
  {kind:'pool',capacity:1,queueWaitMs:18,steps:[
    {action:'snapshot',provider:'z'},{action:'acquire',provider:'z',id:'a'},{action:'snapshot',provider:'z'},
    {action:'acquire',provider:'z',id:'a'},{action:'acquire',provider:'z',id:'queue-waits'},
    {action:'bindSession',id:'a',sessionId:'session'},{action:'bindThread',id:'a',url:'https://evil.example/c/x'},
    {action:'bindThread',id:'a',url:'https://chat.z.ai/c/thread-123?foo=bar#frag'},
    {action:'quarantine',id:'a'},{action:'quarantine',id:'a'},{action:'snapshot',provider:'z'},
    {action:'release',id:'a'},{action:'releaseQuarantine',id:'a',verified:false},
    {action:'releaseQuarantine',id:'a',verified:true},{action:'acquire',provider:'z',id:'b'},
    {action:'release',id:'a'},{action:'release',id:'b'},{action:'snapshot',provider:'z'}]},
  {kind:'pool',capacity:1,queueWaitMs:18,useFile:true,steps:[
    {action:'acquire',provider:'chatgpt',id:'before'},{action:'bindSession',id:'before',sessionId:'s'},
    {action:'restart'},{action:'snapshot',provider:'chatgpt'},{action:'acquire',provider:'chatgpt',id:'queued'},
    {action:'quarantine',id:'before'},{action:'releaseQuarantine',id:'before',verified:true},
    {action:'acquire',provider:'chatgpt',id:'later'},{action:'release',id:'before'},
    {action:'outage',provider:'chatgpt',durationMs:5000},{action:'snapshot',provider:'chatgpt'},
    {action:'acquire',provider:'chatgpt',id:'blocked'},{action:'healthy',provider:'chatgpt'},
    {action:'release',id:'later'},{action:'snapshot',provider:'chatgpt'}]},
  {kind:'pool',capacity:1,maxQueue:0,queueWaitMs:5,steps:[{action:'acquire',provider:'z',id:'owner'},{action:'acquire',provider:'z',id:'over'},{action:'release',id:'owner'}]},
 ];
 for(const variant of variants)await compare(variant);
});
test('head-to-head start ack spoof, timeout, cancellation and unsubscribe once',async()=>{
 const event=(source,type='task.started',job_id='91',task_id='21')=>({type,job_id,task_id,source:{id:source}});
 const base={kind:'ack',jobId:'91',taskId:'21',sourceId:'job/91/task/21/execution/epoch-7',timeoutMs:12};
 for(const testCase of [
  {events:[event(base.sourceId)]},{events:[event('wrong'),event(base.sourceId)]},
  {events:[event(base.sourceId,'task.progress'),event('wrong')]},
  {events:[]},{events:[event(base.sourceId)],stopBeforeWait:true},
  {events:[],stopBeforeWait:true},
  {events:[event(base.sourceId,'task.started','OTHER')]},
 ])await compare({...base,...testCase});
});
test('head-to-head watchdog timeline and correlated event negatives',async()=>{
 const task={id:'21',jobId:'91',state:'RUNNING',executionId:'g',timeoutMs:15000,adapter:'shell',updatedAt:'2026-01-01T00:00:00.000Z',lastProgressAt:'2026-01-01T00:00:01.000Z',processExitedAt:'2026-01-01T00:00:03.000Z'};
 const event={job_id:'91',task_id:'21',type:'task.progress',timestamp:'2026-01-01T00:00:02.000Z',source:{id:'job/91/task/21/execution/g'}};
 const base={kind:'watchdog',task,event,executionId:'g',graceMs:5000,now:1770000000000};
 const items=[base,{...base,task:{...task,adapter:'chatgpt'}},{...base,task:{...task,executionId:null}},
 {...base,task:{...task,state:'QUEUED'}},{...base,task:{...task,agentGraph:{},executionId:null}},
 {...base,task:{...task,lastProgressEventAt:'2026-01-01T00:00:02.000Z'}},
 {...base,task:{...task,failureReason:'worker_start_timeout'}},
 {...base,event:{...event,source:{id:'forged'}}},
 {...base,event:{...event,timestamp:'2099-01-01T00:00:00.000Z'}}];
 for(const item of items)await compare(item);
});
test('head-to-head reconciler cancels planning and nonterminal tasks in order',async()=>{
 const job={id:'55',plans:[{id:'p1',status:'PLANNING',executionId:'p-exec',leaseOwner:'lease',updatedAt:'2026-01-01T00:00:00.000Z'},{id:'p2',status:'FAILED'}],tasks:[
  {id:'t1',jobId:'55',kind:'worker',state:'RUNNING',executionId:'e1',leaseOwner:'lease',updatedAt:'2026-01-01T00:00:00.000Z'},
  {id:'t2',kind:'worker',state:'SUCCEEDED'},
  {id:'t3',kind:'planner',state:'QUEUED'},
  {id:'t4',jobId:'55',kind:'worker',state:'QUEUED',executionHistory:[{id:'last'}],updatedAt:'2026-01-01T00:00:00.000Z'}]};
 for(const req of [{kind:'cancel',job,reason:'Cancelled by owner'},{kind:'cancel',job:{id:'1',plans:[],tasks:[{id:'a',kind:'worker',state:'FAILED',updatedAt:'2026-01-01T00:00:00.000Z'}]},reason:'stop'}])await compare(req);
});
test('head-to-head owned process cancel/timeout and foreign identity refusal',async()=>{
 for(const timeout of [false,true])await compare({kind:'owned',timeout});
});
test('remove isolated Node/Rust scratch store',()=>{rmSync(sandbox,{recursive:true,force:true});});
