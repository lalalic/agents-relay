import { randomUUID } from 'node:crypto';
import type { Job, Task } from './types.js';

export type TaskComment = { id: string; text: string; author: string; createdAt: string };
export function appendTaskComment(job: Job, taskId: string, message: string, author = 'cli'): TaskComment {
  const task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (!message.trim()) throw new Error('task comment requires nonempty --message');
  const comment = { id: randomUUID(), text: message.trim(), author, createdAt: new Date().toISOString() };
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
