/** Relay-owned admission/ready/failure for Neo-hosted interactive review requests. */
import {randomUUID} from 'node:crypto';
import type {DurableStore} from './store.js';
import type {Job,Task} from './types.js';
import {tryTransitionTaskEvent} from './task-transitions.js';
import {applyTaskUnblockRetrySnapshot} from './task-actions.js';
import {appendTaskComment} from './task-comments.js';

export function interactiveTemplate(jobId:string,taskId:string,executionId:string,invocationId:string){
  return {type:'task.interactive_decision',source:`job/${jobId}/task/${taskId}/execution/${executionId}`,
    data:{interactive:{jobId,taskId,executionId,invocationId}}};
}
export async function beginInteractiveReview(store:DurableStore,jobId:string,taskId:string,executionId:string){
  if(!store.mutateJob)throw new Error('Interactive review requires atomic durable Job mutation');
  const proposedId=randomUUID();
  let invocationId='';
  let reused=false;
  await store.mutateJob(jobId,(job:Job)=>{
    const task=job.tasks.find((item:Task)=>item.id===taskId);
    if(job.state!=='ACTIVE'||!task||task.state!=='RUNNING'||task.executionId!==executionId)
      throw new Error('Interactive review requires current ACTIVE/RUNNING Task execution');
    const existing=task.interactiveInvocation;
    if(existing?.status==='awaiting_decision'&&existing.executionId===executionId){
      invocationId=existing.invocationId;
      reused=true; // Wrapper rejects a second compile for this pending request.
    }else if(!existing || (existing.executionId!==executionId&&
      (existing.status==='changes_requested'||existing.status==='awaiting_decision'))){
      // A new authoritative RUNNING execution replaces a stale undelivered
      // invocation left behind by a crashed prior wrapper/worker. The old
      // execution cannot still be current by the Task execution guard above.
      // The prior decision remains in the durable decision ledger and Task
      // comments. A fresh execution may start the next preview revision.
      invocationId=proposedId;
      task.interactiveInvocation={invocationId,executionId,revision:`pending:${invocationId}`,
        status:'awaiting_decision',boundAt:new Date().toISOString()};
      task.updatedAt=new Date().toISOString();
    }else{
      throw new Error('Conflicting interactive invocation on Task');
    }
    return job;
  });
  return {jobId,taskId,executionId,invocationId,reused,
    eventTemplate:interactiveTemplate(jobId,taskId,executionId,invocationId)};
}
export async function abortInteractiveReview(store:DurableStore,jobId:string,taskId:string,executionId:string,invocationId:string){
  if(!store.mutateJob)throw new Error('Interactive review requires durable mutation');
  await store.mutateJob(jobId,job=>{
    const task=job.tasks.find(t=>t.id===taskId);
    if(task?.state==='RUNNING'&&task.executionId===executionId&&
       task.interactiveInvocation?.invocationId===invocationId&&
       task.interactiveInvocation.status==='awaiting_decision'){
      task.interactiveInvocation=undefined;task.updatedAt=new Date().toISOString();
    }
    return job;
  });
}
export async function readyInteractiveReview(store:DurableStore,jobId:string,taskId:string,
  executionId:string,invocationId:string,revision:string){
  if(!/^[a-f0-9]{64}$/.test(revision))throw new Error('Immutable revision must be SHA-256');
  if(!store.mutateJob)throw new Error('Interactive review requires durable mutation');
  await store.mutateJob(jobId,job=>{
    const task=job.tasks.find(t=>t.id===taskId);
    const inv=task?.interactiveInvocation;
    if(!task||task.state!=='AWAITING_DECISION'||!inv||inv.executionId!==executionId||
       inv.invocationId!==invocationId||inv.status!=='awaiting_decision')
      throw new Error('Interactive review is not awaiting this execution/invocation');
    if(inv.revision!==`pending:${invocationId}`&&inv.revision!==revision)
      throw new Error('Conflicting immutable review revision');
    inv.revision=revision;
    task.updatedAt=new Date().toISOString();
    return job;
  });
  return {ready:true,invocationId,revision};
}
export async function failInteractiveReview(store:DurableStore,jobId:string,taskId:string,
  executionId:string,invocationId:string,reason:string){
  if(!store.mutateJob)throw new Error('Interactive review requires durable mutation');
  let requeued=false;
  await store.mutateJob(jobId,job=>{
    const task=job.tasks.find(t=>t.id===taskId);
    const inv=task?.interactiveInvocation;
    if(!task||!inv||inv.executionId!==executionId||inv.invocationId!==invocationId||
       inv.status!=='awaiting_decision')return job;
    if(task.state==='AWAITING_DECISION'){
      if(!tryTransitionTaskEvent(task,'interactive.resume').accepted)
        throw new Error('Graph rejected review delivery failure recovery');
      applyTaskUnblockRetrySnapshot(task);
      task.interactiveInvocation=undefined;
      task.error=null;task.failureReason=undefined;
      appendTaskComment(job,taskId,`Preview delivery failed; rerun preview request: ${reason.slice(0,500)}`);
      task.updatedAt=new Date().toISOString();
      requeued=true;
    }else if(task.state==='RUNNING'&&task.executionId===executionId){
      task.interactiveInvocation=undefined;
    }
    return job;
  });
  return {requeued};
}
