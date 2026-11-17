// Adversarial public-export differential: original compiled Node TS vs native Rust.
// Only JSON snapshots and canonical checked-in Mermaid; no live stores or services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as planner from '../../dist/workflow/planner-orchestration-v2.js';
import * as resolution from '../../dist/workflow/task-resolution.js';
const root=resolve(import.meta.dirname,'../..'), directory=resolve(root,'workflow');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let seed=0x4aaf1025;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed%n};
const pick=a=>a[rand(a.length)];
const clone=x=>JSON.parse(JSON.stringify(x));
function rust(requests) {
 const p=spawnSync(binary,{input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',cwd:root,encoding:'utf8',timeout:160000,maxBuffer:24*1024*1024});
 assert.equal(p.status,0,p.stderr||String(p.error));
 const lines=p.stdout.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(lines.length,requests.length);
 return lines;
}
function task(i) {
 return {id:String(i),jobId:'31',createdAt:pick(['2026-11-01T01:00:00.000Z','2026-11-01T01:00:01.000Z']),
   state:pick(['DRAFT','QUEUED','RUNNING','SUCCEEDED','FAILED','BLOCKED','AWAITING_DECISION','CANCELLED']),
   kind:pick(['planner','work','work']), agentName:pick(['planner','developer','troubleshooter']),
   agentGraph:pick([null,null,{nodes:[]}]), planningDecisionId:pick(['p0','p1',null]),
   recoveryPlanId:pick(['p0','p1',null]),
   plannerResult:pick([null,{objective_status:'in_progress'},{objective_status:'satisfied'}]),
   resolution:pick([null,{owner:'troubleshooter',state:'waiting'},{owner:'planner',state:'resolved'}]),
   unblock:pick([null,null,{reason:'recovered',source:'cli',facts:['checked'],baseline:{headSha:'h1'},currentHeadSha:'h2'}])};
}
function plan(i) {
 return {id:`p${i}`,round:pick([0,1,2,3,7]),createdAt:pick(['2026-11-01T00:00:00.000Z','2026-11-02T01:00:00.000Z']),
   status:pick(['FAILED','PLANNING','SUCCEEDED','DRAFT']),objectiveStatus:pick(['satisfied','in_progress','failed']),
   manualPlanning:pick([true,false]),forceRestate:pick([true,false]),
   trigger:{source:pick(['unblock','review','manual','legacy']),taskIds:pick([['1'],['2'],['1','2'],[]]),reviewTaskId:pick(['41','42'])}};
}
function job() {
 const tasks=Array.from({length:1+rand(10)},(_,i)=>task(i+1));
 const plans=Array.from({length:rand(8)},(_,i)=>plan(i));
 const review=pick([null,null,{taskId:'41',outcome:pick(['changes_required','approved','stale']),revisionDisposition:pick([null,'targeted'])}]);
 return {id:'31',state:'ACTIVE',reviewEnabled:pick([false,true]), tasks,plans,review,
   reviewRevisionRounds:pick([[],[{reviewTaskId:'41',status:'changes_required'}]]),
   initialPlanning:pick([null,{status:'pending'},{status:'done'}]),
   changeCycle:pick([null,{taskIds:['1'],reason:'manual',source:'cli',baselineHeadShas:[],currentHeadSha:'h2',consumedByPlannerTaskId:null},
     {taskIds:['2'],reason:'done',consumedByPlannerTaskId:'12'}])};
}
function fixture(q) {return {directory,...q};}
function checked(expected, actual, q, i) {
 assert.deepEqual(actual,expected,`case ${i}: ${JSON.stringify(q)}`);
}
test('public plannerOrchestrationV2 exact GraphRuntime state/guard/action/event export registries',()=>{
 const expected={};
 for(const k of ['states','guards','actions','events'])expected[k]=Array.from(planner.plannerOrchestrationV2.registry[k].keys()).sort();
 checked({ok:true,value:expected},rust([fixture({op:'wave3Graph',action:'plannerRuntime'})])[0],{},0);
});
test('plannerOrchestrationFacts: 500 varied actual Node jobs including unblock/review/recovery side effects',()=>{
 const cases=Array.from({length:500},()=>fixture({op:'wave3Graph',action:'plannerFactsMutable',job:job(),recoverable:pick([true,false])}));
 const actual=rust(cases);
 for(let i=0;i<cases.length;i++){
  const j=clone(cases[i].job),facts=planner.plannerOrchestrationFacts(j,cases[i].recoverable);
  checked({ok:true,value:{facts,plans:j.plans}},actual[i],cases[i],i);
 }
});
test('planner decide and dispatch: 360 canonical Graph branches and rejection edges',async()=>{
 const factsKeys=['legacyPlanningPending','recoverablePendingPlan','terminalPlanFailure','planRecoveryExists','planRecoveryVerified','hasSeedWork',
  'planningRequested','noActivePlanner','resolutionOwnedByTroubleshooter','noBlockedWork','noActiveImplementation','continuationMaterialized','reviewNeedsReplan'];
 const cases=[];
 for(let i=0;i<180;i++){
  const facts=Object.fromEntries(factsKeys.map(k=>[k,pick([true,false,false,'true',1,null])]));
  cases.push(fixture({op:'wave2Graph',action:'plannerDecision',facts}));
  cases.push(fixture({op:'wave2Graph',action:'plannerDispatch',facts}));
 }
 const actual=rust(cases);
 for(let i=0;i<cases.length;i++){
  const q=cases[i];let expected;
  try {const value=q.action==='plannerDecision' ? planner.decidePlannerOrchestration(q.facts) : await planner.dispatchPlannerOrchestration(q.facts,()=>({}));
   expected={ok:true,value};
  }catch(error){expected={ok:false,error:error.message}}
  checked(expected,actual[i],q,i);
 }
});
test('planner asynchronous Graph-selected effects, receipts and callback rejection: 210 Node/Rust cases',async()=>{
 const keys=['legacyPlanningPending','recoverablePendingPlan','terminalPlanFailure','planRecoveryExists','planRecoveryVerified',
  'hasSeedWork','planningRequested','noActivePlanner','resolutionOwnedByTroubleshooter','noBlockedWork',
  'noActiveImplementation','continuationMaterialized','reviewNeedsReplan'];
 const cases=Array.from({length:210},(_,i)=>fixture({op:'wave3Graph',action:'plannerAsyncEffects',
  facts:Object.fromEntries(keys.map(k=>[k,pick([true,false,false])])),
  effectError:pick([null,null,'injected Graph effect rejection']),
  receipt:pick([{}, {recorded:true}, {ok:false,metadata:{index:i}}])}));
 const actual=rust(cases);let actions=0,failures=0;
 for(let i=0;i<cases.length;i++){
  const q=cases[i],trace=[];let outcome;
  try {
   const decision=await planner.dispatchPlannerOrchestration(q.facts,async action=>{
    trace.push(action);if(q.effectError)throw Error(q.effectError);return q.receipt;
   });
   outcome={ok:true,decision};
  }catch(e){outcome={ok:false,error:e.message};failures++}
  actions+=trace.length;
  checked({ok:true,value:{outcome,trace}},actual[i],q,i);
 }
 assert.ok(actions>15,`the test must exercise actual Graph effects (observed ${actions})`);
 assert.ok(failures>10,`the test must exercise rejected async actions (observed ${failures})`);
});
test('Task Resolution Graph sync/async real action dispatch: 350 path/owner/effect error cases',async()=>{
 const cases=[];
 for(let i=0;i<350;i++){
  const t=task(i+1);
  const proposal={path:pick([...resolution.TASK_RESOLUTION_PATHS,'unknown']),
   targetTaskId:pick(['22',t.id]),targetJobId:'64',mode:'merge',rootCause:'confirmed obsolete',solution:'repair',
   recoveryExecutionId:pick(['g1','g2',null])};
  cases.push(fixture({op:'wave4ResolutionEffects',task:t,proposal,
    owner:pick(['planner','troubleshooter','external',null]),async:pick([true,false]),
    effectMissing:pick([true,false,false]),effectError:pick([null,null,'injected callback fault'])}));
 }
 const actual=rust(cases);let executed=0,rejected=0;
 for(let i=0;i<cases.length;i++){
  const q=cases[i],trace=[];const effects={};
  const names=['activateRecovery','activateShortcutWorkerFallback','attachSameJobDependency',
   'registerBlockerDependency','createEscalationGate','cancelSupersede'];
  for(const name of names)if(!q.effectMissing)effects[name]=()=>{
   trace.push('resolution.'+name);
   if(q.effectError)throw Error(q.effectError);
  };
  let outcome;
  try{
   const value=q.async?await resolution.dispatchTaskResolution(q.task,q.proposal,q.owner,effects):
    resolution.dispatchTaskResolutionSync(q.task,q.proposal,q.owner,effects);
   outcome={ok:true,value};
  }catch(error){outcome={ok:false,error:error.message};rejected++}
  executed+=trace.length;
  checked({ok:true,value:{outcome,trace}},actual[i],q,i);
 }
 assert.ok(executed>30,`expected effects, saw ${executed}`);
 assert.ok(rejected>10,`expected rejected actions, saw ${rejected}`);
});
test('task resolution public validate/classify/claim/attach negative and recovery paths',()=>{
 const cases=[];
 for(let i=0;i<160;i++){
  const j=job(),original=j.tasks[0],other=j.tasks[1]??task(99),owner=pick(['planner','troubleshooter',null]);
  const proposal={path:pick([...resolution.TASK_RESOLUTION_PATHS,'unknown']),targetTaskId:pick([original.id,other.id,'missing']),
   targetJobId:pick([null,'55']),mode:pick([null,'merge','verified']),rootCause:pick([null,'blocked']),
   solution:pick([null,'repair']),recoveryExecutionId:pick([null,'r1','r2'])};
  const classification={kind:pick(['superseded','invalid']),targetTaskId:pick(['1','']),evidence:pick(['proof','']),reason:pick(['stale',''])};
  const recovery={id:'r7',executionId:pick(['r1',null])};
  for(const action of ['resolutionValidate','resolutionFacts','resolutionDecision','resolutionMaterialize','resolutionClassification','resolutionClaim','resolutionAttach']) {
   cases.push(fixture({op:'wave2Graph',action,job:j,task:original,child:other,owner,proposal,classification,recovery}));
  }
 }
 const actual=rust(cases);
 for(let i=0;i<cases.length;i++) {
  const q=cases[i],j=clone(q.job),t=j.tasks[0],p=q.proposal;let expected;
  try {
   let value;
   switch(q.action){
    case 'resolutionValidate':resolution.validateResolutionProposal(j,t,p);value=null;break;
    case 'resolutionFacts':value=resolution.resolutionFacts(t,p,q.owner);break;
    case 'resolutionDecision':value=resolution.decideTaskResolution(t,p,q.owner);break;
    case 'resolutionMaterialize':value=resolution.materializeResolution(t,p,q.owner,'2026-11-17T10:00:00.000Z');break;
    case 'resolutionClassification':value={applied:resolution.classifyTaskResolution(t,q.classification,'2026-11-17T10:00:00.000Z'),task:t};break;
    case 'resolutionClaim':resolution.claimExactOriginalRecovery(t,q.recovery);value=t;delete value.resolution?.updatedAt;break;
    case 'resolutionAttach':resolution.attachResolutionOwnership(j,q.child,p,q.owner);value=j;for(const t of value.tasks)if(t.resolution)delete t.resolution.updatedAt;break;
   }
   expected={ok:true,value};
  }catch(e){expected={ok:false,error:e.message}}
  if(q.action==='resolutionClaim'&&actual[i].ok)delete actual[i].value?.resolution?.updatedAt;
  if(q.action==='resolutionAttach'&&actual[i].ok)for(const t of actual[i].value?.tasks??[])if(t.resolution)delete t.resolution.updatedAt;
  checked(expected,actual[i],q,i);
 }
});
