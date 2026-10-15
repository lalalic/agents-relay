import type { Job, Task } from '../types.js';
import { dispatchTaskLifecycleSync } from './lifecycle.js';
import type { WorkflowContext } from './mermaid.js';

export function dependencyReady(task: Task, tasks: Map<string, Task>): boolean {
  return task.dependencies.every(id => tasks.get(id)?.state === 'SUCCEEDED');
}

export function detectCycles(tasks: Task[]): void {
  const map = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set<string>();
  const done = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`);
    if (done.has(id)) return;
    visiting.add(id);
    for (const dependency of map.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    done.add(id);
  };
  for (const task of tasks) visit(task.id);
}

function scheduledCycleTasks(job: Job): Task[] {
  const slot = job.schedule?.currentRunSlot ? Date.parse(job.schedule.currentRunSlot) : Number.NaN;
  if (!Number.isFinite(slot)) return job.tasks;
  return job.tasks.filter(task => Date.parse(task.createdAt) >= slot);
}

export function reconcileTaskDependencies(job: Job): Job {
  detectCycles(job.tasks);
  const scopedTasks = scheduledCycleTasks(job);
  const tasks = new Map(job.tasks.map(task => [task.id, task]));
  for (const task of scopedTasks) {
    if (task.kind === 'planner') continue;
    if (task.state === 'DRAFT' && task.unblock) continue;
    const ready = dependencyReady(task, tasks);
    const facts: WorkflowContext = {
      dependenciesSatisfied: task.dependencies.length > 0 && ready,
      dependenciesUnsatisfied: task.dependencies.length > 0 && !ready,
      runnable: ready,
    };
    const from = task.state;
    const decision = dispatchTaskLifecycleSync(task as Task & Record<string, unknown>, 'reconcile', facts);
    if (decision.reason === 'ambiguous') throw new Error(`Ambiguous automatic task transition from ${from}`);
  }
  return job;
}
