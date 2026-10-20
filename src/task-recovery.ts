import { randomUUID } from 'node:crypto';
import { eventFor } from './events.js';
import type { DurableStore } from './store.js';
import type { Job, Task, TaskEscalation, EventRecord } from './types.js';
import { tryTransitionTaskEvent } from './scheduler.js';
import { dispatchTaskResolutionSync, materializeResolution } from './workflow/task-resolution.js';

export type EscalationRequest = {
  requiredAction: string;
  resolutionCondition: string;
  context: string;
  notification?: Record<string, unknown> | null;
};

function activeRecovery(job: Job, original: Task): Task | undefined {
  return job.tasks.find(task => task.agentName === 'troubleshooter'
    && task.parentTaskId === original.id
    && ['DRAFT', 'QUEUED', 'RUNNING', 'BLOCKED'].includes(task.state));
}

function clearExecution(task: Task): void {
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
}

function validateRequest(request: EscalationRequest): void {
  if (!request.requiredAction.trim()) throw new Error('Escalation requires a concrete required action');
  if (!request.resolutionCondition.trim()) throw new Error('Escalation requires a resolution condition');
  if (!request.context.trim()) throw new Error('Escalation requires diagnostic context');
}

/** Relay-owned escalation: the recovery Task, never the failed original, becomes BLOCKED. */
export async function requestTroubleshooterEscalation(
  store: DurableStore, jobId: string, recoveryTaskId: string, request: EscalationRequest, now = new Date().toISOString(),
): Promise<{ job: Job; task: Task; escalation: TaskEscalation; duplicate: boolean }> {
  validateRequest(request);
  let result: { task: Task; escalation: TaskEscalation; duplicate: boolean } | undefined;
  let requestedEvent: EventRecord | undefined;
  const apply = (job: Job): Job => {
    const recovery = job.tasks.find(task => task.id === recoveryTaskId);
    if (!recovery || recovery.agentName !== 'troubleshooter' || (!recovery.parentTaskId && !recovery.recoveryPlanId)) throw new Error(`Task ${recoveryTaskId} is not a Troubleshooter recovery`);
    if (job.state === 'CANCELLED' || job.state === 'COMPLETED') throw new Error(`Job ${job.id} is terminal`);
    const original = recovery.parentTaskId ? job.tasks.find(task => task.id === recovery.parentTaskId) : undefined;
    const originalPlan = recovery.recoveryPlanId ? job.plans?.find(plan => plan.id === recovery.recoveryPlanId) : undefined;
    if ((!original || original.state !== 'FAILED') && (!originalPlan || originalPlan.status !== 'FAILED'))
      throw new Error(`Troubleshooter ${recoveryTaskId} has no current FAILED original Task or Plan`);
    if (recovery.escalation?.status === 'pending' && recovery.state === 'BLOCKED') {
      result = { task: structuredClone(recovery), escalation: structuredClone(recovery.escalation), duplicate: true };
      return job;
    }
    if (!['QUEUED', 'RUNNING', 'FAILED'].includes(recovery.state)) throw new Error(`Troubleshooter ${recoveryTaskId} cannot escalate from ${recovery.state}`);
    if (original) {
      const proposal = { path: 'escalation_gate' as const, targetTaskId: original.id, rootCause: request.context.trim(), solution: request.requiredAction.trim() };
      const decision = dispatchTaskResolutionSync(original, proposal, 'troubleshooter', {
        createEscalationGate: () => { original.resolution = materializeResolution(original, proposal, 'troubleshooter', now); },
      });
      if (!decision.accepted) throw new Error(`Task resolution graph rejected escalation for ${original.id}`);
    }
    // A Plan is an independent durable entity, never a synthetic Task. The
    // Plan-failure guard is owned by planner-orchestration; only the real
    // Troubleshooter Task undergoes the task-lifecycle BLOCKED transition.
    if (!tryTransitionTaskEvent(recovery, recovery.state === 'QUEUED' ? 'block' : 'task.blocked', { recoverableExecution: true }).accepted) throw new Error(`Troubleshooter ${recoveryTaskId} cannot be blocked`);
    const escalation: TaskEscalation = {
      id: randomUUID(), originalTaskId: original?.id, originalPlanId: originalPlan?.id,
      originalExecutionId: original?.executionId ?? undefined,
      recoveryExecutionId: recovery.executionId ?? undefined, requiredAction: request.requiredAction.trim(),
      resolutionCondition: request.resolutionCondition.trim(), context: request.context.trim(), status: 'pending',
      requestedAt: now, notification: { status: 'pending', channel: typeof request.notification?.channel === 'string' ? request.notification.channel : 'relay-event', requestedAt: now },
    };
    const event = eventFor(job.id, recovery.id, original?.id ?? null, 'escalation.requested', 'blocked',
      `Human action required: ${escalation.requiredAction}`, 'user',
      { escalationId: escalation.id, originalTaskId: original?.id, originalPlanId: originalPlan?.id, requiredAction: escalation.requiredAction,
        resolutionCondition: escalation.resolutionCondition, notificationStatus: 'pending' },
      { agent: 'relay', component: 'agents-relay' });
    event.event_id = `escalation/${escalation.id}`;
    requestedEvent = event;
    recovery.escalation = escalation;
    recovery.error = `Waiting for human action: ${escalation.requiredAction}`;
    recovery.failureReason = 'human_action_required';
    clearExecution(recovery);
    recovery.updatedAt = now;
    result = { task: structuredClone(recovery), escalation, duplicate: false };
    job.updatedAt = now;
    return job;
  };
  const job = store.commitWorkflowMutationWithEvents
    ? await store.commitWorkflowMutationWithEvents(jobId, current => {
      const next = apply(current);
      return { next, events: requestedEvent ? [{ key: requestedEvent.event_id, event: requestedEvent }] : [] };
    })
    : store.mutateJob ? await store.mutateJob(jobId, apply)
    : await store.load(jobId).then(async current => { apply(current); for (const task of current.tasks) await store.saveTask(task); await store.saveJob(current); return current; });
  if (!result) throw new Error('Escalation did not produce a durable result');
  return { job, ...result };
}

/** Authorized human response; only a blocked Troubleshooter may be resumed. */
export async function resumeTroubleshooter(
  store: DurableStore, jobId: string, recoveryTaskId: string, response: string, now = new Date().toISOString(),
): Promise<{ job: Job; task: Task }> {
  if (!response.trim()) throw new Error('Troubleshooter response is required');
  let updated: Task | undefined;
  const apply = (job: Job): Job => {
    const task = job.tasks.find(item => item.id === recoveryTaskId);
    if (!task || task.agentName !== 'troubleshooter' || !task.escalation) throw new Error(`Task ${recoveryTaskId} is not a Troubleshooter escalation`);
    if (task.escalation.status !== 'pending') throw new Error(`Escalation ${task.escalation.id} already has a response`);
    if (task.state !== 'BLOCKED') throw new Error(`Task ${recoveryTaskId} is not a blocked Troubleshooter escalation`);
    if (!tryTransitionTaskEvent(task, 'task.unblocked', { autonomousJob: false }).accepted) throw new Error(`Troubleshooter ${recoveryTaskId} cannot be resumed`);
    task.escalation = { ...task.escalation, status: 'responded', response: response.trim(), respondedAt: now };
    task.input += `\n\n## Human response (${now})\n${response.trim()}\n\nRe-validate the original failure against this response. Required resolution condition: ${task.escalation.resolutionCondition}`;
    task.result = null;
    task.error = null;
    task.failureReason = undefined;
    clearExecution(task);
    task.updatedAt = now;
    updated = structuredClone(task);
    job.updatedAt = now;
    return job;
  };
  const job = store.mutateJob ? await store.mutateJob(jobId, apply) : await store.load(jobId).then(async current => { apply(current); for (const task of current.tasks) await store.saveTask(task); await store.saveJob(current); return current; });
  if (!updated) throw new Error('Troubleshooter was not resumed');
  return { job, task: updated };
}

export function hasPendingTroubleshooterEscalation(job: Job, original: Task): boolean {
  const recovery = activeRecovery(job, original);
  return recovery?.state === 'BLOCKED' && recovery.escalation?.status === 'pending';
}

/** Trusted notification adapter receipt. Publishing to the bus does NOT count as
 * delivery to a human. Only an actual downstream delivery ID can set delivered. */
export async function recordEscalationNotificationDelivery(
  store: DurableStore, jobId: string, recoveryTaskId: string, escalationId: string,
  receipt: {channel: string; deliveryId: string; deliveredAt: string},
): Promise<TaskEscalation> {
  if (!receipt.channel.trim() || !receipt.deliveryId.trim() || !Number.isFinite(Date.parse(receipt.deliveredAt)))
    throw Error('Escalation delivery requires a real channel, provider receipt ID and timestamp');
  if (!store.mutateJob) throw Error('Escalation receipt requires authoritative SQLite mutation');
  let confirmed: TaskEscalation | undefined;
  await store.mutateJob(jobId, job => {
    const recovery = job.tasks.find(task=>task.id===recoveryTaskId && task.agentName==='troubleshooter');
    const escalation = recovery?.escalation;
    if (!escalation || escalation.id!==escalationId) throw Error('Unknown escalation delivery identity');
    if (escalation.status!=='pending') throw Error('Escalation no longer pending');
    const previous=escalation.notification as Record<string,unknown>|null|undefined;
    if (previous?.status==='delivered') {
      if (previous.deliveryId!==receipt.deliveryId || previous.channel!==receipt.channel)
        throw Error('Escalation delivery receipt conflict');
      confirmed=structuredClone(escalation);return job;
    }
    escalation.notification={status:'delivered',channel:receipt.channel,deliveryId:receipt.deliveryId,deliveredAt:receipt.deliveredAt};
    recovery.updatedAt=receipt.deliveredAt;
    confirmed=structuredClone(escalation);return job;
  });
  if(!confirmed)throw Error('Escalation delivery receipt not committed');
  return confirmed;
}
