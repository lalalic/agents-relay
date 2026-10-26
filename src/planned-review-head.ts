import type { DurableStore } from './store.js';
import type { Task } from './types.js';

/** A planner-created dependent review must freeze its head only after implementation completes. */
export async function bindPlannedReviewHead(store: DurableStore, task: Task, localHeadSha: string | null): Promise<void> {
  if (!localHeadSha) throw new Error(`Review ${task.id} requires current local Git head SHA`);
  task.reviewHeadSha = localHeadSha;
  const rule = [
    'Review the current immutable local source head as a PRE-MERGE approval gate.',
    'Distinguish code added by this implementation from pre-existing local baseline/seed files present before the Task started.',
    'Preserved baseline files are not automatically extra changes merely because they differ from main; still review them for real risks.',
    'Do not require a remote PR MERGED, Job COMPLETED, or post-merge validation before review approval:',
    'those events must follow approval and require their own verified durable receipts.',
  ].join(' ');
  if (!task.input.includes(rule)) task.input += '\n\n' + rule;
  await store.saveTask(task);
}
