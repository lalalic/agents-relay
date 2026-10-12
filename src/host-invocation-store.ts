/** Durable host-side interactive decision ledger, independent of preview providers. */
import type { DatabaseSync } from 'node:sqlite';
import type { Job } from './types.js';
import type { InteractiveDecisionDelivery, InteractiveDecisionOutcome, InteractiveInvocation } from './interactive-invocation.js';

export const hostInvocationTablesSql = `
  CREATE TABLE IF NOT EXISTS host_invocation_event (
    job_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted','duplicate','stale','ignored')),
    fingerprint TEXT NOT NULL,
    received_at TEXT NOT NULL,
    PRIMARY KEY(job_id,task_id,event_id)
  );
  CREATE TABLE IF NOT EXISTS host_invocation_decision (
    job_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    execution_id TEXT NOT NULL,
    revision TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
    feedback TEXT,
    fingerprint TEXT NOT NULL,
    event_id TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY(job_id,task_id,invocation_id),
    UNIQUE(job_id,task_id,event_id)
  );
`;

export type HostInvocationReceipt = {
  outcome: InteractiveDecisionOutcome;
  reason: string;
  invocation?: InteractiveInvocation;
};

export function recordHostInvocationEvent(
  db: DatabaseSync, delivery: InteractiveDecisionDelivery,
  outcome: InteractiveDecisionOutcome, fingerprint: string,
): void {
  db.prepare(`INSERT OR IGNORE INTO host_invocation_event
    (job_id,task_id,event_id,invocation_id,execution_id,revision,decision,outcome,fingerprint,received_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
    delivery.jobId, delivery.taskId, delivery.eventId, delivery.invocationId,
    delivery.executionId, delivery.revision, delivery.decision, outcome,
    fingerprint, delivery.deliveredAt,
  );
}

export function hasHostInvocationDecision(
  db: DatabaseSync, jobId: string, taskId: string, invocationId: string, fingerprint?: string,
): boolean {
  return db.prepare('SELECT 1 FROM host_invocation_decision WHERE job_id=? AND task_id=? AND invocation_id=? AND (? IS NULL OR fingerprint=?)')
    .get(jobId, taskId, invocationId, fingerprint ?? null, fingerprint ?? null) !== undefined;
}

export function recordHostInvocationDecision(
  db: DatabaseSync, delivery: InteractiveDecisionDelivery, fingerprint: string,
  writeSnapshot: (job: Job, at: string) => void,
): HostInvocationReceipt {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT fingerprint FROM host_invocation_decision WHERE job_id=? AND task_id=? AND invocation_id=?')
      .get(delivery.jobId, delivery.taskId, delivery.invocationId) as { fingerprint: string } | undefined;
    if (existing) {
      const outcome = existing.fingerprint === fingerprint ? 'duplicate' : 'stale';
      recordHostInvocationEvent(db, delivery, outcome, fingerprint);
      db.exec('COMMIT');
      return { outcome, reason: outcome === 'duplicate' ? 'invocation_already_decided' : 'conflicting_invocation_decision' };
    }
    const snapshot = db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(delivery.jobId) as { json?: string } | undefined;
    const job = snapshot?.json ? JSON.parse(snapshot.json) as Job : null;
    const task = job?.tasks.find(item => item.id === delivery.taskId);
    const invocation = task?.interactiveInvocation;
    if (!job || !task || !invocation || !(['RUNNING','BLOCKED'].includes(task.state)) || invocation.executionId !== delivery.executionId ||
        (task.executionId !== delivery.executionId && task.state !== 'BLOCKED') ||
        invocation.status !== 'awaiting_decision' || invocation.invocationId !== delivery.invocationId || invocation.revision !== delivery.revision) {
      recordHostInvocationEvent(db, delivery, 'stale', fingerprint);
      db.exec('COMMIT');
      return { outcome: 'stale', reason: 'invocation_or_revision_mismatch' };
    }
    db.prepare(`INSERT INTO host_invocation_decision
      (job_id,task_id,invocation_id,execution_id,revision,decision,feedback,fingerprint,event_id,decided_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      delivery.jobId, delivery.taskId, delivery.invocationId, delivery.executionId,
      delivery.revision, delivery.decision, delivery.feedback ?? null, fingerprint,
      delivery.eventId, delivery.deliveredAt,
    );
    recordHostInvocationEvent(db, delivery, 'accepted', fingerprint);
    const decidedInvocation: InteractiveInvocation = {
      invocationId: delivery.invocationId, revision: delivery.revision, executionId: delivery.executionId,
      status: delivery.decision === 'approved' ? 'approved' : 'changes_requested',
      boundAt: invocation.boundAt, decidedAt: delivery.deliveredAt, feedback: delivery.feedback,
    };
    task.interactiveInvocation = decidedInvocation;
    const candidate = Date.parse(delivery.deliveredAt);
    const previous = Date.parse(job.updatedAt);
    job.updatedAt = Number.isFinite(candidate) && candidate > previous
      ? delivery.deliveredAt : new Date(previous + 1).toISOString();
    writeSnapshot(job, delivery.deliveredAt);
    db.exec('COMMIT');
    return { outcome: 'accepted', reason: 'latest_interactive_decision', invocation: decidedInvocation };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}
