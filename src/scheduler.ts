import { Job, Task, TaskState, assertJobTransition, assertTaskTransition } from './types.js';
export function dependencyReady(task: Task, tasks: Map<string, Task>): boolean { return task.dependencies.every(id => tasks.get(id)?.state === 'SUCCEEDED'); }
export function detectCycles(tasks: Task[]): void { const map = new Map(tasks.map(t => [t.id, t])); const visiting = new Set<string>(); const done = new Set<string>(); const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`); if (done.has(id)) return; visiting.add(id); for (const dep of map.get(id)?.dependencies ?? []) visit(dep); visiting.delete(id); done.add(id); }; for (const task of tasks) visit(task.id); }
export function completionGateSatisfied(job: Job): boolean {
  if (job.executionMode !== 'autonomous') return true;
  const planners = job.tasks.filter(task => task.kind === 'planner');
  return planners.some(task => task.state === 'SUCCEEDED' && task.plannerResult?.objective_status === 'satisfied') && job.tasks.every(task => task.state === 'SUCCEEDED');
}
export function schedule(job: Job): Job {
  detectCycles(job.tasks);
  if (job.tasks.length === 0) {
    if (job.executionMode === 'autonomous' && job.state !== 'WAITING') { assertJobTransition(job.state, 'WAITING'); job.state = 'WAITING'; job.updatedAt = new Date().toISOString(); }
    return job;
  }
  const map = new Map(job.tasks.map(t => [t.id, t]));
  for (const task of job.tasks) { if (['QUEUED', 'WAITING'].includes(task.state) && dependencyReady(task, map)) { assertTaskTransition(task.state, 'READY'); task.state = 'READY'; task.updatedAt = new Date().toISOString(); } }
  const active = job.tasks.some(t => ['READY', 'RUNNING'].includes(t.state)); const blocked = job.tasks.some(t => t.state === 'BLOCKED'); const waiting = job.tasks.some(t => ['QUEUED', 'WAITING'].includes(t.state)); const failed = job.tasks.some(t => t.state === 'FAILED'); const cancelled = job.tasks.every(t => t.state === 'CANCELLED');
  const next = failed ? 'FAILED' : active ? 'RUNNING' : blocked ? 'BLOCKED' : waiting ? 'WAITING' : cancelled ? 'CANCELLED' : completionGateSatisfied(job) ? 'COMPLETED' : 'WAITING';
  if (job.state !== next) { assertJobTransition(job.state, next); job.state = next; job.updatedAt = new Date().toISOString(); }
  return job;
}
export function extendRetryBudget(task: Pick<Task, 'attempt' | 'maxAttempts'>, windowSize = 3): number {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('Retry window size must be a positive integer');
  const usedOrBudgeted = Math.max(task.maxAttempts, task.attempt);
  return Math.max(windowSize, (Math.floor(usedOrBudgeted / windowSize) + 1) * windowSize);
}
export function transitionTask(task: Task, state: TaskState): void { assertTaskTransition(task.state, state); task.state = state; task.updatedAt = new Date().toISOString(); }
