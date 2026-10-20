import type { DurableStore } from './store.js';
import { tryTransitionTaskEvent } from './scheduler.js';
import { requestTroubleshooterEscalation } from './task-recovery.js';

const MARKER = '[Relay execution fallback attempted]';
const RUNTIME_FAILURE = /worker_process_failed|worker_start_timeout|terminal_event_timeout|model.*not supported|unsupported.model|delivery|process.exited|provider/i;

/** One bounded Codex-config-default retry after normal recovery attempts. */
export async function fallbackFailedTroubleshooters(store: DurableStore, jobId: string): Promise<string[]> {
  const job = await store.load(jobId);
  const queued: string[] = [];
  for (const recovery of job.tasks.filter(task => task.agentName === 'troubleshooter' && task.state === 'FAILED' && task.attempt >= task.maxAttempts && !task.input.includes(MARKER))) {
    const original = job.tasks.find(task => task.id === recovery.parentTaskId);
    const plan = job.plans?.find(item => item.id === recovery.recoveryPlanId);
    if ((!original || original.state !== 'FAILED') && (!plan || plan.status !== 'FAILED')) continue;
    if ((original?.resolution?.path === 'same_job_dependency' && ['waiting','active'].includes(original.resolution.state)) || !RUNTIME_FAILURE.test(`${recovery.failureReason ?? ''} ${recovery.error ?? ''}`)) continue;
    const update = (task: (typeof job.tasks)[number]): boolean => {
      if (task.state !== 'FAILED' || task.input.includes(MARKER)) return false;
      if (!tryTransitionTaskEvent(task, 'retry').accepted) throw new Error(`Fallback retry rejected for ${task.id}`);
      task.maxAttempts = Math.max(task.maxAttempts, task.attempt + 1);
      task.input += `\n\n${MARKER} Retry diagnosis with Codex config default model; report valid resolution or explicit blocker.`;
      task.routing = { provider: '', model: '', decidedBy: 'troubleshooter-fallback:codex-config-default', decidedAt: new Date().toISOString() };
      task.workerSelection = undefined; task.leaseOwner = null; task.leaseExpiresAt = null; task.executionId = null;
      return true;
    };
    if (store.mutateJob) {
      await store.mutateJob(jobId, current => {
        const task = current.tasks.find(item => item.id === recovery.id);
        if (task && update(task)) queued.push(task.id);
        return current;
      });
    } else {
      const task = (await store.load(jobId)).tasks.find(item => item.id === recovery.id);
      if (task && update(task)) { await store.saveTask(task); queued.push(task.id); }
    }
  }
  return queued;
}

/** The Core, not the crashed Agent, creates a durable human action gate. */
export async function escalateExhaustedTroubleshooters(store: DurableStore, jobId: string): Promise<string[]> {
  const job = await store.load(jobId);
  const escalated: string[] = [];
  for (const recovery of job.tasks.filter(task => task.agentName === 'troubleshooter' && task.state === 'FAILED' && task.attempt >= task.maxAttempts && !task.escalation)) {
    const original = job.tasks.find(task => task.id === recovery.parentTaskId);
    const plan = job.plans?.find(item => item.id === recovery.recoveryPlanId);
    if ((!original || original.state !== 'FAILED') && (!plan || plan.status !== 'FAILED')) continue;
    if (original?.resolution?.path === 'same_job_dependency' && ['waiting','active'].includes(original.resolution.state)) continue;
    const subject=original ? `Task ${original.id}` : `Plan ${plan!.id}`;
    const failure=original?.error ?? original?.failureReason ?? plan?.error ?? 'unknown';
    const context = `Automatic Troubleshooter ${recovery.id} could not produce a verified resolution after ${recovery.attempt} attempts. Last failure: ${recovery.error ?? recovery.failureReason ?? 'unknown'}. Original ${subject}: ${failure}.`;
    const result = await requestTroubleshooterEscalation(store, jobId, recovery.id, {
      requiredAction: `Inspect ${subject} and Troubleshooter ${recovery.id}; correct provider/runtime or supply a concrete recovery decision and supporting evidence.`,
      resolutionCondition: `User supplies a corrective action or verified recovery instructions for ${subject}.`, context,
    });
    if (!result.duplicate) escalated.push(recovery.id);
  }
  return escalated;
}
