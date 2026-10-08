import type { DurableStore } from './store.js';
import type { Task } from './types.js';

/** A planner-created dependent review must freeze its head only after implementation completes. */
export async function bindPlannedReviewHead(store: DurableStore, task: Task): Promise<void> {
  const current = await store.pullRequestHead?.();
  if (!current?.sha) throw new Error(`Review ${task.id} requires current PR head SHA`);
  task.reviewHeadSha = current.sha;
  await store.saveTask(task);
}
