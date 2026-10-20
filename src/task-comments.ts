import { randomUUID } from 'node:crypto';
import type { Job, Task } from './types.js';

export type TaskCommentKind = 'human' | 'resolution.changed' | 'escalation.requested' | 'escalation.responded';
export type TaskComment = {
  id: string; text: string; author: string; createdAt: string; kind?: TaskCommentKind;
  jobId?: string; taskId?: string; executionId?: string; transition?: string; idempotencyKey?: string;
};
export type TaskCommentOptions = {
  author?: string; kind?: TaskCommentKind; executionId?: string; transition?: string; idempotencyKey?: string;
};
export function appendTaskComment(job: Job, taskId: string, message: string, options: string | TaskCommentOptions = 'cli'): TaskComment {
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!message.trim()) throw new Error('task comment requires nonempty --message');
  const config = typeof options === 'string' ? { author: options } : options;
  const key = config.idempotencyKey;
  const existing = key && task.comments?.find(comment => comment.idempotencyKey === key);
  if (existing) return existing;
  const comment: TaskComment = {
    id: key ?? randomUUID(), text: message.trim(), author: config.author ?? 'cli', createdAt: new Date().toISOString(),
    jobId: job.id, taskId, ...(config.kind ? { kind: config.kind } : {}),
    ...(config.executionId ? { executionId: config.executionId } : {}),
    ...(config.transition ? { transition: config.transition } : {}), ...(key ? { idempotencyKey: key } : {}),
  };
  task.comments = [...(task.comments ?? []), comment];
  return comment;
}
export function taskCommentContext(task: Task): string {
  if (!task.comments?.length) return '';
  return '\n\n[Task comments — append-only supplementary context]\n' + task.comments.map(c => `${c.createdAt} (${c.author}, ${c.id}): ${c.text}`).join('\n');
}

/** Preserve append-only comments across stale external or lifecycle snapshots. */
export function preserveTaskComments(previous: readonly Task[], incoming: Task[]): Task[] {
  return incoming.map(task => {
    const old = previous.find(item => item.id === task.id);
    if (!old?.comments?.length) return task;
    const comments = [...old.comments], known = new Set(comments.map(comment => comment.id));
    for (const comment of task.comments ?? []) if (!known.has(comment.id)) { comments.push(comment); known.add(comment.id); }
    return { ...task, comments };
  });
}
