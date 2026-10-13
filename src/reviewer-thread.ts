import type { ChatGptThreadDelivery, Job, Task, WorkerRequirements } from './types.js';
import { arg, hasArg } from './cli-support.js';

export type ReviewThreadDestination = {
  threadId: string;
  source: 'override' | 'reviewer' | 'creator';
};

export function resolveImplementationThreadDestination(job: Pick<Job, 'implementationThreadId'>): string | null {
  return job.implementationThreadId ? normalizeThreadId(job.implementationThreadId, 'Job implementation thread ID') ?? null : null;
}

export function resolveImplementationTaskThreadDestination(
  job: Pick<Job, 'implementationThreadId'>, task: Pick<Task, 'agentName'>,
): string | null {
  return task.agentName === 'implementation' ? resolveImplementationThreadDestination(job) : null;
}

export function normalizeThreadId(value: unknown, label = 'thread ID'): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  const threadId = value.trim();
  if (!threadId) throw new Error(`${label} cannot be empty`);
  if (threadId.length > 256) throw new Error(`${label} cannot exceed 256 characters`);
  return threadId;
}

export function resolveReviewerThreadDestination(
  job: Pick<Job, 'reviewerThreadId' | 'creatorThreadId'>,
  override?: string,
): ReviewThreadDestination | null {
  const overridden = override === undefined ? undefined : normalizeThreadId(override, '--thread-id');
  if (overridden) return { threadId: overridden, source: 'override' };
  const reviewerThreadId = job.reviewerThreadId ? normalizeThreadId(job.reviewerThreadId, 'Job reviewer thread ID') : undefined;
  if (reviewerThreadId) return { threadId: reviewerThreadId, source: 'reviewer' };
  const creatorThreadId = job.creatorThreadId ? normalizeThreadId(job.creatorThreadId, 'Job creator thread ID') : undefined;
  return creatorThreadId ? { threadId: creatorThreadId, source: 'creator' } : null;
}

export function prepareReviewerThreadDelivery(
  job: Job, task: Pick<Task, 'id' | 'agentName' | 'reviewHeadSha' | 'routing' | 'chatgptThreadDelivery'>,
  override?: string,
): ChatGptThreadDelivery | undefined {
  if (task.agentName !== 'reviewer') return undefined;
  const destination = resolveReviewerThreadDestination(job, override);
  if (!destination) return undefined;
  const existing = task.chatgptThreadDelivery;
  if (existing?.deliveredAt) {
    if (existing.threadId !== destination.threadId) throw new Error('Cannot redirect an already delivered reviewer task');
    return existing;
  }
  return {
    kind: 'new-turn', threadId: destination.threadId, threadSource: destination.source,
    requestId: existing?.requestId ?? `${job.id}:${task.id}:${task.reviewHeadSha ?? job.headSha ?? 'review'}`,
    jobId: job.id, prNumber: job.prNumber,
    ...(task.reviewHeadSha ? { reviewHeadSha: task.reviewHeadSha } : {}),
    projectId: task.routing?.projectId ?? null,
    ...(existing?.executionId ? { executionId: existing.executionId } : {}),
  };
}

export function chatgptThreadRequirements(configured: WorkerRequirements | undefined): WorkerRequirements {
  const base = configured ?? { capabilities: ['model'] };
  const capabilities = new Set([...base.capabilities, 'model', 'chatgpt', 'browser-workspace']);
  return { ...base, capabilities: [...capabilities], runtime: 'chatgpt' };
}

export function runtimeReviewer(args: readonly string[] = []) {
  const values = [...args];
  const threadId = arg(values, '--thread-id', '');
  if (hasArg(values, '--thread-id')) normalizeThreadId(threadId, '--thread-id');
  return { requirements: { capabilities: ['model'] }, ...(threadId.trim() ? { threadId: threadId.trim() } : {}) };
}

export async function recordThreadDelivery(
  store: { load(jobId: string): Promise<{ tasks: Task[] }>; saveTask(task: Task): Promise<unknown>; mutateJob?: (jobId: string, mutate: (job: Job) => Job) => Promise<unknown> },
  jobId: string, taskId: string, executionId: string, workerTask: Task,
): Promise<void> {
  const delivery = workerTask.chatgptThreadDelivery;
  if (!delivery || delivery.deliveredAt || (delivery.executionId !== undefined && delivery.executionId !== executionId)) return;
  const mark = (job: Job): Job => {
    const current = job.tasks.find(item => item.id === taskId);
    if (!current || current.executionId !== executionId || current.state !== 'RUNNING' || !current.chatgptThreadDelivery
      || current.chatgptThreadDelivery.requestId !== delivery.requestId || current.chatgptThreadDelivery.deliveredAt) return job;
    current.chatgptThreadDelivery = { ...current.chatgptThreadDelivery, executionId, deliveredAt: new Date().toISOString() };
    return job;
  };
  if (store.mutateJob) { await store.mutateJob(jobId, mark); return; }
  const current = (await store.load(jobId)).tasks.find(item => item.id === taskId);
  if (!current || current.executionId !== executionId || current.state !== 'RUNNING' || !current.chatgptThreadDelivery || current.chatgptThreadDelivery.requestId !== delivery.requestId || current.chatgptThreadDelivery.deliveredAt) return;
  current.chatgptThreadDelivery = { ...current.chatgptThreadDelivery, executionId, deliveredAt: new Date().toISOString() };
  await store.saveTask(current);
}
