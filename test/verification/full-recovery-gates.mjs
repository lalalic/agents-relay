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
export function recoveryEvidenceGate(path, proof) {
 // No external JSON or synthetic trace can prove production authority.
 // Reconciler instrumentation must issue an internal, non-serializable marker
 // after reading SQLite objective predicates and correlated graph effects.
 if(!proof || !verifiedProofs.has(proof))return {id:path.id,outcome:'NOT_RUN',reason:'No trusted production Reconciler/SQLite proof'};
 const missing=path.requires.filter(event=>!proof.events.includes(event));
 if(missing.length)return {id:path.id,outcome:'FAIL',reason:'Missing causal steps: '+missing.join(', ')};
 const expected=path.id==='impossible-objective'?'ACTIVE':'COMPLETED';
 if(path.id==='impossible-objective' && proof.sqliteState==='BLOCKED')return {id:path.id,outcome:'PASS'};
 return {id:path.id,outcome:proof.sqliteState===expected?'PASS':'FAIL',reason:proof.sqliteState===expected?null:'Authoritative SQLite objective mismatch'};
}
const verifiedProofs=new WeakSet();
/** Reserved for trusted runner integration; not exposed to fixtures/CLI. */
export function evaluateRecoveryMatrix(){return REQUIRED_RECOVERY_PATHS.map(path=>recoveryEvidenceGate(path));}
