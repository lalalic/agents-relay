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
export async function evaluateRecoveryMatrix(){
 const results=[];
 for(const path of REQUIRED_RECOVERY_PATHS){
  const fixture=verifiedCases[path.id];
  if(!fixture){
   results.push({id:path.id,outcome:'NOT_RUN',reason:'No scenario-specific production Graph/Reconciler/SQLite causal proof for the entire required path'});
   continue;
  }
  try{
   const result=await runReplay(fixture);
   const events=result.trace.map(x=>x.event);
   const verified=result.outcome==='PASS'&&result.actual.jobState==='COMPLETED'&&result.actionTraces.length>0;
   const causal=path.id==='unknown-effect-reconciliation'
     ? events.includes('restart')&&result.trace.find(x=>x.event==='reconcile')?.actionAttempts[0]?.outcome==='Unknown'&&result.trace.find(x=>x.event==='task.started')?.actionAttempts[0]?.outcome==='Verified'
     : events.includes('task.escalate')&&events.includes('restart')&&result.trace.find(x=>x.event==='mock.notification.delivered')?.escalations[0]?.notificationStatus==='delivered'&&result.trace.find(x=>x.event==='human.unblock')?.escalations[0]?.status==='responded'&&events.includes('task.recover');
   results.push({id:path.id,outcome:verified&&causal?'PASS':'FAIL',reason:verified&&causal?null:result.errors.join('; ')||'Missing authoritative causal evidence',authority:result.authority,scenarioId:result.scenarioId,sqliteJobState:result.actual.jobState,traceSteps:result.trace.length,limitations:'External model, notifier and Git effects are isolated mocks'});
  }catch(error){results.push({id:path.id,outcome:'FAIL',reason:String(error)});}
 }
 return results;
}
