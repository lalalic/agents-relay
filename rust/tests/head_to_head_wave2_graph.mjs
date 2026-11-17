// Wave 2 Graph: randomized, direct compiled Node public exports versus native Rust.
// Isolated SQLite :memory:, no Relay store, no live services.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import * as tr from '../../dist/task-transitions.js';
import * as rec from '../../dist/workflow/task-reconcile.js';
import * as res from '../../dist/workflow/task-resolution.js';
import * as planner from '../../dist/workflow/planner-orchestration-v2.js';
import {revisionRequestReady} from '../../dist/review-revision-execution.js';
import {verifyAuthoritativeCondition} from '../../dist/workflow/authoritative-conditions.js';
const root=resolve(import.meta.dirname,'../..');
const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const directory=resolve(root,'workflow');
let seed=0x5f2912da;
function rand(n){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n}
function pick(a){return a[rand(a.length)]}
const clone=x=>x===undefined?undefined:JSON.parse(JSON.stringify(x));
function task(id,state='FAILED',more={}){
  return {id,jobId:'123',kind:'implementation',agentName:'developer',title:'Implement',
    state,dependencies:[],executionId:null,leaseOwner:null,leaseExpiresAt:null,
    updatedAt:'2026-11-17T09:00:00.000Z',attempt:0,maxAttempts:3,...more};
}
function job(tasks,more={}){return {id:'123',state:'ACTIVE',repository:'work',projectRoot:'/tmp/work',tasks,plans:[],...more}}
const all=[];
function add(action,fields={}){all.push({op:'wave2Graph',action,directory,...fields})}
for(let i=0;i<300;i++){
 const t=[task('1',pick(['SUCCEEDED','FAILED','DRAFT','QUEUED','RUNNING'])),
    task('2',pick(['SUCCEEDED','FAILED','DRAFT','BLOCKED']),{dependencies:pick([[],['1'],['3'],['1','3']])}),
    task('3',pick(['SUCCEEDED','DRAFT','RUNNING']),{dependencies:pick([[],['1'],['2'],['4']])})];
 add('dependencyReady',{task:t[1],tasks:t});
 add('detectCycles',{tasks:t});
 const revisions=pick([null,{kind:'targeted',reviewTaskId:'4',requestIds:['r1'],basedOnHeadSha:'head'}]);
 t[2].revision=revisions;
 const j=job(t,{review:{outcome:pick(['changes_required','approved']),revisionDisposition:'targeted',taskId:'4'},
   reviewRevisionRequests:[{requestId:'r1',revisionTaskId:'3',status:pick(['queued','stale']),reviewHeadSha:'head'}]});
 add('revisionRequestReady',{job:j,task:t[2]});
 add('completionGateSatisfied',{job:job(t,{plans:pick([[],[{id:'p',round:1,status:'SUCCEEDED',objectiveStatus:pick(['satisfied','in_progress'])}]]),reviewEnabled:pick([true,false])})});
 add('extendRetryBudget',{attempt:pick([0,1,2,3,5,11,15]),maxAttempts:pick([0,1,3,6,10,15]),windowSize:pick([1,2,3,4,5,0,-1,2.5])});
 const proposal={path:pick([...res.TASK_RESOLUTION_PATHS,'other']),
   targetTaskId:pick(['1','2','3','']), targetJobId:pick(['','3']),mode:pick(['','merge']),
   rootCause:pick(['','obsolete']),solution:pick(['','fix']),recoveryExecutionId:pick(['','ex2'])};
 const owner=pick([null,'planner','troubleshooter']);
 add('resolutionValidate',{job:j,task:t[0],proposal});
 add('resolutionFacts',{task:t[0],proposal,owner});
 add('resolutionDecision',{task:t[0],proposal,owner});
 add('resolutionMaterialize',{proposal,owner});
 const classification={kind:pick(['superseded','invalid','other']),
   targetTaskId:pick(['1','']),evidence:pick(['logs','']),reason:pick(['expired',''])};
 add('resolutionClassification',{task:t[0],classification});
 add('resolutionClaim',{task:t[0],recovery:task('r','RUNNING',{executionId:pick(['e1',null])})});
 // Explicitly exercise real graph-selected same-Job effect, including denials.
 add('resolutionAttach',{job:j,child:task('10'),proposal:{path:pick(['same_job_dependency','cancel_supersede']),targetTaskId:pick(['1','2','missing'])},owner});
}
for(let i=0;i<220;i++){
 const plans=pick([[],[{id:'p1',round:1,status:pick(['FAILED','SUCCEEDED','PLANNING']),
  objectiveStatus:pick(['in_progress','satisfied']),trigger:{source:pick(['unblock','manual','review']),taskIds:['1']},
  manualPlanning:pick([true,false]),forceRestate:pick([true,false]),createdAt:'2026-11-17T00:00:00.000Z'}]]);
 const t=[task('1',pick(['SUCCEEDED','DRAFT','BLOCKED','RUNNING']),{kind:pick(['planner','implementation']),
  agentName:pick(['troubleshooter','developer','planner']),agentGraph:pick([null,{nodes:[]}]),
  unblock:pick([null,{reason:'fix'}]),planningDecisionId:pick(['p1',null]),
  resolution:pick([null,{owner:'troubleshooter',state:pick(['active','waiting','resolved'])}])})];
 const j=job(t,{plans,initialPlanning:pick([null,{status:'pending'},{status:'complete'}]),
  reviewEnabled:pick([true,false]),review:pick([null,{taskId:'rev',outcome:'changes_required',revisionDisposition:'replan'}]),
  changeCycle:pick([null,{taskIds:['1'],reason:'fix'}])});
 const recoverable=pick([true,false]);
 add('plannerFacts',{job:j,recoverable});
 const facts=Object.fromEntries(['legacyPlanningPending','recoverablePendingPlan','terminalPlanFailure',
 'planRecoveryExists','planRecoveryVerified','hasSeedWork','planningRequested','noActivePlanner',
 'resolutionOwnedByTroubleshooter','noBlockedWork','noActiveImplementation','continuationMaterialized',
 'reviewNeedsReplan'].map(k=>[k,pick([true,false,0,null])]));
 add('plannerDecision',{facts});add('plannerDispatch',{facts});
}
for(let i=0;i<170;i++){
 const t=[task('1',pick(['DRAFT','QUEUED','BLOCKED','FAILED','SUCCEEDED']),
    {dependencies:pick([[],['2'],['missing']]),unblock:pick([null,{reason:'fix'}])}),
    task('2',pick(['SUCCEEDED','DRAFT','FAILED']),{dependencies:pick([[],['1']])})];
 const j=job(t,{pause:pick([null,{at:'now'}])});
 add('reconcileTaskDependencies',{job:j});add('refreshTaskDependencies',{job:j});
}
for(let i=0;i<210;i++){
 const t=task('1',pick(['DRAFT','QUEUED','RUNNING','FAILED','SUCCEEDED','BLOCKED','CANCELLED']),
   {error:pick([null,'failed','timeout']),failureReason:pick([null,'unknown']),
    agentName:pick(['troubleshooter','developer']),executionId:pick([null,'e-1']),leaseOwner:pick([null,'worker'])});
 const facts={runnable:pick([true,false]),dependenciesSatisfied:pick([true,false]),
   dependenciesUnsatisfied:pick([true,false]),dispatchable:pick([true,false]),
   recoverableExecution:pick([true,false]),troubleshooterRecovery:pick([true,false]),
   retryAvailable:pick([true,false])};
 const event=pick(['reconcile','release','queue','block','hold','cancel','fail',
   'task.started','task.completed','review.approved','retry','task.unknown']);
 add('transitionTaskTry',{task:t,event,facts});add('transitionTask',{task:t,event,facts});
 const j=job([t],{state:pick(['DRAFT','ACTIVE','COMPLETED','CANCELLED'])});
 add('transitionJob',{job:j,event:pick(['activate','cancel','reconcile','local.completed','review.approved','task.unknown']),
   facts:{jobActive:pick([true,false]),autoMergeEnabled:pick([true,false]),
    localCompletionAllowed:pick([true,false]),localMergeReady:pick([true,false]),
    implementationComplete:pick([true,false])}});
}
for(let i=0;i<180;i++){
 const ts=[task('1',pick(['RUNNING','QUEUED','SUCCEEDED','FAILED']),{executionId:pick([null,'e-new']),leaseOwner:pick([null,'pool']),
   executionHistory:pick([[],[{id:'e-old',attempt:1}]])})];
 const j=job(ts,{state:pick(['DRAFT','ACTIVE','COMPLETED']),
   plans:pick([[],[{id:'plan',round:1,status:'SUCCEEDED',objectiveStatus:'satisfied'}]])});
 add('authoritative',{job:j,jobId:'123',predicate:pick(['task.queued','task.failed','task.succeeded','task.routing-cleared',
 'task.execution-stopped','job.objective-verified','job.completed']),taskId:pick(['1','missing']),executionId:pick(['e-old','e-new','']),
   createProcessTable:pick([true,false]),processes:pick([[],[{jobId:'123',taskId:'1',executionId:'e-old',endedAt:'2026-11-17T09:00:00Z'}]])});
}
async function node(req){
 const {action}=req;const t=clone(req.task),j=clone(req.job),p=req.proposal;
 try{
  let value;
  switch(action){
   case 'dependencyReady':value=rec.dependencyReady(t,new Map(req.tasks.map(t=>[t.id,t])));break;
   case 'detectCycles':rec.detectCycles(req.tasks);value=null;break;
   case 'revisionRequestReady':value=revisionRequestReady(j,t);break;
   case 'plannerFacts':value=planner.plannerOrchestrationFacts(j,req.recoverable);break;
   case 'plannerDecision':value=planner.decidePlannerOrchestration(req.facts);break;
   case 'plannerDispatch':value=await planner.dispatchPlannerOrchestration(req.facts,()=>({}));break;
   case 'reconcileTaskDependencies':rec.reconcileTaskDependencies(j);value=j.tasks.map(t=>t.state);break;
   case 'refreshTaskDependencies':tr.refreshTaskDependencies(j);value=j.tasks.map(t=>t.state);break;
   case 'transitionTaskTry':{
     const decision=tr.tryTransitionTaskEvent(t,req.event,req.facts);value={decision,task:t};break;
   }
   case 'transitionTask':{
     const decision=await tr.transitionTaskEvent(t,req.event,req.facts);value={decision,task:t};break;
   }
   case 'transitionJob':{
     const decision=await tr.transitionJobEvent(j,req.event,req.facts);value={decision,job:j};break;
   }
   case 'completionGateSatisfied':value=tr.completionGateSatisfied(j);break;
   case 'extendRetryBudget':value=tr.extendRetryBudget({attempt:req.attempt,maxAttempts:req.maxAttempts},req.windowSize);break;
   case 'resolutionValidate':res.validateResolutionProposal(j,t,p);value=null;break;
   case 'resolutionFacts':value=res.resolutionFacts(t,p,req.owner);break;
   case 'resolutionDecision':value=res.decideTaskResolution(t,p,req.owner);break;
   case 'resolutionMaterialize':value=res.materializeResolution(t,p,req.owner,'2026-11-17T10:00:00.000Z');break;
   case 'resolutionClassification':{
     const applied=res.classifyTaskResolution(t,req.classification,'2026-11-17T10:00:00.000Z');value={applied,task:t};break}
   case 'resolutionClaim':res.claimExactOriginalRecovery(t,req.recovery);value=t;
     // claim's materialize defaults to current time; compare stable source fields only.
     delete value.resolution.updatedAt;break;
   case 'resolutionAttach':{
     res.attachResolutionOwnership(j,req.child,p,req.owner);value=j;
     if(value.tasks)for(const item of value.tasks){if(item.resolution)delete item.resolution.updatedAt}
     break}
   case 'authoritative':{
     const db=new DatabaseSync(':memory:');
     try{db.exec('CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT)');
       if(req.job)db.prepare('INSERT INTO job_snapshot VALUES(?,?)').run(req.jobId,JSON.stringify(req.job));
       if(req.createProcessTable){db.exec('CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,ended_at TEXT)');
          const insert=db.prepare('INSERT INTO execution_process VALUES(?,?,?,?)');
          for(const r of req.processes??[])insert.run(r.jobId,r.taskId,r.executionId,r.endedAt);
       }
       value=verifyAuthoritativeCondition(db,req.jobId,req.predicate,req.taskId,req.executionId);
     }finally{db.close()}
     break
   }
   default:throw new Error('bad fixture action '+action);
  }
  return {ok:true,value:clone(value)};
 }catch(error){return {ok:false,error:error.message}}
}
function rust(requests){
 const child=spawnSync(bin,[],{cwd:root,input:requests.map(r=>JSON.stringify(r)).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:32*1024*1024});
 assert.equal(child.status,0,child.stderr||String(child.error));
 const lines=child.stdout.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(lines.length,requests.length);
 return lines;
}
test('Node/Rust Wave2 Graph randomized positive, negative, SQLite and recovery parity',async()=>{
 const got=rust(all);
 let good=0;
 for(let i=0;i<all.length;i++){
  const req=all[i],expected=await node(req),actual=got[i];
  if(req.action==='resolutionClaim' && actual.ok)delete actual.value?.resolution?.updatedAt;
  if(req.action==='resolutionAttach' && actual.ok)
    for(const t of actual.value?.tasks??[]){if(t.resolution)delete t.resolution.updatedAt}
  if(['transitionTaskTry','transitionTask','transitionJob'].includes(req.action)){
    const strip=x=>{
      if(!x?.ok)return;
      for(const kind of ['task','job']){const item=x.value?.[kind];if(item)delete item.updatedAt;}
    };strip(actual);strip(expected);
  }
  assert.deepEqual(actual,expected,'fixture '+i+': '+JSON.stringify(req).slice(0,420));
  good++;
 }
 console.log('Wave2 Graph: '+good+' randomized source-vs-Rust equivalences');
});
