import type { DatabaseSync } from 'node:sqlite';
import type { Job } from './types.js';
import { normalizeLegacyTaskLifecycle } from './types.js';

/** Move pre-contract ordinary BLOCKED snapshots to FAILED without touching the
 * independent append-only event history. Unknown execution evidence is kept. */
export function migrateLegacyBlockedTasks(db: DatabaseSync): void {
  const rows = db.prepare('SELECT job_id,json FROM job_snapshot').all() as Array<{job_id:string;json:string}>;
  const update = db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?');
  for (const row of rows) {
    const job = JSON.parse(row.json) as Job;
    const before = JSON.stringify(job.tasks);
    job.tasks = job.tasks.map(task => normalizeLegacyTaskLifecycle(task, job.executionMode));
    if (JSON.stringify(job.tasks) !== before) update.run(JSON.stringify(job), row.job_id);
  }
}
