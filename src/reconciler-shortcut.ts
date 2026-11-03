import { eventFor } from './events.js';
import { runAgentShortcut } from './agent-shortcut.js';
import { applyTaskRetryAction } from './task-actions.js';
import { resolveExecutionContext } from './execution-context.js';
import type { DurableStore } from './store.js';
import type { EventRecord, Job, Task } from './types.js';
import type { ReconcileOptions } from './reconciler-runtime.js';

type ShortcutReceiptIdentity = { nodeId: string; waitId: string; revision: string; contentSha256: string; executionId: string };

async function executeShortcut(store: DurableStore, options: ReconcileOptions, job: Job, task: Task,
  emit: (event: EventRecord) => Promise<void>): Promise<void> {
  const projectPath = options.projectPathForJob ? await options.projectPathForJob(job, task) : task.routing?.cwd ?? process.cwd();
  const context = await resolveExecutionContext(projectPath, 'worker', options.executionContextRoots ?? {});
  const result = await runAgentShortcut({ store, job, task, projectPath, neoRoot: context.project.neoRoot ?? undefined, concurrency: options.maxConcurrent,
    ...(task.state === 'RUNNING' && task.leaseOwner === null ? { resumeReceiptSelected: true as const } : {}) });
  if (result.fallback) { await applyTaskRetryAction(result.task); await store.saveTask(result.task); }
  else if (result.outcome.status === 'FAILED') {
    const message = 'Shortcut stopped after possible effects; reconcile its durable Troubleshooter recovery';
    await emit(eventFor(job.id, task.id, task.parentTaskId, 'job.wake', 'queued', message, 'orchestrator', { failureReason: 'shortcut_requires_recovery' }));
  }
}

export async function launchShortcutEffect(store: DurableStore, options: ReconcileOptions, jobId: string, taskId: string | undefined,
  emit: (event: EventRecord) => Promise<void>): Promise<void> {
  if (!taskId) throw new Error('Shortcut launch requires a Task ID');
  const job = await store.load(jobId);
  const task = job.tasks.find(item => item.id === taskId);
  if (!task || task.state !== 'QUEUED' || task.executionId !== null) return;
  if (!task.agentGraph) throw new Error('Task Graph selected shortcut launch without a persisted Agent Graph');
  await executeShortcut(store, options, job, task, emit);
}

export async function resumeShortcutEffect(store: DurableStore, options: ReconcileOptions, jobId: string, taskId: string | undefined,
  _data: Record<string, unknown> | undefined, emit: (event: EventRecord) => Promise<void>): Promise<void> {
  if (!taskId) throw new Error('Shortcut result action requires a Task ID');
  const job = await store.load(jobId);
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  // The runner reads only the atomically persisted receipt from this Task's SQLite checkpoint.
  if (task.state !== 'RUNNING' || task.leaseOwner !== null) return;
  try { await executeShortcut(store, options, job, task, emit); }
  catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message === 'Shortcut wait claim was fenced by another execution' || message === `Task ${task.id} has an active or unreconciled execution lease`) return;
    throw error;
  }
}

export async function resumeShortcutEventWaits(store: DurableStore, _options: ReconcileOptions, jobId: string,
  dispatchResume: (job: Job, task: Task, result: ShortcutReceiptIdentity) => Promise<void>, _emit: (event: EventRecord) => Promise<void>): Promise<void> {
  const job = await store.load(jobId);
  if (job.executionMode !== 'shortcut' || job.contentOnly !== true || job.state !== 'ACTIVE' || job.pause) return;
  for (const task of job.tasks.filter(item => item.state === 'RUNNING' && item.leaseOwner === null && item.executionId !== null)) {
    const checkpoint = task.result?.data?.shortcut as { waits?: Record<string, { kind?: string; id?: string; revision?: string; contentHash?: string; executionId?: string }>; receipts?: Record<string, ShortcutReceiptIdentity> } | undefined;
    for (const [nodeId, wait] of Object.entries(checkpoint?.waits ?? {})) {
      const receipt = checkpoint?.receipts?.[nodeId];
      if (!receipt || wait.kind !== 'nonhuman_result' || !wait.id || !wait.revision || !wait.contentHash || wait.executionId !== task.executionId
        || receipt.nodeId !== nodeId || receipt.waitId !== wait.id || receipt.revision !== wait.revision || receipt.contentSha256 !== wait.contentHash
        || receipt.executionId !== task.executionId) continue;
      await dispatchResume(job, task, receipt);
      break;
    }
  }
}
