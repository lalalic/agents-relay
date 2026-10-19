/** Read-only SQLite-backed workflow postconditions; never trust CLI-supplied facts. */
import type { DatabaseSync } from 'node:sqlite';
import type { ConditionOutcome } from './conditions.js';
import { completionGateSatisfied } from '../scheduler.js';
import type { Job } from '../types.js';

export type AuthoritativePredicate = 'task.queued' | 'task.succeeded' | 'task.failed' | 'task.routing-cleared' | 'task.execution-stopped' | 'job.objective-verified' | 'job.completed';
export function verifyAuthoritativeCondition(db: DatabaseSync, jobId: string, predicate: AuthoritativePredicate, taskId?: string, executionId?: string): ConditionOutcome {
  if (!jobId) throw new Error('job ID required');
  const row = db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as {json?:string}|undefined;
  if (!row?.json) return 'Unknown';
  const job = JSON.parse(row.json) as Job;
  if (predicate === 'job.objective-verified') return completionGateSatisfied(job) ? 'Verified' : 'Failed';
  if (predicate === 'job.completed') return job.state === 'COMPLETED' && completionGateSatisfied(job) ? 'Verified' : 'Failed';
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) return 'Unknown';
  switch(predicate) {
    case 'task.queued': return task.state === 'QUEUED' ? 'Verified' : 'Failed';
    case 'task.succeeded': return task.state === 'SUCCEEDED' ? 'Verified' : 'Failed';
    case 'task.failed': return task.state === 'FAILED' ? 'Verified' : 'Failed';
    case 'task.routing-cleared': return task.executionId === null && !task.leaseOwner ? 'Verified' : 'Failed';
    case 'task.execution-stopped': {
      if (!executionId) return 'Unknown';
      if (task.executionId === executionId) return 'Failed';
      const history = task.executionHistory?.find(entry => entry.id === executionId);
      if (!history) return 'Unknown';
      // A changed execution identity cannot alone prove process termination.
      // Require authoritative ended process evidence, not just a lease replacement.
      const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='execution_process'").get();
      if (!table) return 'Unknown';
      const record = db.prepare('SELECT ended_at FROM execution_process WHERE job_id=? AND task_id=? AND execution_id=?').get(jobId,task.id,executionId) as {ended_at?:string|null}|undefined;
      return record?.ended_at ? 'Verified' : 'Unknown';
    }
  }
}
