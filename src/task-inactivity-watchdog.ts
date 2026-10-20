import type { Task, EventRecord } from './types.js';
import type { DurableTaskTransitionRuntime } from './workflow/durable-transition.js';
import { executionEventSource, eventSourceId } from './execution-event-identity.js';

export function isRecoverableWatchdogFailure(task: Task): boolean {
  if (['worker_start_timeout', 'terminal_event_timeout', 'worker_exit_before_start', 'worker_exit_without_terminal_event', 'worker_delivery_after_start'].includes(task.failureReason ?? '')) return true;
  const error = task.error ?? '';
  return error.includes('worker_start_timeout') || error.includes('timed out waiting for the mandatory terminal worker event') || error.includes('exceeded its inactivity timeout')
    || error.includes('exited before publishing task.started') || error.includes('exited after task.started without publishing a terminal task event')
    || error.includes('Worker delivery failed after task.started');
}

export function isCorrelatedWorkerEvent(task: Task, event: EventRecord): boolean {
  return task.executionId !== null && eventSourceId(event) === executionEventSource(event.job_id, task.id, task.executionId);
}

export function inactivityDeadline(task: Task, executionId: string, postExitGraceMs: number): number {
  const progressAt = Date.parse(task.lastProgressAt ?? task.executionHistory?.find(item => item.id === executionId)?.startedAt ?? task.updatedAt);
  const timeoutAt = (Number.isFinite(progressAt) ? progressAt : Date.now()) + Math.max(1, task.timeoutMs);
  const exitAt = task.adapter !== 'chatgpt' && task.processExitedAt ? Date.parse(task.processExitedAt) : NaN;
  return Number.isFinite(exitAt) ? Math.min(timeoutAt, exitAt + postExitGraceMs) : timeoutAt;
}

export function armInactivityWatchdog(
  task: Task, executionId: string, timers: Map<string, NodeJS.Timeout>, postExitGraceMs: number, expire: () => void,
): void {
  const existing = timers.get(task.id);
  if (existing) clearTimeout(existing);
  timers.delete(task.id);
  if (!task.jobId || task.executionId !== executionId || !['QUEUED', 'RUNNING'].includes(task.state)) return;
  const timer = setTimeout(expire, Math.max(1, inactivityDeadline(task, executionId, postExitGraceMs) - Date.now()));
  timer.unref();
  timers.set(task.id, timer);
}

export async function acceptTaskProgress(
  transitions: DurableTaskTransitionRuntime, event: EventRecord,
): Promise<Task | null> {
  const parsedAt = Date.parse(event.timestamp);
  const receivedAt = Date.now();
  const transition = await transitions.apply(event.job_id, event.task_id, 'task.progress', {
    eligible: (job, task) => task.state === 'RUNNING'
      && Boolean(task.executionId && eventSourceId(event) === executionEventSource(job.id, task.id, task.executionId))
      && Number.isFinite(parsedAt) && parsedAt <= receivedAt
      && (!task.lastProgressEventAt || parsedAt > Date.parse(task.lastProgressEventAt)),
    mutate: (_job, task) => {
      task.lastProgressAt = new Date(receivedAt).toISOString();
      task.lastProgressEventAt = event.timestamp;
      task.updatedAt = task.lastProgressAt;
    },
  });
  return transition?.decision.accepted ? transition.task : null;
}
