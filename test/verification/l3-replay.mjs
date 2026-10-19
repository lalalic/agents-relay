#!/usr/bin/env node
import {DatabaseSync} from 'node:sqlite';
// Deterministic production-ingress replay. External provider and Git effects are disabled.
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createIsolatedEnvironment} from './harness.mjs';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {Reconciler,executionEventSource} from '../../dist/reconciler.js';
import {dispatchTaskAction,TASK_RECOVER_ACTION} from '../../dist/task-actions.js';
import {requestTroubleshooterEscalation,recordEscalationNotificationDelivery,resumeTroubleshooter} from '../../dist/task-recovery.js';
import {tryTransitionTaskEvent,dependencyReady} from '../../dist/scheduler.js';
const stamp='2026-10-17T12:00:00.000Z';
const jobId='l3-replay';
const task=(id,deps=[],initialState)=>{const state=initialState??(deps.length?'DRAFT':'RUNNING');const running=state==='RUNNING';return {jobId,id,kind:'work',agentName:'implementation',adapter:'chatgpt',input:'mock agent',output:{kind:'task_pr'},parentTaskId:null,dependencies:deps,capabilities:[],state,attempt:state==='QUEUED'||deps.length?0:1,maxAttempts:3,leaseOwner:running?'mock':null,leaseExpiresAt:running?'2099-01-01T00:00:00.000Z':null,executionId:running?'exec-a':null,executionHistory:running?[{id:'exec-a',attempt:1,startedAt:stamp}]:[],threadId:null,result:null,error:null,timeoutMs:900000,createdAt:stamp,updatedAt:stamp};};
const fingerprint=value=>JSON.stringify({job:value.state,merge:value.localMerge?.status??null,tasks:value.tasks.map(({id,state,attempt,executionId,result,error,escalation})=>({id,state,attempt,executionId,result:result??null,error:error??null,escalation:escalation?{id:escalation.id,status:escalation.status,notification:escalation.notification?.status??null}:null}))});
export async function runReplay(scenario) {
 if(!scenario || !/^[a-z0-9-]+$/.test(scenario.id??'') || !Array.isArray(scenario.steps) || scenario.steps.length>200) throw Error('invalid scenario');
 const env=createIsolatedEnvironment('relay-l3-replay-');
 let sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);
 let store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 const bus=new MemoryEventBus();
 const observedEvents=[];
 const stopObserving=await bus.subscribeAll(async event=>{observedEvents.push({event:event.type,taskId:event.task_id,source:event.source?.id??null});});
 let mockNow=Date.now();
 let mergeAttempt=0;
 const simulatedGitEffect=scenario.mergeOutcomes ? (_repoPath,receipt)=>{
   const outcome=scenario.mergeOutcomes[mergeAttempt++];
   if(outcome==='failed')throw Error('L3 external Git mock: deterministic merge failure');
   if(outcome!=='succeeded')throw Error('Unexpected or missing external Git mock result');
   return {sourceSha:receipt.sourceSha??scenario.headSha??'mock-head',mergedCommitSha:`mock-merge-${mergeAttempt}`};
 } : undefined;
 const runtimeOptions={owner:'l3-replay',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true,now:new Date(mockNow),...(simulatedGitEffect?{localMergeEffect:simulatedGitEffect,projectPathForJob:()=>env.storeDir}:{}),...(scenario.reviewEnabled?{reviewer:{adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'l3-external-provider-fixture',decidedAt:stamp}}}:{})};
 let runtime=new Reconciler(store,runtimeOptions);
 const trace=[];let stop;
 try {
  const tasks=(scenario.tasks??[{id:'a'},{id:'b',dependencies:['a']}]).map(item=>task(item.id,item.dependencies??[],item.state));
  if(new Set(tasks.map(item=>item.id)).size!==tasks.length || tasks.some(item=>item.dependencies.some(dep=>!tasks.some(other=>other.id===dep)))) throw Error('invalid task dependencies');
  await store.saveJob({id:jobId,title:scenario.id,repository:'local/isolated',prNumber:0,state:'ACTIVE',executionMode:scenario.executionMode??'fixed',autoMerge:scenario.autoMerge===true,reviewEnabled:scenario.reviewEnabled===true,
   ...(scenario.headSha?{headSha:scenario.headSha}:{}),
   ...(scenario.mergeOutcomes?{localMerge:{sourceRef:'refs/heads/mock-source',targetRef:'refs/heads/main',status:'pending',sourceSha:scenario.headSha??'mock-head',attempts:0}}:{}),
   createdAt:stamp,updatedAt:stamp,tasks});
  stop=await runtime.watch(jobId);
  const snapshot=async()=>await sqlite.loadJob(jobId);
  let prior=await snapshot();
  for(let index=0;index<scenario.steps.length;index++) {
   const step=scenario.steps[index];
   const resolveTaskId=async(value)=>{
     if(value==='@review')return (await snapshot()).review?.taskId??'__review_unavailable__';
     if(value==='@fix')return (await snapshot()).tasks.find(t=>t.id.startsWith('review-fix-'))?.id??'__fix_unavailable__';
     return value??'a';
   };
   if(!['task.completed','task.failed','task.started','review.started','review.approved','review.changes_required','job.merge.failed','job.merge.succeeded','job.head.changed','mock.clock.advance','mock.claim','task.recover','task.escalate','mock.notification.delivered','human.unblock','reconcile','restart'].includes(step.type)) throw Error(`unsupported event: ${step.type}`);
   if(step.type==='reconcile') await runtime.reconcile(jobId);
   else if(step.type==='task.recover') {
    const resolvedTaskId=await resolveTaskId(step.taskId);
    const result=await dispatchTaskAction(store,{id:TASK_RECOVER_ACTION,jobId,taskId:resolvedTaskId,recoveryTaskId:step.recoveryTaskId??`troubleshoot-${resolvedTaskId}`,recoveryDiagnosis:{failureKind:'task_failure',reason:step.reason??'L3 controlled recovery',evidence:'canonical event failure',reroute:false,excludeCurrentRoute:false}});
    if(result.task.state!=='QUEUED')throw Error('recover action did not requeue original Task');
   }
   else if(step.type==='task.escalate') {
     const recoveryId=step.recoveryTaskId??`troubleshoot-${step.taskId??'a'}`;
     const outcome=await requestTroubleshooterEscalation(store,jobId,recoveryId,{
       requiredAction:step.requiredAction??'Human must authorize the provider prompt',
       resolutionCondition:step.resolutionCondition??'Provider prompt is approved',
       context:'Canonical worker failure followed by confirmed human-only blocker',
     });
     if(outcome.task.state!=='BLOCKED' || outcome.escalation.notification?.status!=='pending')throw Error('escalation must block recovery and wait for notification');
     await runtime.reconcile(jobId);
   }
   else if(step.type==='mock.notification.delivered') {
     const recoveryId=step.recoveryTaskId??`troubleshoot-${step.taskId??'a'}`;
     if(!observedEvents.some(e=>e.event==='escalation.requested' && e.taskId===recoveryId))throw Error('cannot deliver unrequested escalation');
     const recovery=(await snapshot()).tasks.find(t=>t.id===recoveryId);
     if(!recovery?.escalation?.id)throw Error('notification has no durable escalation ID');
     await recordEscalationNotificationDelivery(store,jobId,recoveryId,recovery.escalation.id,{
       channel:'mock-human-notifier',deliveryId:`mock-delivery-${recovery.escalation.id}`,deliveredAt:new Date().toISOString(),
     });
   }
   else if(step.type==='human.unblock') {
     const recoveryId=step.recoveryTaskId??`troubleshoot-${step.taskId??'a'}`;
     const recovery=(await snapshot()).tasks.find(t=>t.id===recoveryId);
     if(recovery?.escalation?.notification?.status!=='delivered')throw Error('test requires actual notifier receipt before human response');
     const result=await resumeTroubleshooter(store,jobId,recoveryId,step.response??'Provider authorization completed');
     if(result.task.state!=='QUEUED' || result.task.escalation?.status!=='responded')throw Error('authorized human response did not resume Troubleshooter');
   }
   else if(step.type==='mock.claim') {
    // External provider/adapter claim is simulated; legality is decided by the production Graph.
    // Reconciler still processes all terminal events through its real ingress and SQLite.
    const resolvedTaskId=await resolveTaskId(step.taskId);
    await store.mutateJob(jobId,current=>{
      const target=current.tasks.find(item=>item.id===resolvedTaskId);
      if(!target || target.state!=='QUEUED' || !dependencyReady(target,new Map(current.tasks.map(t=>[t.id,t])))) throw Error('mock provider cannot claim non-dispatchable Task');
      const decision=tryTransitionTaskEvent(target,'dispatch',{dispatchable:true});
      if(!decision.accepted || !decision.actions.includes('effect.launchTask'))throw Error('canonical Graph rejected mock dispatch');
      target.attempt+=1;
      target.executionId=step.executionId??`mock-exec-${target.id}-${target.attempt}`;
      target.leaseOwner='l3-mock-provider';target.leaseExpiresAt='2099-01-01T00:00:00.000Z';
      target.executionHistory=[...(target.executionHistory??[]),{id:target.executionId,attempt:target.attempt,startedAt:stamp}];
      return current;
    });
    const claimed=(await snapshot()).tasks.find(item=>item.id===resolvedTaskId);
    if(claimed?.executionId && claimed.leaseOwner && store.reserveWorkflowLaunch)
      await store.reserveWorkflowLaunch({jobId,taskId:resolvedTaskId,executionId:claimed.executionId,attempt:claimed.attempt,leaseOwner:claimed.leaseOwner});
   }
   else if(step.type==='restart') {
    await stop?.(); await runtime.close(); sqlite.close();
    sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),jobId);
    store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
    runtime=new Reconciler(store,runtimeOptions);
    stop=await runtime.watch(jobId);
   }
   else if(step.type==='mock.clock.advance') {
     mockNow += step.millis??60000;
     runtimeOptions.now=new Date(mockNow);
     await runtime.reconcile(jobId);
   }
   else if(step.type==='job.head.changed') {
     await store.mutateJob(jobId,current=>{
       if(!step.headSha)throw Error('head change requires explicit SHA');
       current.headSha=step.headSha;
       current.updatedAt=new Date().toISOString();
       return current;
     });
   }
   else if(step.type.startsWith('job.merge.')) {
    const current=await snapshot();
    current.localMerge=step.type==='job.merge.succeeded'
      ? {status:'succeeded',mergedCommitSha:step.mergedCommitSha??'merge-1',sourceSha:step.sourceSha??'head-1',attempts:step.attempts??1}
      : {status:'failed',error:step.message??'simulated merge failure',attempts:step.attempts??1,nextAttemptAt:step.nextAttemptAt??stamp};
    await sqlite.saveJob(current);
   }
   else {
    const taskId=await resolveTaskId(step.taskId??(step.type.startsWith('review.')?'@review':'a'));
    const source=executionEventSource(jobId,taskId,step.executionId??'exec-a');
    await bus.publish(eventFor(jobId,taskId,null,step.type,step.type==='task.failed'?'failed':'succeeded',step.type,'orchestrator',step.data??{}, {id:source}));
   }
   if(step.type!=='restart') {
     await runtime.idle();
     // EventCoordinator may detach a reconciliation after event acceptance.
     // Wait for the authoritative SQLite state, never a synthetic trace flag.
     const terminalStates={'task.started':'RUNNING','task.completed':'SUCCEEDED','task.failed':'FAILED'};
     const checkedTaskId=await resolveTaskId(step.taskId);
     const currentBefore=prior.tasks.find(t=>t.id===checkedTaskId);
     const staleGeneration=Boolean(step.executionId && currentBefore?.executionId!==step.executionId);
     const eligibleBefore=step.type==='task.started' ? currentBefore?.state==='QUEUED' : currentBefore?.state==='RUNNING' || (step.type==='task.failed' && currentBefore?.state==='QUEUED' && !step.executionId);
     const expectedState=!step.expectIgnored && !staleGeneration && eligibleBefore ? terminalStates[step.type]:undefined;
     if(expectedState){
       const taskId=await resolveTaskId(step.taskId);
       let progressed=false;
       for(let check=0;check<40;check++){
         const observed=await snapshot();
         if(observed.tasks.find(item=>item.id===taskId)?.state===expectedState){progressed=true;break;}
         await runtime.idle();
         await new Promise(resolve=>setTimeout(resolve,5));
       }
       if(!progressed && !step.allowUnverified)throw Error(`Canonical event ${step.type} not observed as ${expectedState} in SQLite for ${taskId}; final=${JSON.stringify((await snapshot()).tasks.find(t=>t.id===taskId))}`);
     }
   }
   const observed=await snapshot();
   trace.push({index,event:step.type,source:step.executionId??'exec-a',before:prior.tasks.map(t=>({id:t.id,state:t.state,executionId:t.executionId})),after:observed.tasks.map(t=>({id:t.id,state:t.state,executionId:t.executionId})),jobState:observed.state,mergeStatus:observed.localMerge?.status??null,escalations:observed.tasks.filter(t=>t.escalation).map(t=>({taskId:t.id,status:t.escalation.status,notificationStatus:t.escalation.notification?.status??null})),progress:fingerprint(prior)!==fingerprint(observed)});
   prior=observed;
  }
  const actual={jobState:prior.state,tasks:Object.fromEntries(prior.tasks.map(t=>[t.id,t.state])),localMerge:prior.localMerge??null};
  const errors=[];
  if(scenario.expected?.jobState && scenario.expected.jobState!==actual.jobState) errors.push(`job expected ${scenario.expected.jobState}, got ${actual.jobState}`);
  for(const [id,state] of Object.entries(scenario.expected?.tasks??{})) if(actual.tasks[id]!==state)errors.push(`${id} expected ${state}, got ${actual.tasks[id]??'missing'}`);
  if(scenario.expected?.localMergeStatus && actual.localMerge?.status!==scenario.expected.localMergeStatus) errors.push(`merge expected ${scenario.expected.localMergeStatus}, got ${actual.localMerge?.status??'none'}`);
  for(const assertion of scenario.assertions??[]){
   const transition=trace[assertion.step];
   if(!transition){errors.push(`missing transition step ${assertion.step}`);continue;}
   if(assertion.taskId){const before=transition.before.find(t=>t.id===assertion.taskId)?.state;const after=transition.after.find(t=>t.id===assertion.taskId)?.state;
    if(assertion.before!==undefined&&assertion.before!==before)errors.push(`step ${assertion.step} ${assertion.taskId} before expected ${assertion.before}, got ${before}`);
    if(assertion.after!==undefined&&assertion.after!==after)errors.push(`step ${assertion.step} ${assertion.taskId} after expected ${assertion.after}, got ${after}`);}
   if(assertion.progress!==undefined&&assertion.progress!==transition.progress)errors.push(`step ${assertion.step} progress mismatch`);
  }
  const seen=new Set();
  for(const item of trace) if(!item.progress && item.event==='reconcile'){const stable=JSON.stringify({after:item.after.map(t=>({id:t.id,state:t.state,executionId:t.executionId})),job:item.jobState,merge:item.mergeStatus});if(seen.has(stable))errors.push('NO_PROGRESS_LOOP');seen.add(stable);}
  const auditDb=new DatabaseSync(join(env.storeDir,'relay.sqlite'),{readOnly:true});
  const actionTraces=(() => {
    try{return auditDb.prepare('SELECT execution_id,generation,action_id,condition_id,outcome,attempt_key FROM workflow_action_trace ORDER BY attempt_key').all();}
    catch{return [];}
    finally{auditDb.close();}
  })();
  return {schemaVersion:2,scenarioId:scenario.id,category:scenario.category??'L3',outcome:errors.length?'FAIL':'PASS',actual,trace,errors,observedEvents,externalGitAttempts:mergeAttempt,actionTraces,authority:'isolated SQLite via production event bus and reconciler'};
 }finally{await stop?.();await stopObserving();await runtime.close();sqlite.close();env.cleanup();}
}
export async function replayFile(path,outputDir){
 const scenario=JSON.parse(readFileSync(path,'utf8'));
 const result=await runReplay(scenario);
 mkdirSync(outputDir,{recursive:true});
 writeFileSync(join(outputDir,'report.json'),JSON.stringify(result,null,2)+'\n');
 writeFileSync(join(outputDir,'report.md'),['# L3 production-ingress replay','',`Scenario: ${result.scenarioId}`,`Result: ${result.outcome}`,`SQLite job state: ${result.actual.jobState}`,'','| Step | Event | Before | After |','| --- | --- | --- | --- |',...result.trace.map(s=>`| ${s.index} | ${s.event} | ${s.before.map(t=>t.id+':'+t.state).join(', ')} | ${s.after.map(t=>t.id+':'+t.state).join(', ')} |`),'',...result.errors.map(e=>'- ERROR: '+e),''].join('\n'));
 return result;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [source,output=resolve('.verification-reports/l3')]=process.argv.slice(2);
 if(!source) throw Error('Usage: node test/verification/l3-replay.mjs scenario.json output-dir');
 const result=await replayFile(resolve(source),resolve(output));
 console.log(JSON.stringify(result,null,2));
 if(result.outcome!=='PASS')process.exitCode=1;
}
