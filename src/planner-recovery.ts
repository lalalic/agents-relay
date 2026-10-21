import type {Job,Plan,Task} from './types.js';
import {taskOverallTimeoutMs} from './types.js';
import {createTaskEntity} from './workflow/entity-creation.js';

/** Only the Planner orchestration Graph may select this durable recovery effect. */
export function createFailedPlanRecovery(job:Job, plan:Plan):Task {
  if(plan.status!=='FAILED')throw Error('Plan recovery requires a terminal FAILED Plan');
  const id='recover-'+plan.id;
  if(job.tasks.some(task=>task.id===id||task.recoveryPlanId===plan.id))
    throw Error('Plan recovery identity already exists');
  const now=new Date().toISOString();
  return createTaskEntity(job,{
    jobId:job.id,id,title:'Troubleshoot',
    recoveryPlanId:plan.id,
    kind:'work',priority:'P0',storySize:'M',projectName:job.title,
    agentName:'troubleshooter',parentTaskId:null,dependencies:[],
    capabilities:['troubleshoot','recovery'],
    workerRequirements:{capabilities:['model','local_repo','iterative_tools'],runtime:'codex'},
    adapter:'codex',
    input:`Recover FAILED Plan ${plan.id} in Job ${job.id}, repository ${job.repository}.
Original Plan failure: ${plan.error??plan.assessment}.
Inspect durable Plan history and original model/runtime error; repair or verify the actual blocker.
Do not fabricate Planner success, create another Job, or publish blocked.
Report task.completed only after verified technical recovery, with data.verified=true and non-empty data.evidence explaining the repair.
Relay will create a NEW authoritative Plan round after your completed recovery evidence; it will not re-label the FAILED Plan as successful.`,
    output:{kind:'task_pr'},continuation:null,continuationDeliveredAt:null,
    attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,
    executionId:null,threadId:null,result:null,plannerResult:null,error:null,
    timeoutMs:taskOverallTimeoutMs('M'),createdAt:now,updatedAt:now,
  });
}
