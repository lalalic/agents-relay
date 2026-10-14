import type { DatabaseSync } from 'node:sqlite';
import type { Job } from './types.js';

/** Enforce immutable Job-to-repository identity; PR number may bind once from 0. */
export function ensureUnifiedJobRegistry(db: DatabaseSync, job: Job, expectedJobId: string): void {
  if (job.id !== expectedJobId) throw new Error(`Wrong scoped Job ID ${job.id}; expected ${expectedJobId}`);
  db.prepare('INSERT INTO source_registry(job_id,source_file,repository,pr_number) VALUES(?,?,?,?) ON CONFLICT(job_id) DO NOTHING')
    .run(job.id, `unified:${job.id}`, job.repository, job.prNumber);
  const binding = db.prepare('SELECT repository,pr_number FROM source_registry WHERE job_id=?')
    .get(job.id) as {repository:string;pr_number:number}|undefined;
  if (binding?.repository !== job.repository || !Number.isInteger(binding.pr_number)) throw new Error(`Job ${job.id} has conflicting repository identity`);
  if (binding.pr_number > 0 && job.prNumber !== binding.pr_number) throw new Error(`Job ${job.id} cannot change an established PR binding`);
  if (binding.pr_number === 0 && job.prNumber > 0)
    db.prepare('UPDATE source_registry SET pr_number=? WHERE job_id=? AND pr_number=0').run(job.prNumber,job.id);
}

/** Preserve atomic create-if-absent across all Job scopes in the single SQLite. */
export function createUnifiedJobIfAbsent(db: DatabaseSync, job: Job, writeSnapshot: (now: string) => void): Job {
  db.exec('BEGIN IMMEDIATE');
  try {
    const existing = db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(job.id) as {json?:string}|undefined;
    if (existing?.json) { db.exec('COMMIT'); return JSON.parse(existing.json) as Job; }
    writeSnapshot(new Date().toISOString());
    db.exec('COMMIT');
    return structuredClone(job);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
