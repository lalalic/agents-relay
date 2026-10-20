/** Full-path Job 481 acceptance scenarios. Unwired paths must never report PASS. */
export const REQUIRED_RECOVERY_PATHS = Object.freeze([
 {id:'planner-failure-recovery',requires:['planner.failed','troubleshooter.resolved','planner.succeeded']},
 {id:'worker-failure-recovery',requires:['worker.failed','troubleshooter.resolved','worker.succeeded']},
 {id:'review-changes-required',requires:['review.changes_required','revision.succeeded','review.approved']},
 {id:'reviewer-failure-recovery',requires:['reviewer.failed','troubleshooter.resolved','review.approved']},
 {id:'merge-failure-recovery',requires:['merge.failed','merge.recovered','merge.verified']},
 {id:'sequential-complete-objective',requires:['planner.failed','planner.succeeded','worker.failed','worker.succeeded','review.changes_required','review.approved','merge.failed','merge.verified','objective.verified']},
 {id:'human-escalation-resume',requires:['escalation.requested','notification.delivered','user.confirmed','task.unblocked','troubleshooter.resumed']},
 {id:'unknown-effect-reconciliation',requires:['action.reserved','effect.unknown','postcondition.verified','transition.persisted']},
 {id:'crash-after-persist-before-publish',requires:['transition.persisted','restart','outbox.replayed','event.published']},
 {id:'stale-replay-after-restart',requires:['restart','stale.rejected','duplicate.rejected']},
 {id:'impossible-objective',requires:['objective.false','completion.rejected']},
]);
// Trusted, in-process production replay. No caller evidence or blessing flags.
import {runReplay} from './l3-replay.mjs';
import {terminalPlannerCombinedScenario} from './l3-planner-terminal-combined.mjs';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function verifyProductionOutboxCrash() {
 const checks=[
  {file:'test/workflow-production-outbox.test.js',expected:1},
  {file:'test/verification/outbox-cross-a.test.mjs',expected:3},
 ];
 const evidence=[];
 for(const check of checks){
  const env={...process.env,RELAY_A_DIST:resolve(root,'dist')};
  delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,['--test',check.file],{
   cwd:root,timeout:20000,encoding:'utf8',
   env,
  });
  const output=result.stdout??'';
  const pass=Number(output.match(/(?:^|\n)ℹ pass (\d+)/)?.[1]??-1);
  const skip=Number(output.match(/(?:^|\n)ℹ skipped (\d+)/)?.[1]??-1);
  const ok=result.status===0&&pass===check.expected&&skip===0;
  evidence.push({file:check.file,passed:pass,skipped:skip,exitCode:result.status});
  if(!ok)return {outcome:'FAIL',reason:`Production outbox regression missing/failing: ${check.file}: ${String(result.stderr??'').slice(-500)}`,evidence};
 }
 return {outcome:'PASS',reason:null,authority:'Production Reconciler SQLite Objective completion, durable outbox atomicity and crash/restart tests',evidence,limitations:'External Git/publisher effects are deterministic isolated faults'};
}
const verifiedCases={
 'unknown-effect-reconciliation':{
  id:'gate-unknown-effect',autoMerge:true,tasks:[{id:'a',state:'QUEUED'}],
  steps:[{type:'mock.claim',taskId:'a',executionId:'generation-1'},{type:'restart'},{type:'reconcile'},{type:'task.started',taskId:'a',executionId:'generation-1'},{type:'task.completed',taskId:'a',executionId:'generation-1'},{type:'job.merge.succeeded'},{type:'reconcile'}],
  expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED'},localMergeStatus:'succeeded'}},
 'human-escalation-resume':{
  id:'gate-human-escalation',autoMerge:true,tasks:[{id:'a'}],
  steps:[{type:'task.failed',taskId:'a'},{type:'task.escalate',taskId:'a'},{type:'restart'},{type:'reconcile'},{type:'mock.notification.delivered',taskId:'a'},{type:'human.unblock',taskId:'a',response:'Human approved'},{type:'mock.claim',taskId:'troubleshoot-a',executionId:'recovery-2'},{type:'task.started',taskId:'troubleshoot-a',executionId:'recovery-2'},{type:'task.recover',taskId:'a'},{type:'task.completed',taskId:'troubleshoot-a',executionId:'recovery-2'},{type:'mock.claim',taskId:'a',executionId:'worker-2'},{type:'task.started',taskId:'a',executionId:'worker-2'},{type:'task.completed',taskId:'a',executionId:'worker-2'},{type:'job.merge.succeeded'},{type:'reconcile'}],
  expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED','troubleshoot-a':'SUCCEEDED'},localMergeStatus:'succeeded'}},
};

verifiedCases['planner-failure-recovery']=terminalPlannerCombinedScenario;
verifiedCases['sequential-complete-objective']=terminalPlannerCombinedScenario;
const reviewSteps=[
 {type:'task.completed',taskId:'a'},
 {type:'mock.claim',taskId:'@review',executionId:'review-1'},
 {type:'review.started',taskId:'@review',executionId:'review-1',data:{head_sha:'head-1'}},
 {type:'review.changes_required',taskId:'@review',executionId:'review-1',data:{head_sha:'head-1',blocking_findings:[{message:'missing invariant'}]}},
 {type:'mock.claim',taskId:'@fix',executionId:'fix-1'},
 {type:'task.started',taskId:'@fix',executionId:'fix-1'},
 {type:'task.completed',taskId:'@fix',executionId:'fix-1'},
 {type:'job.head.changed',headSha:'head-2'},
 {type:'reconcile'},
 {type:'review.approved',taskId:'final-review-head-1',executionId:'review-1',data:{head_sha:'head-1'},expectIgnored:true},
 {type:'mock.claim',taskId:'@review',executionId:'review-2'},
 {type:'review.started',taskId:'@review',executionId:'review-2',data:{head_sha:'head-2'}},
 {type:'task.failed',taskId:'@review',executionId:'review-2',data:{reason:'reviewer_transport_failure'}},
 {type:'mock.claim',taskId:'troubleshoot-final-review-head-2',executionId:'troubleshoot-2'},
 {type:'task.started',taskId:'troubleshoot-final-review-head-2',executionId:'troubleshoot-2'},
 {type:'task.recover',taskId:'@review',recoveryTaskId:'troubleshoot-final-review-head-2'},
 {type:'task.completed',taskId:'troubleshoot-final-review-head-2',executionId:'troubleshoot-2'},
 {type:'restart'},
 {type:'mock.claim',taskId:'@review',executionId:'review-3'},
 {type:'review.started',taskId:'@review',executionId:'review-3',data:{head_sha:'head-2'}},
 {type:'review.approved',taskId:'@review',executionId:'review-3',data:{head_sha:'head-2'}},
 {type:'restart'},
 {type:'mock.clock.advance',millis:5000},
 {type:'reconcile'},
];
const reviewFixture={
 id:'gate-review-recovery',autoMerge:true,reviewEnabled:true,headSha:'head-1',
 mergeOutcomes:['failed','succeeded'],tasks:[{id:'a'}],steps:reviewSteps,
 expected:{jobState:'COMPLETED',localMergeStatus:'succeeded',tasks:{a:'SUCCEEDED',
 'final-review-head-1':'SUCCEEDED','review-fix-head-1':'SUCCEEDED',
 'final-review-head-2':'SUCCEEDED','troubleshoot-final-review-head-2':'SUCCEEDED'}},
};
for(const id of ['review-changes-required','reviewer-failure-recovery','merge-failure-recovery']) verifiedCases[id]=reviewFixture;
verifiedCases['worker-failure-recovery']={
 id:'gate-worker-recovery',autoMerge:true,tasks:[{id:'a'}],
 steps:[
  {type:'task.failed',taskId:'a',executionId:'exec-a',data:{reason:'controlled_worker_failure'}},
  {type:'mock.claim',taskId:'troubleshoot-a',executionId:'troubleshoot-a-1'},
  {type:'task.started',taskId:'troubleshoot-a',executionId:'troubleshoot-a-1'},
  {type:'task.recover',taskId:'a',recoveryTaskId:'troubleshoot-a'},
  {type:'task.completed',taskId:'troubleshoot-a',executionId:'troubleshoot-a-1'},
  {type:'restart'},
  {type:'mock.claim',taskId:'a',executionId:'worker-2'},
  {type:'task.started',taskId:'a',executionId:'worker-2'},
  {type:'task.completed',taskId:'a',executionId:'worker-2'},
  {type:'task.completed',taskId:'a',executionId:'exec-a',expectIgnored:true},
  {type:'task.completed',taskId:'a',executionId:'worker-2',expectIgnored:true},
  {type:'job.merge.succeeded'},{type:'reconcile'},
 ],
 expected:{jobState:'COMPLETED',tasks:{a:'SUCCEEDED','troubleshoot-a':'SUCCEEDED'},localMergeStatus:'succeeded'},
};
verifiedCases['stale-replay-after-restart']=verifiedCases['worker-failure-recovery'];
verifiedCases['impossible-objective']={
 id:'gate-impossible-objective',autoMerge:true,tasks:[{id:'a'},{id:'b',dependencies:['a']}],
 steps:[{type:'task.failed',taskId:'a'},{type:'restart'},{type:'job.merge.succeeded',mergedCommitSha:'fabricated'},{type:'reconcile'}],
 expected:{jobState:'ACTIVE',tasks:{a:'FAILED',b:'DRAFT'}},
};
export async function evaluateRecoveryMatrix(){
 const results=[];
 for(const path of REQUIRED_RECOVERY_PATHS){
  if(path.id==='crash-after-persist-before-publish'){
   results.push({id:path.id,...verifyProductionOutboxCrash()});
   continue;
  }
  const fixture=verifiedCases[path.id];
  if(!fixture){
   results.push({id:path.id,outcome:'NOT_RUN',reason:'No scenario-specific production Graph/Reconciler/SQLite causal proof for the entire required path'});
   continue;
  }
  try{
   const result=await runReplay(fixture);
   const events=result.trace.map(x=>x.event);
   const impossible=path.id==='impossible-objective';
   const verified=result.outcome==='PASS'&&(
      impossible ? result.actual.jobState==='ACTIVE' && result.actual.tasks.a==='FAILED'
      : result.actual.jobState==='COMPLETED'&&result.actionTraces.length>0);
   const causal=path.id==='unknown-effect-reconciliation'
     ? events.includes('restart')&&result.trace.find(x=>x.event==='reconcile')?.actionAttempts[0]?.outcome==='Unknown'&&result.trace.find(x=>x.event==='task.started')?.actionAttempts[0]?.outcome==='Verified'
     : path.id==='human-escalation-resume'
     ? events.includes('task.escalate')&&events.includes('restart')&&result.trace.find(x=>x.event==='mock.notification.delivered')?.escalations[0]?.notificationStatus==='delivered'&&result.trace.find(x=>x.event==='human.unblock')?.escalations[0]?.status==='responded'&&events.includes('task.recover')
     : path.id==='planner-failure-recovery' || path.id==='sequential-complete-objective'
     ? result.plannerCalls===2
       && result.actual.plans[0]?.status==='FAILED'
       && result.actual.plans[1]?.status==='SUCCEEDED'
       && result.trace[0].planStatuses[0]?.status==='FAILED'
       && result.trace[4].after.some(t=>t.id==='recover-plan-1'&&t.state==='SUCCEEDED')
       && result.trace[5].planStatuses.some(p=>p.id==='plan-2'&&p.status==='SUCCEEDED')
       && result.observedEvents.some(e=>e.event==='planner.failed')
       && result.observedEvents.some(e=>e.event==='planner.completed')
       && (path.id==='planner-failure-recovery'
           || (events.includes('review.changes_required')
             && events.includes('review.approved')
             && result.trace.filter(t=>t.event==='task.failed').length>=2
             && result.externalGitAttempts===2
             && result.observedEvents.some(e=>e.event==='job.merge.failed')
             && result.observedEvents.some(e=>e.event==='job.merge.succeeded')))
     : path.id==='worker-failure-recovery'
     ? result.trace[0].after.some(t=>t.id==='a'&&t.state==='FAILED')&&result.trace[3].after.some(t=>t.id==='a'&&t.state==='QUEUED')&&result.trace[9].progress===false&&events.includes('restart')
     : path.id==='stale-replay-after-restart'
     ? result.trace[5].event==='restart'&&result.trace[9].progress===false&&result.trace[10].progress===false&&result.trace[9].before.some(t=>t.id==='a'&&t.state==='SUCCEEDED')&&result.trace[10].after.some(t=>t.id==='a'&&t.state==='SUCCEEDED')
     : path.id==='review-changes-required'
     ? result.trace[3].after.some(t=>t.id==='review-fix-head-1'&&t.state==='QUEUED')&&result.trace[9].progress===false&&events.includes('review.approved')
     : path.id==='reviewer-failure-recovery'
     ? result.trace[12].after.some(t=>t.id==='final-review-head-2'&&t.state==='FAILED')&&result.trace[16].after.some(t=>t.id==='troubleshoot-final-review-head-2'&&t.state==='SUCCEEDED')&&events.includes('task.recover')
     : path.id==='merge-failure-recovery'
     ? result.externalGitAttempts===2&&result.observedEvents.filter(x=>x.event.startsWith('job.merge.')).map(x=>x.event).join(',')==='job.merge.failed,job.merge.succeeded'
     : impossible
     ? result.trace.some(x=>x.event==='job.merge.succeeded'&&x.jobState==='ACTIVE')&&events.includes('restart')
     : false;
   results.push({id:path.id,outcome:verified&&causal?'PASS':'FAIL',reason:verified&&causal?null:result.errors.join('; ')||'Missing authoritative causal evidence',authority:result.authority,scenarioId:result.scenarioId,sqliteJobState:result.actual.jobState,traceSteps:result.trace.length,limitations:'External model, notifier and Git effects are isolated mocks'});
  }catch(error){results.push({id:path.id,outcome:'FAIL',reason:String(error)});}
 }
 return results;
}
