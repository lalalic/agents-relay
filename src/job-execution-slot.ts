import type { Job, Task } from './types.js';

/** Coordinator Tasks hold no Worker slot. Actual Agent executions are leased. */
function occupiesSlot(_job:Job,task:Task):boolean {
  if(task.agentGraph && (task.result?.data?.dag as {version?:number}|undefined)?.version===1)return false;
  return task.state!=='AWAITING_DECISION' &&
    (task.state==='RUNNING' || (task.executionId!==null && !['SUCCEEDED','FAILED','CANCELLED'].includes(task.state)));
}
function plannerOccupies(job:Job,planId?:string):boolean {
  return (job.plans??[]).some(plan=>plan.id!==planId && plan.executionId!==null && plan.status==='PLANNING');
}
export function jobHasActiveExecution(job:Job,except:{taskId?:string;planId?:string}={}):boolean {
  return job.tasks.some(task=>task.id!==except.taskId && occupiesSlot(job,task)) || plannerOccupies(job,except.planId);
}
/** Only sibling DAG Tasks may execute concurrently; unrelated Tasks retain
 * the existing one-active-execution-per-Job safety boundary. */
export function jobHasConflictingExecution(job:Job,candidate:Task):boolean {
  if(!candidate.dagNode)return jobHasActiveExecution(job,{taskId:candidate.id});
  return plannerOccupies(job) || job.tasks.some(task=>task.id!==candidate.id && occupiesSlot(job,task) &&
    task.dagNode?.parentTaskId!==candidate.dagNode?.parentTaskId);
}
