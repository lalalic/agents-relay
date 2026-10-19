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
// Production completion has no trusted adapter until A wires the Reconciler,
// Scheduler, Graph dispatch and SQLite objective predicates. Never accept a
// caller-supplied proof. Retain the inventory with explicit runtime blockers.
export function evaluateRecoveryMatrix() {
 return REQUIRED_RECOVERY_PATHS.map(path=>({id:path.id,outcome:'NOT_RUN',reason:'Production Graph/Reconciler/SQLite objective evidence provider not wired'}));
}
