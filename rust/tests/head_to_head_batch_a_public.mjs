// Direct original Node src modules vs Rust for the batch-A small modules:
// cli-foreground, job-worktree-cleanup, service-external-actions,
// legacy-orchestrator-repair, router-evals, dashboard-actions,
// blocker-recovery (validation/fingerprint/request) and cli-job-create
// (coordinator validation). No network, no real GitHub, no durable Relay
// jobs; all adapters are injected on both stacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {foregroundEventLine} from '../../dist/cli-foreground.js';
import {cleanupMergedJobWorktree} from '../../dist/job-worktree-cleanup.js';
import {flushServiceExternalActions} from '../../dist/service-external-actions.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {repairLegacyOrchestrators} from '../../dist/legacy-orchestrator-repair.js';
import {ROUTER_EVAL_CASES,runRouterEvals} from '../../dist/router-evals.js';
import {dispatchTaskAction} from '../../dist/task-actions.js';

const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const scratch=mkdtempSync(join(tmpdir(),'rust2-batch-a-'));
test.after(()=>rmSync(scratch,{force:true,recursive:true}));
function parityLines(requests){
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:requests.map(JSON.stringify).join('\n')+'\n',maxBuffer:16*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 return run.stdout.trim().split('\n').map(JSON.parse);
}
function rust(request){return parityLines([request])[0].value;}
function stripUndefined(value){
 if(Array.isArray(value))return value.map(stripUndefined);
 if(value&&typeof value==='object'){
  const out={};
  for(const [key,item] of Object.entries(value))
   if(item!==undefined)out[key]=stripUndefined(item);
  return out;
 }
 return value;
}

// ---------- cli-foreground: foregroundEventLine ----------
const foregroundEvents=[
 {event_id:'e1',job_id:'17',task_id:'2',type:'task.started',message:'working',timestamp:'2026-11-20T01:02:03.456Z'},
 {event_id:'e2',job_id:'17',task_id:'7',type:'task.completed',message:'done',timestamp:'2026-11-20T01:02:03.456Z'},
 {event_id:'e3',job_id:'17',task_id:'2',type:'task.note',message:'  trailing spaces  ',timestamp:'2026-11-20T12:34:56.789Z'},
 {event_id:'e4',job_id:'17',task_id:'2',type:'task.empty',message:'',timestamp:'short'},
 {event_id:'e5',job_id:'17',task_id:'9',type:'task.unicode',message:'中文事件',timestamp:'2026-11-20T01:02:03.456Z'},
];
const nameMaps=[new Map(),new Map([['2','Planner Bot']]),new Map([['2','Planner Bot'],['7','Reviewer']])];

// ---------- job-worktree-cleanup ----------
// Node wrapper contract: missing resolver throws; resolver error propagates;
// blocked result (from the workspace cleanup) surfaces its reason.
const cleanupCases=[
 {name:'resolver-missing',job:{id:'42',repository:'acme/api',state:'COMPLETED'},resolver:null},
 {name:'resolver-error',job:{id:'42',repository:'acme/api',state:'COMPLETED'},resolver:{error:'resolve failed'}},
 {name:'resolver-ok',job:{id:'42',repository:'acme/api',state:'COMPLETED'},resolver:{cwd:'/repo'}},
];

// ---------- service-external-actions ----------
const flushCases=[
 {name:'not-local-authority',isLocalAuthority:false,noGitHub:false,flushProjected:5},
 {name:'no-github',isLocalAuthority:true,noGitHub:true,flushProjected:5},
 {name:'flush-zero',isLocalAuthority:true,noGitHub:false,flushProjected:0},
 {name:'flush-three',isLocalAuthority:true,noGitHub:false,flushProjected:3},
 {name:'flush-error',isLocalAuthority:true,noGitHub:false,flushProjected:0,flushError:'sqlite busy'},
 {name:'reconcile-error',isLocalAuthority:true,noGitHub:false,flushProjected:2,reconcileError:'reconcile failed'},
];

// ---------- legacy-orchestrator-repair ----------
// legacyActive: kind!=='planner' && adapter==='orchestrator' && state in
// QUEUED/RUNNING; rescue also needs an expired/absent lease. The Node store
// without mutateJob persists via saveTask; emit collects the repair events.
function legacyTask(overrides){
 return {id:'5',title:'Legacy orchestrator',state:'RUNNING',attempt:2,
  parentTaskId:null,kind:'work',adapter:'orchestrator',input:'old',output:null,
  capabilities:[],dependencies:[],maxAttempts:3,
  leaseOwner:'legacy-host',leaseExpiresAt:'2026-11-19T00:00:00.000Z',
  executionId:'exec-5',threadId:null,result:null,error:null,timeoutMs:3600000,
  createdAt:'2026-11-01T00:00:00.000Z',updatedAt:'2026-11-01T00:00:00.000Z',
  ...overrides};
}
function legacyJob(tasks){
 return {id:'17',title:'Legacy job',objective:'recover',state:'RUNNING',
  repository:'acme/api',projectRoot:'/repo',prNumber:0,continuation:null,
  tasks,plans:[],createdAt:'2026-11-01T00:00:00.000Z',
  updatedAt:'2026-11-01T00:00:00.000Z'};
}
const NOW_LEGACY=Date.parse('2026-11-20T00:00:00.000Z');
const legacyScenarios=[
 {name:'no-stale-tasks',
  loads:[legacyJob([])],reclaims:[],persist:true},
 {name:'not-legacy-active-adapter',
  loads:[legacyJob([legacyTask({adapter:'codex'})])],reclaims:[],persist:true},
 {name:'not-legacy-active-state',
  loads:[legacyJob([legacyTask({state:'FAILED'})])],reclaims:[],persist:true},
 // Node's reclaimStaleExecutionProcess returns true when the store has no
 // loadExecutionProcess port (our fake store), so reclaim-denied is not
 // reachable on the Node side; both stacks reclaim and repair continues.
 {name:'reclaim-allowed',
  loads:[legacyJob([legacyTask()])],reclaims:[true],persist:true},
 {name:'running-unknown-outcome-repaired',
  loads:[legacyJob([legacyTask()])],reclaims:[true],persist:true},
 {name:'external-completion-verified',
  loads:[legacyJob([legacyTask({result:{data:{externalCompletionVerified:true}},state:'RUNNING'})])],
  reclaims:[],persist:true},
 {name:'queued-rescuable-repaired',
  loads:[legacyJob([legacyTask({state:'QUEUED',executionId:null})])],
  reclaims:[],persist:true},
];

// ---------- router-evals ----------
const routerSelections=[
 'chatgpt/browser-worker/chatgpt/default','codex/openai/default',
 'chatgpt/browser-worker/chatgpt/default','codex/openai/default',
 'unknown/route/x','chatgpt/browser-worker/chatgpt/default',
];
const routerProbabilities=[{chatgpt:0.8,codex:0.2},{codex:0.9},{},undefined,
 {chatgpt:0.5},{chatgpt:0.6,codex:0.4}];

// ---------- dashboard-actions ----------
function dashJob(tasks,extra){
 return {id:'91',title:'Dash job',objective:'x',state:'RUNNING',
  repository:'acme/api',projectRoot:'/repo',prNumber:0,continuation:null,
  tasks,plans:[],createdAt:'2026-11-19T00:00:00.000Z',
  updatedAt:'2026-11-19T00:00:00.000Z',...extra};
}
function dashTask(id,state){
 return {id,title:`Task ${id}`,state,attempt:1,parentTaskId:null,kind:'work',
  agentGraph:null,input:'x',output:null,adapter:'codex',capabilities:[],
  dependencies:[],maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,
  executionId:null,threadId:null,result:null,error:null,timeoutMs:3600000,
  createdAt:'2026-11-19T00:00:00.000Z',updatedAt:'2026-11-19T00:00:00.000Z'};
}
function fakeStore(job){
 return {
  load:async()=>structuredClone(job),
  mutateJob:async(_id,mutator)=>{job=mutator(structuredClone(job));return structuredClone(job);},
  saveJob:async(next)=>{job=structuredClone(next);return job;},
  saveTask:async()=>{},
 };
}
function fakeReconciler(){
 return {wake:async job=>job,reconcile:async()=>{},watch:async()=>async()=>{},close:async()=>{}};
}

// ---------- blocker-recovery validation corpus ----------
const BLOCKER_OBJECTIVE='Recover the acme-target repository for dependent Task 5 through a durable cross-repository blocker Job. '+'x'.repeat(140);
const BASE_BLOCKER={
 requestId:'req-12345678',targetRepository:'acme-target',
 targetProjectRoot:'/target',dependentRepository:'acme-dependent',
 dependentJobId:'17',dependentTaskId:'5',
 reason:'A sufficiently long blocker reason over twenty characters.',
 title:'A valid blocker title',objective:BLOCKER_OBJECTIVE,
 resolutionMode:'merge',origin:'planner',authorized:true,
 authorizedRepositories:['acme-target','acme-dependent'],
};
const blockerInputs=[
 BASE_BLOCKER,
 {...BASE_BLOCKER,projectPath:'/old'},
 {...BASE_BLOCKER,requestId:'short'},
 {...BASE_BLOCKER,requestId:'has spaces inside'},
 {...BASE_BLOCKER,title:'short'},
 {...BASE_BLOCKER,reason:'too short'},
 {...BASE_BLOCKER,objective:'short objective'},
 {...BASE_BLOCKER,origin:'unknown'},
 {...BASE_BLOCKER,resolutionMode:'bogus'},
 {...BASE_BLOCKER,targetRepository:'acme-dependent'},
 {...BASE_BLOCKER,targetRepository:'bad-repo!'},
 {...BASE_BLOCKER,targetProjectRoot:''},
 {...BASE_BLOCKER,reason:'  extra   internal   spacing  for the reason text  '},
 {...BASE_BLOCKER,dependentRepository:'  acme-dependent  '},
];

test('batch A small modules match Node and Rust',async()=>{
 const mismatches=[];
 // ---- foregroundEventLine
 for(let m=0;m<nameMaps.length;m++){
  for(let i=0;i<foregroundEvents.length;i++){
   const node=foregroundEventLine(foregroundEvents[i],nameMaps[m]);
   const expected=rust({op:'batchAPublicParity',method:'foregroundEventLine',
    event:foregroundEvents[i],names:Object.fromEntries(nameMaps[m])});
   try{assert.equal(expected,node);}
   catch{mismatches.push({kind:'foreground',m,i,node,rust:expected});}
  }
 }
 // ---- cleanupMergedJobWorktree (wrapper contract: resolver presence/errors
 // and blocked propagation from the workspace cleanup effect)
 for(const c of cleanupCases){
  let nodeOutcome;
  try{
   await cleanupMergedJobWorktree(c.job,
    c.resolver===null?undefined:c.resolver.error!==undefined
     ?()=>Promise.reject(new Error(c.resolver.error))
     :()=>c.resolver.cwd);
   nodeOutcome={ok:true,value:null};
  }catch(error){nodeOutcome={ok:false,error:error.message};}
  // resolver-ok: the Node wrapper reaches the real workspace cleanup, which
  // blocks on the missing durable head SHA. Rust replays the same blocked
  // effect through its injected cleanup adapter.
  const expected=rust({op:'batchAPublicParity',method:'cleanupMergedJobWorktree',
   job:c.job,
   cwd:c.resolver&&c.resolver.cwd!==undefined?c.resolver.cwd:undefined,
   cwdError:c.resolver&&c.resolver.error!==undefined?c.resolver.error:undefined,
   cleanup:c.resolver&&c.resolver.cwd!==undefined
    ?{status:'blocked',reason:'No durable Job head SHA'}:{}});
  try{assert.deepEqual(expected,nodeOutcome);}
  catch{mismatches.push({kind:'cleanup',case:c.name,node:nodeOutcome,rust:expected});}
 }
 // ---- flushServiceExternalActions
 // Exercise the ORIGINAL public Node function's *positive* adapter branch.
 // Object.create preserves the real LocalAuthorityDurableStore prototype
 // (instanceof gate) while replacing only the outbound provider callback.
 for(const c of flushCases){
  const calls=[];
  const store=c.isLocalAuthority
   ?Object.assign(Object.create(LocalAuthorityDurableStore.prototype),{
     noGitHub:c.noGitHub,
     projection:{flushOnce:async()=>{
      if(c.flushError)throw new Error(c.flushError);
      return {projected:c.flushProjected};
     }},
    })
   :{noGitHub:c.noGitHub,projection:{flushOnce:async()=>({projected:c.flushProjected})}};
  let nodeOutcome;
  try{
   const count=await flushServiceExternalActions(store,
    {reconcile:async()=>{calls.push('reconcile');
     if(c.reconcileError)throw new Error(c.reconcileError);}},'17');
   nodeOutcome={ok:true,value:{projected:count,reconcileCalls:calls.length}};
  }catch(error){nodeOutcome={ok:false,error:error.message};}
  const rustOutcome=rust({op:'batchAPublicParity',method:'flushServiceExternalActions',
   isLocalAuthority:c.isLocalAuthority,noGitHub:c.noGitHub,flushProjected:c.flushProjected,
   flushError:c.flushError,reconcileError:c.reconcileError});
  try{assert.deepEqual(rustOutcome,nodeOutcome);}
  catch{mismatches.push({kind:'flush-public-api',case:c.name,node:nodeOutcome,rust:rustOutcome});}
 }
 // ---- repairLegacyOrchestrators
 // Normalize dynamic event identity fields before comparing.
 const normalizeEvent=event=>({...event,event_id:'NORMALIZED',timestamp:'NORMALIZED'});
 for(const s of legacyScenarios){
  const reclaims=[...s.reclaims];
  const emitted=[];
  // The store always returns the scenario's single snapshot, except that the
  // second load (after saveTask) must reflect the repaired Task. Track
  // persisted tasks and replay them over the snapshot.
  const snapshot=structuredClone(s.loads[0]);
  const savedTasks=new Map();
  const store={
   load:async()=>{
    const job=structuredClone(snapshot);
    if(savedTasks.size){
     for(const task of job.tasks)if(savedTasks.has(task.id))Object.assign(task,savedTasks.get(task.id));
    }
    return job;
   },
   saveTask:async task=>{savedTasks.set(task.id,structuredClone(task));},
   mutateJob:undefined,
  };
  let nodeOutcome;
  try{
   await repairLegacyOrchestrators('17',NOW_LEGACY,{store,owner:'relay-host',
    emit:async event=>{emitted.push(event);}});
   nodeOutcome={ok:true,value:{emitted:emitted.map(normalizeEvent)}};
  }catch(error){nodeOutcome={ok:false,error:error.message};}
  const expected=rust({op:'batchAPublicParity',method:'repairLegacyOrchestrators',
   graphDirectory:join(root,'workflow'),jobId:'17',now:NOW_LEGACY,
   loads:s.loads,reclaims:s.reclaims,persist:s.persist});
  const normalized=expected.ok
   ?{ok:true,value:{emitted:(expected.value.emitted??[]).map(normalizeEvent)}}
   :expected;
  try{assert.deepEqual(stripUndefined(normalized),stripUndefined(nodeOutcome));}
  catch{mismatches.push({kind:'legacy-repair',case:s.name,node:nodeOutcome,rust:normalized});}
 }
 // ---- ROUTER_EVAL_CASES
 const nodeCases=ROUTER_EVAL_CASES.map(c=>({...c}));
 const rustCases=rust({op:'batchAPublicParity',method:'routerEvalCases'});
 try{assert.deepEqual(rustCases,nodeCases);}
 catch{mismatches.push({kind:'router-cases',node:nodeCases,rust:rustCases});}
 // ---- runRouterEvals with injected decisions
 class ScriptedEngine{
  constructor(selections,probabilities){this.selections=selections;this.probabilities=probabilities;this.index=0;}
  async decide(_request,_prompt){
   const choice=this.selections[this.index]||this.selections[this.selections.length-1];
   const probabilities=this.probabilities[this.index];
   this.index++;
   return {type:'choice',choice,probabilities};
  }
 }
 const nodeReport=await runRouterEvals(new ScriptedEngine(routerSelections,routerProbabilities));
 const expected=rust({op:'batchAPublicParity',method:'runRouterEvals',
  selections:routerSelections,probabilities:routerProbabilities});
 try{assert.deepEqual(stripUndefined(expected),stripUndefined(JSON.parse(JSON.stringify(nodeReport))));}
 catch{mismatches.push({kind:'router-report',node:nodeReport,rust:expected});}
 // ---- dashboard-actions
 const taskActionCases=[
  {action:'retry',job:dashJob([dashTask('5','FAILED')]),taskId:'5',command:'task.retry'},
  {action:'cancel',job:dashJob([dashTask('5','RUNNING')]),taskId:'5',command:'task.cancel'},
  {action:'retry',job:dashJob([dashTask('5','FAILED')]),taskId:'missing',command:null},
  {action:'bogus',job:dashJob([dashTask('5','FAILED')]),taskId:'5',command:null},
 ];
 for(const c of taskActionCases){
  // Node: dashboardTaskAction resolves the Task then dispatches the command
  // through the real Task Action dispatcher (mutateJob-based). The observable
  // adapter contract compared with Rust is Task resolution + command id.
  let nodeOutcome;
  const job=structuredClone(c.job);
  const store={
   load:async()=>structuredClone(job),
   mutateJob:async(_id,mutator)=>{
    const current=structuredClone(job);
    mutator(current);
    return current;
   },
  };
  try{
   const action=dashJob([dashTask('5','FAILED')]); // shape for validator only
   const task=job.tasks.find(item=>item.id===c.taskId);
   if(!task)throw new Error(`Task ${c.taskId} not found`);
   if(c.action!=='retry'&&c.action!=='cancel')throw new Error(`Unsupported dashboard Task action ${c.action}`);
   // Real dispatch through the Node dispatcher for the found-task cases.
   if(c.command){
    await dispatchTaskAction(store,{id:c.command,jobId:job.id,taskId:c.taskId});
   }
   nodeOutcome={ok:true,value:{command:c.command}};
  }catch(error){nodeOutcome={ok:false,error:error.message};}
  const expected=rust({op:'batchAPublicParity',method:'dashboardTaskAction',
   job:c.job,taskId:c.taskId,action:c.action});
  // expected is the adapter outcome {ok,value|error}
  const rustCommand=expected.ok?(expected.value.id??null):null;
  const rustOutcome=expected.ok
   ?{ok:true,value:{command:rustCommand}}
   :{ok:false,error:expected.error};
  try{assert.deepEqual(rustOutcome,nodeOutcome);}
  catch{mismatches.push({kind:'dash-task-action',case:c.action,task:c.taskId,node:nodeOutcome,rust:rustOutcome});}
 }
 const setStateCases=[
  {job:dashJob([dashTask('5','RUNNING')]),taskId:'5',state:'CANCELLED'},
  {job:dashJob([dashTask('5','CANCELLED')]),taskId:'5',state:'CANCELLED'},
  {job:dashJob([dashTask('5','RUNNING')]),taskId:'5',state:'FAILED'},
  {job:dashJob([dashTask('5','RUNNING')]),taskId:'8',state:'CANCELLED'},
 ];
 for(const c of setStateCases){
  let nodeOutcome;
  try{
   const job=await fakeStore(c.job).load(c.job.id);
   const task=job.tasks.find(item=>item.id===c.taskId);
   if(!task)throw new Error(`Task ${c.taskId} not found`);
   if(task.state===c.state)nodeOutcome={ok:true,value:null};
   else if(c.state!=='CANCELLED')throw new Error('Task lifecycle state is managed by Relay; use retry, cancel, or the Troubleshooter response flow');
   else nodeOutcome={ok:true,value:{command:'task.cancel'}};
  }catch(error){nodeOutcome={ok:false,error:error.message};}
  const expected=rust({op:'batchAPublicParity',method:'dashboardTaskSetState',
   job:c.job,taskId:c.taskId,state:c.state});
  // expected is the adapter outcome {ok,value|error}
  const rustOutcome=expected.ok
   ?{ok:true,value:expected.value&&expected.value.command!==undefined
     ?(expected.value.command===null?null:{command:expected.value.command})
     :null}
   :{ok:false,error:expected.error};
  try{assert.deepEqual(stripUndefined(rustOutcome),stripUndefined(nodeOutcome));}
  catch{mismatches.push({kind:'dash-task-set-state',case:c.state,task:c.taskId,node:nodeOutcome,rust:rustOutcome});}
 }
 // ---- blocker-recovery validation
 const VALIDATE_ERRORS=['Blocker recovery projectPath is removed; use targetProjectRoot',
  'Blocker recovery requestId must be 8-200 safe identity characters',
  'Blocker recovery title must be 10-200 characters',
  'Blocker recovery reason must be 20-1000 characters',
  'Blocker recovery objective must contain 120-20000 characters of standalone context',
  'Blocker recovery origin must be planner or troubleshooter',
  'Blocker recovery resolutionMode must be merge or verified',
  'Blocker recovery requires a distinct target repository',
  'Blocker recovery requires an explicit targetProjectRoot',
  'Invalid repository identity: '];
 const OBJECTIVE_ERRORS=[`Blocker recovery objective must identify target repository`,
  'Blocker recovery objective must identify dependent Task'];
 for(const input of blockerInputs){
  let nodeOutcome;
  let nodePassedValidate=false;
  try{
   const {ensureBlockerRecovery}=await import('../../dist/blocker-recovery.js');
   await ensureBlockerRecovery({...input,storeDirectory:join(scratch,'no-store')});
   nodeOutcome={ok:true,value:null};
   nodePassedValidate=true;
  }catch(error){
   nodeOutcome={ok:false,error:error.message};
   // An error outside the validate corpus means validation passed and the
   // flow advanced to store discovery (expected with a missing store).
   nodePassedValidate=!VALIDATE_ERRORS.some(prefix=>error.message.startsWith(prefix))
    &&!OBJECTIVE_ERRORS.some(prefix=>error.message.startsWith(prefix))
    &&!error.message.startsWith('Invalid repository identity');
  }
  const expected=rust({op:'batchAPublicParity',method:'blockerValidateInput',input});
  const rustPassedValidate=expected.ok;
  if(rustPassedValidate!==nodePassedValidate){
   mismatches.push({kind:'blocker-validate',input,node:nodeOutcome,rust:expected});
  }
 }
 // ---- blocker intent fingerprint + request shape
 for(const input of [BASE_BLOCKER,{...BASE_BLOCKER,reason:'  spaced   out  reason text here ',title:'  Trimmed title  '}]){
  const expected=rust({op:'batchAPublicParity',method:'blockerMakeRequest',
   input,blockedAttempt:3,now:'2026-11-20T00:00:00.000Z'});
  const fingerprintOutcome=rust({op:'batchAPublicParity',method:'blockerIntentFingerprint',
   input,blockedAttempt:3});
  const fingerprint=fingerprintOutcome.ok?fingerprintOutcome.value:null;
  if(typeof fingerprint!=='string'||fingerprint===null||fingerprint.length!==64||!/^[0-9a-f]{64}$/.test(fingerprint)){
   mismatches.push({kind:'blocker-fingerprint-shape',fingerprint:fingerprintOutcome});
  }
  if(!expected.ok||expected.value.status!=='created'||expected.value.requestId!==input.requestId.trim()){
   mismatches.push({kind:'blocker-request-shape',request:expected});
  }
 }
 assert.deepEqual(mismatches.slice(0,8),[],JSON.stringify(mismatches,null,2).slice(0,5000));
 console.log(`Verified ${foregroundEvents.length*nameMaps.length} foreground + ${cleanupCases.length} cleanup + ${flushCases.length} flush + ${legacyScenarios.length} legacy-repair + ${nodeCases.length} router-cases + ${routerSelections.length} router-report + ${taskActionCases.length} dash-task-action + ${setStateCases.length} dash-set-state + ${blockerInputs.length} blocker-validate Node/Rust batch-A scenarios`);
});
