// Node src/worker-failure-recovery.ts public orchestrator with injected owned
// Store, Graph-selected transition, event emitter and live execution ports.
// No real Job, remote session, Codex CLI, network or second lifecycle policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {handleWorkerLaunchFailure} from '../../dist/worker-failure-recovery.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const fixtures=[];
const task={id:'7',jobId:'41',parentTaskId:null,kind:'work',
 state:'QUEUED',adapter:'codex',attempt:1,maxAttempts:3,
 executionId:'e-1',leaseOwner:'owner',leaseExpiresAt:'future',
 error:null,capabilities:[],dependencies:[]};
for(const phase of ['launch','delivery','start-ack','process','terminal']){
 for(const target of ['FAILED','QUEUED']){
  for(const accepted of [true,false]){
   fixtures.push({op:'workerFailureParity',jobId:'41',taskId:'7',
    executionId:'e-1',phase,failure:'fixture failed',target,accepted,
    job:{id:'41',tasks:[structuredClone(task)]},live:null,repeat:1});
  }
 }
}
for(const scenario of [
 {phase:'launch',live:{executionId:'e-1',workerStarted:false}},
 {phase:'delivery',live:{executionId:'e-1',workerStarted:true}},
 {phase:'delivery',live:{executionId:'other',workerStarted:true}},
 {phase:'start-ack',failure:'WEBHELM_UNAVAILABLE'},
 {phase:'process',repeat:2},
 {phase:'terminal',repeat:2},
 {phase:'launch',executionId:'old'},
 {phase:'launch',executionId:null},
 {phase:'launch',taskId:'unknown'},
 {phase:'delivery',noTransition:true},
 ])fixtures.push({op:'workerFailureParity',jobId:'41',taskId:'7',
 executionId:'e-1',phase:'delivery',failure:'fixture failed',target:'FAILED',
 accepted:true,job:{id:'41',tasks:[structuredClone(task)]},live:null,repeat:1,...scenario});
function normalize(result){
 const value=JSON.parse(JSON.stringify(result));
 for(const event of value.events||[]){
  for(const key of ['id','eventId','event_id','timestamp','at','createdAt']){
   if(key in event)event[key]='<generated>';
  }
 }
 return value;
}
async function original(f){
 const calls=[],events=[];
 const claims=new Set();let live=f.live?structuredClone(f.live):null;
 const job=structuredClone(f.job);
 const ports={
  store:{load:async()=>{calls.push('load');return job;},
   listAgents:async()=>{calls.push('listAgents');return [];}
  },
  adapters:[],
  taskTransitions:{apply:async(_jobId,taskId,event,config)=>{
   calls.push(`transition:${event}`);
   const existing=job.tasks.find(x=>x.id===taskId);
   if(!existing||!config.eligible(job,existing)||f.noTransition)return null;
   const from=existing.state;
   const updated=structuredClone(existing);
   const decision=f.accepted===false?
    {accepted:false,target:null,reason:'no_transition'}:
    {accepted:true,target:f.target,reason:'accepted'};
   calls.push({facts:config.facts()});
   if(decision.accepted){updated.state=f.target;config.mutate(job,updated,decision);}
   return {from,task:updated,decision};
  }},
  live:()=>live,
  launchFailureClaims:claims,
  clearExecution:(taskId,id)=>{calls.push(`clearExecution:${taskId}:${id}`);live=null;},
  clearTerminalWaiter:(taskId,id)=>calls.push(`clearTerminalWaiter:${taskId}:${id}`),
  emit:async event=>{calls.push('emit');events.push(structuredClone(event));},
  detach:(_promise,jobId,taskId,context)=>calls.push(`detach:${jobId}:${taskId}:${context}`),
  wake:(jobId,taskId,reason)=>calls.push(`wake:${jobId}:${taskId}:${reason}`),
 };
 if(live){
  live.controller=new AbortController();
  live.controller.signal.addEventListener('abort',()=>calls.push('abort'));
  live.execution={cancel:()=>calls.push('cancel')};
 }
 const outcomes=[];
 for(let i=0;i<(f.repeat||1);i++){
  try{
   await handleWorkerLaunchFailure(ports,f.jobId,f.taskId,f.executionId,
    new Error(f.failure),f.phase);
   outcomes.push({ok:true});
  }catch(e){outcomes.push({ok:false,error:e.message});}
 }
 return normalize({outcomes,calls,events,claims:claims.size});
}
test('Node/Rust Worker launch failure Graph/SQLite port ordering, stale and duplicate protection',async()=>{
 const expected=[];for(const f of fixtures)expected.push(await original(f));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
  input:fixtures.map(JSON.stringify).join('\n')+'\n',timeout:120000,maxBuffer:8*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(normalize(actual[i].value),expected[i]);}
  catch{mismatches.push({index:i,fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatches.slice(0,5),[],`${mismatches.length} Worker failure API differences`);
 console.log('DIRECT_NODE_RUST_WORKER_FAILURE_PASS',fixtures.length);
});
