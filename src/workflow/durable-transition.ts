import type { DurableStore } from '../store.js';
import type { Job, Task } from '../types.js';
import { tryTransitionTaskEvent } from '../scheduler.js';
import type { WorkflowContext } from './mermaid.js';
import type { WorkflowDecision } from './contracts.js';
import { observability } from '../observability.js';

export type DurableTaskTransitionResult = {
  job: Job;
  task: Task;
  from: Task['state'];
  decision: WorkflowDecision<Task['state']>;
};

type DurableTaskTransitionOptions = {
  eligible?: (job: Job, task: Task) => boolean;
  facts?: (job: Job, task: Task) => WorkflowContext;
  mutate?: (job: Job, task: Task, decision: WorkflowDecision<Task['state']>) => void | Promise<void>;
};

/**
 * Runtime primitive for applying one canonical Task-graph event to fresh durable state.
 *
 * This class owns serialization and persistence only. It does not decide lifecycle
 * legality: the canonical Mermaid Task graph does that through tryTransitionTaskEvent.
 */
export class DurableTaskTransitionRuntime {
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly store: DurableStore) {}

  async apply(
    jobId: string,
    taskId: string,
    event: string,
    options: DurableTaskTransitionOptions = {},
  ): Promise<DurableTaskTransitionResult | null> {
    return this.withLock(`${jobId}/${taskId}`, async () => {
      const job = await this.store.load(jobId);
      const task = job.tasks.find(item => item.id === taskId);
      if (!task || (options.eligible && !options.eligible(job, task))) {
        observability().record({
          stage: 'transition', event, level: 'debug', outcome: 'skipped',
          message: `Task ${taskId} transition ${event} not eligible`,
          correlation: { repository: job.repository, prNumber: job.prNumber, jobId, taskId },
          transition: { graph: 'task-lifecycle', from: task?.state ?? null, to: null },
        });
        return null;
      }
      const from = task.state;
      const decision = tryTransitionTaskEvent(task, event, options.facts?.(job, task) ?? {});
      if (!decision.accepted || !decision.target) {
        return { job, task, from, decision };
      }
      await options.mutate?.(job, task, decision);
      await this.store.saveTask(task);
      observability().record({
        stage: 'transition',
        event,
        outcome: 'succeeded',
        message: `Task ${taskId} ${from} -> ${decision.target}`,
        correlation: { repository: job.repository, prNumber: job.prNumber, jobId, taskId, executionId: task.executionId ?? undefined },
        transition: { graph: 'task-lifecycle', from, to: decision.target, actions: decision.actions },
      });
      return { job, task, from, decision };
    });
  }

  private async withLock<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(key);
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.locks.set(key, current);
    if (previous) await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }
}
