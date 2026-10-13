import { DatabaseSync } from 'node:sqlite';
import type { Job } from './types.js';
import { normalizeLegacyJobPrNumber } from './job-pr-number-migration.js';

export function createJobIfAbsent(db: DatabaseSync, job: Job): Job {
  db.exec('BEGIN IMMEDIATE');
  try {
    const row = db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(job.id) as { json?: string } | undefined;
    if (row?.json) { db.exec('COMMIT'); return normalizeLegacyJobPrNumber(JSON.parse(row.json) as Job); }
    db.prepare('INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)').run(job.id, JSON.stringify(job), new Date().toISOString());
    db.exec('COMMIT');
    return structuredClone(job);
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
