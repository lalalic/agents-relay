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
