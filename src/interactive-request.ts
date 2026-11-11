/** Relay-owned admission/ready/failure for host-owned interactive review requests. */
import type {DurableStore} from './store.js';
import type {Job,Task} from './types.js';
import {tryTransitionTaskEvent} from './task-transitions.js';
import {applyTaskUnblockRetrySnapshot} from './task-actions.js';
import {appendTaskComment} from './task-comments.js';
import {eventFor} from './events.js';

/** Host-neutral lifecycle event; the caller owns its preview/media/notification provider. */
export function interactiveWaitingEvent(jobId:string,taskId:string,parentTaskId:string|null,executionId:string){
  return eventFor(jobId,taskId,parentTaskId,'task.interactive_waiting','waiting',
    'Interactive review requested','orchestrator',{},
    {id:`job/${jobId}/task/${taskId}/execution/${executionId}`,component:'interactive-review'});
}

export function interactiveTemplate(jobId:string,taskId:string,executionId:string){
  return {type:'task.interactive_decision',source:`job/${jobId}/task/${taskId}/execution/${executionId}`,
    data:{interactive:{jobId,taskId,executionId}}};
}
export async function beginInteractiveReview(store:DurableStore,jobId:string,taskId:string,executionId:string){
  if(!store.mutateJob)throw new Error('Interactive review requires atomic durable Job mutation');
  // An execution owns at most one review. No separate review identity.
  const invocationId=executionId;
  let reused=false;
  await store.mutateJob(jobId,(job:Job)=>{
    const task=job.tasks.find((item:Task)=>item.id===taskId);
    if(job.state!=='ACTIVE'||!task||task.state!=='RUNNING'||task.executionId!==executionId)
      throw new Error('Interactive review requires current ACTIVE/RUNNING Task execution');
    const existing=task.interactiveInvocation;
    if(existing?.status==='awaiting_decision'&&existing.executionId===executionId){
      reused=true; // Wrapper rejects a second compile for this pending request.
    }else if(!existing || (existing.executionId!==executionId&&
      (existing.status==='changes_requested'||existing.status==='awaiting_decision'||existing.status==='approved'))){
      // A new authoritative execution can open the next Stage Preview after
      // a prior approval, requested revision, or stale undelivered preview.
      // The current execution guard prevents replacing an in-flight decision;
      // historical decisions remain in the ledger and Task comments.
      task.interactiveInvocation={invocationId,executionId,revision:executionId,
        status:'awaiting_decision',boundAt:new Date().toISOString()};
      task.updatedAt=new Date().toISOString();
    }else{
      throw new Error('Conflicting interactive invocation on Task');
    }
    return job;
  });
  return {jobId,taskId,executionId,reused,
    eventTemplate:interactiveTemplate(jobId,taskId,executionId)};
}
export async function abortInteractiveReview(store:DurableStore,jobId:string,taskId:string,executionId:string){
  if(!store.mutateJob)throw new Error('Interactive review requires durable mutation');
  await store.mutateJob(jobId,job=>{
    const task=job.tasks.find(t=>t.id===taskId);
    if(task?.state==='RUNNING'&&task.executionId===executionId&&
       task.interactiveInvocation?.executionId===executionId&&
       task.interactiveInvocation.status==='awaiting_decision'){
      task.interactiveInvocation=undefined;task.updatedAt=new Date().toISOString();
    }
    return job;
  });
}
export async function failInteractiveReview(store:DurableStore,jobId:string,taskId:string,
  executionId:string,reason:string){
  if(!store.mutateJob)throw new Error('Interactive review requires durable mutation');
  let requeued=false;
  await store.mutateJob(jobId,job=>{
    const task=job.tasks.find(t=>t.id===taskId);
    const inv=task?.interactiveInvocation;
    if(!task||!inv||inv.executionId!==executionId||inv.executionId!==executionId||
       inv.status!=='awaiting_decision')return job;
    if(task.state==='AWAITING_DECISION'){
      if(!tryTransitionTaskEvent(task,'interactive.resume').accepted)
        throw new Error('Graph rejected review delivery failure recovery');
      applyTaskUnblockRetrySnapshot(task);
      task.interactiveInvocation=undefined;
      task.error=null;task.failureReason=undefined;
      appendTaskComment(job,taskId,`Interactive review delivery failed; rerun review request: ${reason.slice(0,500)}`);
      task.updatedAt=new Date().toISOString();
      requeued=true;
    }else if(task.state==='RUNNING'&&task.executionId===executionId){
      task.interactiveInvocation=undefined;
    }
    return job;
  });
  return {requeued};
}
