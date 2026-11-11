import type { Job, Task } from './types.js';

/** A Coordinator is a durable Task but does not occupy a Worker execution slot.
 * Legacy delegated Shortcut Workers preserve their original foreground semantics. */
function occupiesSlot(job:Job,task:Task):boolean {
  if(task.agentGraph && (task.result?.data?.dag as {version?:number}|undefined)?.version===1)return false;
  const shortcut=task.result?.data?.shortcut;
  const delegatedWorker=job.executionMode==='shortcut' && job.contentOnly===true && task.state==='RUNNING'
    && shortcut && typeof shortcut==='object'
    && Object.keys((shortcut as {workerNodes?:Record<string,string>}).workerNodes??{}).length>0;
  const durableWait=job.executionMode==='shortcut' && job.contentOnly===true && task.state==='RUNNING'
    && task.leaseOwner===null && shortcut && typeof shortcut==='object'
    && Object.keys((shortcut as {waits?:Record<string,unknown>}).waits??{}).length>0;
  return task.state!=='AWAITING_DECISION' && !durableWait && !delegatedWorker &&
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
