import type { Job, Task } from '../types.js';
import { dispatchJobLifecycleSync, dispatchTaskLifecycleSync } from './lifecycle.js';

export type NewTask = Omit<Task, 'state'>;
export type NewJob = Omit<Job, 'state'>;

function dependenciesSatisfied(job: Job, dependencies: readonly string[]): boolean {
  if (dependencies.length === 0) return true;
  const byId = new Map(job.tasks.map(task => [task.id, task]));
  return dependencies.every(id => byId.get(id)?.state === 'SUCCEEDED');
}

function validateTaskRequirements(value: NewTask): void {
  if (value.adapter === 'orchestrator') {
    throw new Error('New Tasks cannot use the Relay-internal orchestrator adapter; declare worker requirements and let Execution Router select the route');
  }
  if (value.workerRequirements && !Array.isArray(value.workerRequirements.capabilities)) {
    throw new Error(`Task ${value.id} workerRequirements.capabilities must be an array`);
  }
}

/**
 * Canonical creation boundary for new Task entities.
 * Constructors provide metadata/facts only; the Task lifecycle graph derives
 * whether a fresh Task remains DRAFT or becomes QUEUED.
 */
export function createTaskEntity(job: Job, value: NewTask, options: { defer?: boolean } = {}): Task {
  validateTaskRequirements(value);
  const task: Task = { ...value, state: 'DRAFT' };
  if (!options.defer) {
    dispatchTaskLifecycleSync(task as Task & Record<string, unknown>, 'reconcile', {
      dependenciesSatisfied: dependenciesSatisfied(job, task.dependencies),
    });
  }
  return task;
}

/**
 * Canonical creation boundary for new Job entities.
 * New Jobs begin at the graph initial state and scheduled creation is expressed
 * as the normal activate lifecycle event.
 */
export function createJobEntity(value: NewJob, options: { activate?: boolean } = {}): Job {
  const job: Job = { ...value, state: 'DRAFT' };
  if (options.activate) dispatchJobLifecycleSync(job, 'activate');
  return job;
}
