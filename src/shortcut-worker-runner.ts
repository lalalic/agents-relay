import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import type { Reconciler } from './reconciler.js';

/** One foreground owner drives all Worker fallback and Troubleshooter Tasks.
 * No background scheduler may mutate a Shortcut Job. */
export async function driveShortcutWorkers(options: {
  store: DurableStore;
  jobId: string;
  taskId: string;
  reconciler: Reconciler;
  signal?: AbortSignal;
  onTask?: (task: Task) => void;
}): Promise<{ status: 'COMPLETED'|'FAILED'|'WAITING_EVENT'|'TIMED_OUT'|'INTERRUPTED'; job: Job }> {
  const { store, jobId, reconciler, taskId } = options;
  if (!store.mutateJob) throw new Error('Foreground Worker fallback requires atomic Relay SQLite');
  await store.mutateJob(jobId, job => {
    if (job.executionMode !== 'shortcut' || job.contentOnly !== true || job.state !== 'ACTIVE') throw new Error('Not an active Shortcut Job');
    if (!job.tasks.find(task => task.id === taskId)) throw new Error('Shortcut parent Task missing');
    if (!job.shortcutExecutionStartedAt) job.shortcutExecutionStartedAt = new Date().toISOString();
    if (!Number.isFinite(Date.parse(job.shortcutExecutionStartedAt))) throw new Error('Invalid original Shortcut start time');
    return job;
  });
  const last = new Map<string, string>();
  const stopWatching = await reconciler.watch(jobId);
  const observe = (job: Job): void => {
    for (const task of job.tasks) {
      const key = `${task.state}:${task.attempt}:${task.error ?? ''}`;
      if (last.get(task.id) !== key) { last.set(task.id, key); options.onTask?.(task); }
    }
  };
  try {
    while (true) {
      if (options.signal?.aborted) return { status: 'INTERRUPTED', job: await store.load(jobId) };
      await reconciler.reconcile(jobId);
      let job = await store.load(jobId);
      observe(job);
      if (job.state === 'COMPLETED') return { status: 'COMPLETED', job };
      if (job.state === 'CANCELLED') return { status: 'FAILED', job };
      if (job.tasks.every(task => task.state === 'SUCCEEDED')) {
        job = await store.mutateJob(jobId, current => {
          if (current.state !== 'ACTIVE' || !current.tasks.length || !current.tasks.every(task => task.state === 'SUCCEEDED')
            || current.prNumber !== 0 || current.localMerge || current.autoMerge !== false || current.reviewEnabled !== false || current.review || current.plans?.length)
            throw new Error('Shortcut completion requires all durable Tasks and content-only policy');
          const decision = dispatchJobLifecycleSync(current, 'shortcut.completed', { shortcutCompletionAllowed: true });
          if (!decision.accepted || decision.target !== 'COMPLETED') throw new Error('Job Graph rejected Shortcut completion');
          return current;
        });
        return { status: 'COMPLETED', job };
      }
      if (job.tasks.some(task => task.state === 'BLOCKED' || task.state === 'AWAITING_DECISION')) return { status: 'WAITING_EVENT', job };
      if (job.tasks.some(task => task.agentName === 'troubleshooter' && task.state === 'FAILED' && task.attempt >= task.maxAttempts))
        return { status: 'FAILED', job };
      await new Promise<void>(resolve => setTimeout(resolve, 350));
    }
  } finally {
    await stopWatching();
    await reconciler.close();
  }
}
