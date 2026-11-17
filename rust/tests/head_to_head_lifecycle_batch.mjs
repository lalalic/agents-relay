// Direct Node/Rust parity: eight Job/Task lifecycle, Review, related Task, entity, Rescue and Escalation source modules.
// Uses canonical local workflow/*.mmd, generated Task/Job fixtures and no user Job/production DB.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve,join} from 'node:path';import {fileURLToPath} from 'node:url';
import * as lifecycle from '../../dist/workflow/lifecycle.js';
import * as review from '../../dist/workflow/review-v2.js';
import * as related from '../../dist/workflow/task-related-action-v2.js';
import * as relatedPolicy from '../../dist/workflow/task-action-policy.js';
import * as reconcile from '../../dist/workflow/job-reconcile-v2.js';
import * as entity from '../../dist/workflow/entity-creation.js';
import * as escalation from '../../dist/workflow/escalation.js';
import * as rescue from '../../dist/workflow/orchestrator-rescue.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),directory=join(root,'workflow'),binary=join(root,'rust/target/debug/relay-rust2-parity');let compiled=false;
function rust(req){if(!compiled){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);compiled=true;}
 const proc=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:15000,maxBuffer:10*1024*1024});assert.equal(proc.status,0,proc.stderr);return JSON.parse(proc.stdout.trim());}
const STAMP='2026-11-17T06:00:00.000Z',DATE='2026-11-16T04:00:00.000Z';
let seed=0x617a5103;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=a=>a[rand(a.length)];
const taskStates=['DRAFT','QUEUED','RUNNING','AWAITING_DECISION','BLOCKED','SUCCEEDED','FAILED','CANCELLED'];
const jobStates=['DRAFT','ACTIVE','COMPLETED','CANCELLED'];
const TASK_EVENTS=['reconcile','queue','cancel','dispatch','task.completed','task.failed','task.started','task.progress','task.unblocked','task.blocked','hold','release','worker.platform_failure','retry','bogus'];
const JOB_EVENTS=['reconcile','activate','local.completed','local.merge.requested','implementation.completed','pr.merged','cancel','bogus'];
const task=i=>({jobId:'j',id:`t${i}`,kind:pick(['work','work','planner']),state:pick(taskStates),agentName:pick(['builder','troubleshooter','planner','']),
 title:pick(['Planner','Coordinator',`Task ${i}`]),input:`# Hello ${i}`,createdAt:DATE,updatedAt:DATE,
 agentGraph:pick([undefined,'flowchart LR\na --> b']),dependencies:[],capabilities:[],adapter:pick(['chatgpt','script','codex','z','orchestrator']),
 leaseOwner:pick([null,'owner']),leaseExpiresAt:pick([null,'2099-01-01T00:00:00.000Z','invalid']),executionId:pick([null,'exec-1']),
 error:pick([null,'failure']),attempt:1,workerSelection:{workerId:'worker'},routing:{provider:'p',model:'m'},
 result:pick([null,{data:{externalCompletionVerified:true}},{data:{externalCompletionVerified:false}}])});
const job=i=>({id:'j',state:pick(jobStates),repository:'relay',objective:'build',createdAt:DATE,updatedAt:DATE,
 tasks:[task(i),task(i+100)],plans:[],reviewEnabled:pick([true,false]),autoMerge:true});
function stripDynamic(value,action){
  if(value===undefined)return null;
  const copy=JSON.parse(JSON.stringify(value));
  if(['taskDispatch','jobDispatch','createTask','createJob'].includes(action)){
   const target=copy.task??copy.job??copy;
   if(target?.updatedAt&&target.updatedAt!==DATE&&target.updatedAt!==STAMP)target.updatedAt='DYNAMIC_TIMESTAMP';
   if(target?.updatedAt===STAMP)target.updatedAt='DYNAMIC_TIMESTAMP';
  }
  return copy;
}
async function node(req){
 try{
 const {action,event,facts,task,job,candidate,outcome,state,actionId,now,request,result,invokeError}=req;let value;
 switch(action){
  case 'reviewState':value=review.reviewGraphState(outcome);break;
  case 'reviewOutcome':value=review.reviewOutcome(state);break;
  case 'reviewDecision':value=review.decideReviewLifecycle(outcome,event,facts);break;
  case 'reviewDispatch':{const effects=[];const decision=await review.dispatchReviewLifecycle(outcome,event,facts,id=>{effects.push(id);return {}});value={result:decision,effects};break;}
  case 'taskDecide':value=lifecycle.decideTaskLifecycle(task,event,facts);break;
  case 'jobDecide':value=lifecycle.decideJobLifecycle(job,event,facts);break;
  case 'taskDispatch':{const copy=structuredClone(task);const decision=lifecycle.dispatchTaskLifecycleSync(copy,event,facts);value={decision,task:copy};break;}
  case 'jobDispatch':{const copy=structuredClone(job);const decision=lifecycle.dispatchJobLifecycleSync(copy,event,facts);value={decision,job:copy};break;}
  case 'jobReconcile':value=reconcile.decideJobReconcile(job,facts);break;
  case 'relatedFacts':value=related.relatedTaskActionFacts(task,candidate);break;
  case 'relatedDecision':value=related.decideRelatedTaskAction(task,candidate,actionId);break;
  case 'relatedMutations':value=relatedPolicy.selectRelatedTaskMutations(job,task,actionId);break;
  case 'createTask':value=entity.createTaskEntity(job,task,{defer:req.defer});break;
  case 'createJob':value=entity.createJobEntity(job,{activate:req.activate});break;
  case 'rescueFacts':value=rescue.orchestratorRescueFacts(task,now);break;
  case 'rescueDecision':value=rescue.decideOrchestratorRescue(task,now);break;
  case 'rescuePrepare':{const copy=structuredClone(task);const next=rescue.prepareOrchestratorRepair(copy,now);value={result:next,task:copy};break;}
  case 'escalationRun':{const effects=[];const escalationResult=await escalation.runEscalationGraph(request,{
   invoke:()=>{effects.push('invoke');if(invokeError)throw Error(invokeError);return result??{status:'resolved',summary:'ok'};},
   resumeRecovery:()=>{effects.push('resumeRecovery');},technicalFailure:()=>{effects.push('technicalFailure');},blockForUser:()=>{effects.push('blockForUser');}});
   value={result:escalationResult,effects};break;}
  default:throw Error(`unknown ${action}`);
 }
 return {ok:true,value:stripDynamic(value,action)};
 }catch(error){return {ok:false,error:error.message}}
}
function comparableRust(result,action){if(!result.ok)return result;return {ok:true,value:stripDynamic(result.value,action)};}
const lifecycleCases=[];
for(let i=0;i<1400;i++){
 const t=task(i),j=job(i),action=pick(['taskDecide','jobDecide','taskDispatch','jobDispatch','jobReconcile']);
 const event=action.startsWith('job')?pick(JOB_EVENTS):pick(TASK_EVENTS);
 const facts=Object.fromEntries(['dependenciesSatisfied','dependenciesUnsatisfied','runnable','dispatchable','shortcutEffectsSafe','recoverableExecution','retryAvailable','reviewDisabled','implementationComplete','headAvailable','localCompletionAllowed','autoMerge','reviewSatisfied','jobActive','deliveryReady'].map(key=>[key,pick([true,false,undefined])]));
 lifecycleCases.push({op:'lifecycleBatchScenario',action,directory,event,task:t,job:j,facts,timestamp:STAMP});
}
test('canonical Job and Task Graph lifecycle decision/mutation/merged review facts preserve Node semantics',async()=>{
 for(const [i,req] of lifecycleCases.entries())assert.deepEqual(comparableRust(rust(req),req.action),await node(req),`lifecycle fixture ${i}: ${JSON.stringify(req).slice(0,540)}`);
 console.log(`Verified ${lifecycleCases.length} Node/Rust Task/Job lifecycle and Job reconciliation scenarios`);
});
const reviewCases=[];
for(let i=0;i<820;i++){
 const action=pick(['reviewState','reviewOutcome','reviewDecision','reviewDispatch']);
 const outcome=pick([undefined,'pending','started','approved','changes_required','blocked','stale']);
 const state=pick(['NONE','PENDING','STARTED','APPROVED','CHANGES_REQUIRED','BLOCKED','STALE','UNKNOWN','pending']);
 const facts=Object.fromEntries(['reviewEnabled','prOpen','jobActive','reviewWorkSettled','headAvailable','reviewPlanReady','noActiveReviewTask','currentReviewCancelled','noApprovedCurrentReview','autoMerge','reviewUnblocked','targetedRevisionRequestsReady','targetedRevisionsVerified','reviewRoundWithinLimit','reviewNoProgressWithinLimit'].map(key=>[key,pick([true,false,undefined])]));
 reviewCases.push({op:'lifecycleBatchScenario',action,directory,outcome,state,event:pick(['reconcile','review.started','review.approved','review.changes_required','review.retry','head.changed','revision.settled','unknown']),facts});
}
test('Review-v2 finite states, authorization and Graph actions match Node, including terminal outcomes',async()=>{
 for(const [i,req] of reviewCases.entries())assert.deepEqual(comparableRust(rust(req),req.action),await node(req),`Review fixture ${i}: ${JSON.stringify(req).slice(0,500)}`);
 console.log(`Verified ${reviewCases.length} Node/Rust Review Graph outcome and action receipt cases`);
});
const relatedCases=[];
for(let i=0;i<760;i++){
 const t=task(i),candidate=task(i+3);candidate.id=pick([t.id,candidate.id]);candidate.parentTaskId=pick([t.id,undefined,'t-missing']);
 const j=job(i);j.tasks=[t,candidate,task(i+12)];
 relatedCases.push({op:'lifecycleBatchScenario',action:pick(['relatedFacts','relatedDecision','relatedMutations']),directory,
  task:t,candidate,job:j,actionId:pick(['task.retry','task.cancel','task.unblock.retry','task.queue','task.hold','unknown'])});
}
test('Task-related effect scope and cancellation selection match Node Task lifecycle Graph',async()=>{
 for(const [i,req] of relatedCases.entries())assert.deepEqual(comparableRust(rust(req),req.action),await node(req),`Related Task fixture ${i}: ${JSON.stringify(req).slice(0,500)}`);
 console.log(`Verified ${relatedCases.length} Node/Rust related Task and mutation scope decisions`);
});
const entityCases=[];
for(let i=0;i<780;i++){
 const t=task(i),j=job(i);
 const action=pick(['createTask','createJob']);
 t.state=undefined;t.title=pick([undefined,'','Custom title',`  Custom ${i}  `]);
 t.adapter=pick(['chatgpt','script','orchestrator']);
 t.workerRequirements=pick([undefined,{capabilities:[]},{capabilities:['code']},{capabilities:'bad'},{}]);
 t.dependencies=pick([[],['a'],['a','b']]);
 t.dependencyValidity=pick([undefined,null,{'a':'order-only'},{'bad':'rerun'},{'a':'invalid'}]);
 j.tasks=[{id:'a',state:pick(['SUCCEEDED','QUEUED'])},{id:'b',state:pick(['SUCCEEDED','FAILED'])}];
 entityCases.push({op:'lifecycleBatchScenario',action,directory,job:j,task:t,defer:pick([true,false]),activate:pick([true,false]),timestamp:STAMP});
}
test('Job and Task construction is validated, stateful and authorized by the canonical lifecycle graphs',async()=>{
 for(const [i,req] of entityCases.entries())assert.deepEqual(comparableRust(rust(req),req.action),await node(req),`entity fixture ${i}: ${JSON.stringify(req).slice(0,570)}`);
 console.log(`Verified ${entityCases.length} Node/Rust Task/Job create and dependency policy cases`);
});
const rescueCases=[];
for(let i=0;i<640;i++){
 const t=task(i);
 t.kind=pick(['work','work','planner']);t.adapter=pick(['orchestrator','orchestrator','script']);t.state=pick(['QUEUED','RUNNING','FAILED','SUCCEEDED']);
 t.leaseExpiresAt=pick([undefined,null,'invalid',DATE,'2099-01-01T00:00:00.000Z']);
 t.result=pick([null,{data:{externalCompletionVerified:true}},{data:{externalCompletionVerified:false}}]);
 t.storySize=pick(['S','M','L',undefined]);t.capabilities=['code'];
 const now=Date.parse('2026-11-17T06:00:00.000Z');
 rescueCases.push({op:'lifecycleBatchScenario',action:pick(['rescueFacts','rescueDecision','rescuePrepare']),directory,task:t,now});
}
test('legacy orchestrator rescue, uncertain started execution and verified completion match Node',async()=>{
 for(const [i,req] of rescueCases.entries())assert.deepEqual(comparableRust(rust(req),req.action),await node(req),`rescue fixture ${i}: ${JSON.stringify(req).slice(0,550)}`);
 console.log(`Verified ${rescueCases.length} Node/Rust legacy orchestrator rescue and restoration cases`);
});
const escalationCases=[];
for(let i=0;i<340;i++){
 const status=pick(['resolved','failed','needs_user','invalid']);
 const req={op:'lifecycleBatchScenario',action:'escalationRun',directory,request:{intent:'resume Task',blockedOn:'test fixture',cwd:'/tmp'},
  result:{status,summary:`Status ${status}`,reason:'native test'},invokeError:rand(17)===0?'fixture invoke failed':undefined};
 escalationCases.push(req);
}
test('escalation Graph invokes exact recovery/human/error callbacks from classified durable response',async()=>{
 for(const [i,req] of escalationCases.entries())assert.deepEqual(comparableRust(rust(req),req.action),await node(req),`escalation fixture ${i}: ${JSON.stringify(req).slice(0,550)}`);
 console.log(`Verified ${escalationCases.length} Node/Rust recovery/escalation action boundary cases`);
});
