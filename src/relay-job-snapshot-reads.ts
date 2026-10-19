import type {DatabaseSync} from 'node:sqlite';
import type {Job} from './types.js';
import {normalizeLegacyTaskLifecycle} from './types.js';
import {normalizeLegacyJobPrNumber} from './job-pr-number-migration.js';
function normalize(json:string):Job {const job=normalizeLegacyJobPrNumber(JSON.parse(json) as Job);job.tasks=job.tasks.map(t=>normalizeLegacyTaskLifecycle(t,job.executionMode));return job;}
export function loadRelayJob(db:DatabaseSync,jobId:string):Job|null{
 const row=db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as {json?:string}|undefined;
 return row?.json ? normalize(row.json):null;
}
export function listRelayJobs(db:DatabaseSync,scopeJobId?:string):Job[]{
 const rows=db.prepare(scopeJobId?'SELECT json FROM job_snapshot WHERE job_id=? ORDER BY job_id':'SELECT json FROM job_snapshot ORDER BY job_id').all(...(scopeJobId?[scopeJobId]:[])) as Array<{json:string}>;
 return rows.map(row=>normalize(row.json));
}
