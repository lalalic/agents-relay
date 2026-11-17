// Direct Node public API ↔ native Rust. In-memory SQLite only, no live processes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {DurableTaskTransitionRuntime} from '../../dist/workflow/durable-transition.js';
import {acceptTaskProgress} from '../../dist/task-inactivity-watchdog.js';
import {plannerOrchestrationFacts} from '../../dist/workflow/planner-orchestration-v2.js';
import {taskResolutionV2} from '../../dist/workflow/task-resolution.js';
const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'workflow'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const clone=x=>JSON.parse(JSON.stringify(x));
let seed=0x20261117;
function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n}
const pick=a=>a[rand(a.length)];
function rust(requests) {
 const p=spawnSync(bin,[],{cwd:root,input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',
  encoding:'utf8',timeout:150000,maxBuffer:20*1024*1024});
 assert.equal(p.status,0,p.stderr||String(p.error));
 const lines=p.stdout.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(lines.length,requests.length);
 return lines;
}
const now=Date.now(),recent=new Date(now-120000).toISOString();
function job() {
 return {id:'31',state:'ACTIVE',plans:[],tasks:[{
 id:'21',jobId:'31',kind:'worker',state:pick(['RUNNING','RUNNING','QUEUED','FAILED','SUCCEEDED']),
 executionId:pick(['gen-1','gen-1',null,'gen-2']),agentName:'developer',timeoutMs:10000,
 updatedAt:recent,lastProgressAt:null,lastProgressEventAt:pick([null,new Date(now-90000).toISOString()])
 }],reviewEnabled:true};
}
async function nodeProgress(request) {
 const j=clone(request.job),ev=clone(request.event);
 const store={async load(){return j},async saveTask(next){const at=j.tasks.findIndex(t=>t.id===next.id);j.tasks[at]=clone(next)}};
 const transitions=new DurableTaskTransitionRuntime(store);
 const accepted=await acceptTaskProgress(transitions,ev);
 const t=j.tasks.find(t=>t.id===ev.task_id);
 return {accepted:accepted!==null,state:t?.state??null,
  lastProgressEventAt:t?.lastProgressEventAt??null,executionId:t?.executionId??null};
}
test('wave3 watchdog: 250 direct randomized Node/Rust sqlite receipt/rejection cases',async()=>{
 const cases=[];
 for(let i=0;i<250;i++){
  const j=job(),id=pick(['gen-1','gen-2','forged']);
  const age=pick([180000,90000,80000,1000,-180000]);
  const event={job_id:'31',task_id:pick(['21','21','none']),type:'task.progress',
    timestamp:new Date(now-age).toISOString(),
    source:{id:pick([ `job/31/task/21/execution/${id}`,'forged','job/OTHER/task/21/execution/gen-1'])}};
  cases.push({op:'wave3Graph',action:'progressSqlite',directory,job:j,event,now});
 }
 const results=rust(cases);
 for(let i=0;i<cases.length;i++){
   const expected=await nodeProgress(cases[i]);
   assert.deepEqual(results[i],{ok:true,value:expected},`case ${i}: ${JSON.stringify(cases[i])}`);
 }
});
test('wave3 planner: 170 direct in-place sort plus durable facts Node/Rust comparisons',()=>{
 const cases=[];
 for(let i=0;i<170;i++){
  const plans=Array.from({length:1+rand(7)},(_,j)=>({
    id:`p${j}`,round:pick([1,1,2,3,5]),createdAt:new Date(now-rand(100000)).toISOString(),
    status:pick(['SUCCEEDED','PLANNING','FAILED']),objectiveStatus:pick(['satisfied','in_progress']),
    trigger:{source:'manual'},manualPlanning:pick([true,false]),forceRestate:pick([true,false])
  }));
  const j={id:'31',state:'ACTIVE',reviewEnabled:pick([true,false]),plans,
   tasks:[],initialPlanning:pick([null,{status:'pending'}])};
  cases.push({op:'wave3Graph',action:'plannerFactsMutable',directory,job:j,recoverable:pick([true,false])});
 }
 const results=rust(cases);
 for(let i=0;i<cases.length;i++){
   const j=clone(cases[i].job),facts=plannerOrchestrationFacts(j,cases[i].recoverable);
   const expected={facts,plans:j.plans};
   assert.deepEqual(results[i],{ok:true,value:expected},`planner case ${i}`);
 }
});
test('wave3 public resolution GraphRuntime surface matches original Node registry',()=>{
 const expected={states:taskResolutionV2.registry.states.size,
 guards:taskResolutionV2.registry.guards.size,actions:taskResolutionV2.registry.actions.size,
 events:taskResolutionV2.registry.events.size};
 assert.deepEqual(rust([{op:'wave3Graph',action:'resolutionRuntime',directory}]),[{ok:true,value:expected}]);
});
test('wave3 coordinator: 160 randomized same-turn Node queueMicrotask batches versus Rust turns',async()=>{
 const {ReconcileCoordinator}=await import('../../dist/reconcile-coordinator.js');
 const cases=[];
 for(let i=0;i<160;i++){
  const signals=Array.from({length:2+rand(9)},(_,n)=>({
   method:pick(['accept','acceptTransport','acceptObserved']),
   signal:{jobId:pick(['31','31','32','33']),reason:`turn-${i}-${n}`,fail:rand(12)===0}
  }));
  cases.push({op:'wave3CoordinatorTurn',signals});
 }
 const actual=rust(cases);
 for(let i=0;i<cases.length;i++){
  const batches=[],failures=[];
  const coordinator=new ReconcileCoordinator(async(jobId,signals)=>{
   batches.push({jobId,signals});
   if(signals.some(s=>s.fail))throw Error('fixture consumer failed');
  },(error,signal)=>failures.push({error:error.message,signal}));
  const promises=cases[i].signals.map(({method,signal})=>coordinator[method](signal)
   .then(()=>({ok:true}),error=>({ok:false,error:error.message})));
  const outcomes=await Promise.all(promises);
  await coordinator.settle();
  batches.sort((a,b)=>a.jobId.localeCompare(b.jobId));
  failures.sort((a,b)=>a.signal.reason.localeCompare(b.signal.reason));
  const expected={outcomes,batches,failures,idle:coordinator.isIdle()};
  assert.deepEqual(actual[i],{ok:true,value:expected},
   `coordinator case ${i}: ${JSON.stringify(cases[i])}`);
 }
});
test('wave3 async Task/Job transitions: 180 direct randomized Node/Rust persist and effect ordering cases',async()=>{
 const {transitionTaskEvent,transitionJobEvent}=await import('../../dist/task-transitions.js');
 const cases=[];
 for(let i=0;i<180;i++){
  const kind=pick(['task','task','job']),effectError=pick([null,null,'injected effect failure']),
   persistError=pick([null,null,'injected persist failure']);
  const entity=kind==='task'?
   {id:'21',jobId:'31',kind:'work',agentName:pick(['developer','troubleshooter']),
    state:pick(['QUEUED','RUNNING','SUCCEEDED','FAILED']),updatedAt:'2026-11-17T08:00:00.000Z',
    dependencies:[],attempt:1,maxAttempts:3,leaseOwner:'owner',executionId:'g'}:
   {id:'31',state:pick(['DRAFT','ACTIVE','CANCELLED']),repository:'sample',
    updatedAt:'2026-11-17T08:00:00.000Z'};
  const event=kind==='task'?pick(['dispatch','task.started','task.completed','cancel','unknown']):pick(['activate','cancel','unknown']);
  const facts=kind==='task'?{dispatchable:pick([true,false]),recoverableExecution:pick([true,false])}:{};
  cases.push({op:'wave3Graph',action:'asyncTransition',directory,
    kind,entity,event,facts,effectError,persistError,timestamp:'2026-11-17T09:00:00.000Z'});
 }
 const results=rust(cases);
 for(let i=0;i<cases.length;i++){
  const q=cases[i],entity=clone(q.entity),trace=[];
  let outcome;
  const effect=async action=>{
   trace.push('effect:'+action);
   if(q.effectError)throw Error(q.effectError);
  },persist=async()=>{trace.push('persist');if(q.persistError)throw Error(q.persistError)};
  try {
   const decision=await (q.kind==='task'?
    transitionTaskEvent(entity,q.event,q.facts,effect,persist):
    transitionJobEvent(entity,q.event,q.facts,effect,persist));
   outcome={ok:true,decision};
  }catch(error){outcome={ok:false,error:error.message}}
  // Only the wall-clock updatedAt is nondeterministic; Graph actions and all
  // failure outcomes must compare exactly.
  const normalized=x=>{
   const t=clone(x);
   if(t.entity?.updatedAt)t.entity.updatedAt='TIME';
   return t;
  };
  const expected={outcome,entity,trace};
  if(results[i].ok && results[i].value?.outcome?.ok && expected.outcome.ok){
   // Graph contract is JSON identical. Observability is intentionally excluded.
  }
  assert.deepEqual(normalized(results[i].value),normalized(expected),
   `async Graph case ${i}: ${JSON.stringify(q)}`);
 }
});
test('wave3 real isolated Laya CLI: original Node versus Rust owned subprocess contract and errors',async()=>{
 const {LayaCliDecisionEngine}=await import('../../dist/decision.js');
 const request={facts:{reason:'choose',id:31}},
 contract={type:'choice',question:'Which route?',choices:['yes','no']};
 const scripts=[
   "test \"$1\" = '--state-file' && test -s \"$2\" && test \"$3\" = '--questions' && test -s \"$4\" && printf '{\"choice\":\"yes\"}'",
   "test -s \"$2\" && printf '{\"answers\":{\"decision\":{\"choice\":\"no\"}}}'",
   "printf 'bad json'",
   "printf '{\"choice\":\"unknown\"}'",
   "printf 'failed test' >&2; exit 19",
   "printf '{\"choice\":\"yes\"}' >&2; exit 8",
   "sleep 1",
 ];
 for(let i=0;i<scripts.length;i++){
   const q={op:'wave3Graph',action:'laya',script:scripts[i],timeoutMs:i===6?65:2500,request,contract};
   const expected=await (async()=>{
    try{
      const e=new LayaCliDecisionEngine({command:'/bin/sh',args:['-c',q.script,'fixture'],timeoutMs:q.timeoutMs});
      return {ok:true,value:await e.decide(request,contract)};
    }catch(e){return {ok:false,error:e.message}}
   })();
   const actual=rust([q])[0];
   assert.deepEqual(actual,expected,`Laya Node/Rust fixture ${i}`);
 }
});
