import type {DatabaseSync} from 'node:sqlite';
import type {Job} from './types.js';
import {normalizeLegacyTaskLifecycle} from './types.js';
import {normalizeLegacyJobPrNumber} from './job-pr-number-migration.js';
export function normalizeRelayJob(json:string):Job {
 const job=normalizeLegacyJobPrNumber(JSON.parse(json) as Job);
 job.tasks=job.tasks.map(t=>normalizeLegacyTaskLifecycle(t,job.executionMode));
 job.plans=(job.plans??[]).map(plan=>{
  const legacy=plan as typeof plan & {forceCleanHistory?:boolean;cleanHistoryTaskIds?:string[]};
  if(plan.forceRestate===undefined&&legacy.forceCleanHistory===true)plan.forceRestate=true;
  if(plan.restateTaskIds===undefined&&legacy.cleanHistoryTaskIds)plan.restateTaskIds=[...legacy.cleanHistoryTaskIds];
  delete legacy.forceCleanHistory;delete legacy.cleanHistoryTaskIds;return plan;
 });
 return job;
}
export function loadRelayJob(db:DatabaseSync,jobId:string):Job|null{
 const row=db.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get(jobId) as {json?:string}|undefined;
 return row?.json ? normalizeRelayJob(row.json):null;
}
export function listRelayJobs(db:DatabaseSync,scopeJobId?:string):Job[]{
 const rows=db.prepare(scopeJobId?'SELECT json FROM job_snapshot WHERE job_id=? ORDER BY job_id':'SELECT json FROM job_snapshot ORDER BY job_id').all(...(scopeJobId?[scopeJobId]:[])) as Array<{json:string}>;
 return rows.map(row=>normalizeRelayJob(row.json));
}
