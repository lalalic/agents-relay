import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { transitionTaskEvent } from './scheduler.js';

export type ExecutionRecoveryPorts = {
  store: DurableStore;
  owner: string;
  cancelGeneration(task: Task): void;
  cancelPlanner(taskId: string): void;
  emitFailed(task: Task, reason: 'lease_expired' | 'startup_orphaned'): Promise<void>;
};

async function currentGeneration(store: DurableStore, job: Job, stale: Task): Promise<Task | null> {
  const task = (await store.load(job.id)).tasks.find(item => item.id === stale.id);
  if (!task) return null;
  const sameGeneration = task.executionId === stale.executionId && task.leaseOwner === stale.leaseOwner && task.leaseExpiresAt === stale.leaseExpiresAt;
  return sameGeneration ? task : null;
}

async function recoverTask(task: Task, event: 'lease.expired' | 'execution.orphaned', reason: 'lease_expired' | 'startup_orphaned', ports: ExecutionRecoveryPorts): Promise<void> {
  ports.cancelGeneration(task);
  ports.cancelPlanner(task.id);
  const decision = await transitionTaskEvent(task, event, { retryAvailable: task.attempt < task.maxAttempts });
  await ports.store.saveTask(task);
  if (decision.target === 'FAILED') await ports.emitFailed(task, reason);
}

export async function recoverExpiredExecutions(job: Job, now: number, ports: ExecutionRecoveryPorts): Promise<void> {
  const candidates = job.tasks.filter(item => item.kind !== 'planner' && (item.state === 'RUNNING' || (item.state === 'QUEUED' && item.executionId !== null)));
  for (const stale of candidates) {
    if (stale.leaseExpiresAt === null || new Date(stale.leaseExpiresAt).getTime() > now) continue;
    const task = await currentGeneration(ports.store, job, stale);
    const recoverable = task && (task.state === 'RUNNING' || (task.state === 'QUEUED' && task.executionId !== null));
    if (!recoverable || task.leaseExpiresAt === null || new Date(task.leaseExpiresAt).getTime() > now) continue;
    await recoverTask(task, 'lease.expired', 'lease_expired', ports);
  }
}

export async function recoverStartupOrphans(job: Job, ports: ExecutionRecoveryPorts): Promise<void> {
  const candidates = job.tasks.filter(task => task.kind !== 'planner' && (task.state === 'RUNNING' || task.state === 'QUEUED') && task.executionId && task.leaseOwner && task.leaseOwner !== ports.owner && task.adapter !== 'chatgpt');
  for (const stale of candidates) {
    const task = await currentGeneration(ports.store, job, stale);
    if (!task || !['RUNNING', 'QUEUED'].includes(task.state) || task.adapter === 'chatgpt' || !task.executionId || !task.leaseOwner || task.leaseOwner === ports.owner) continue;
    await recoverTask(task, 'execution.orphaned', 'startup_orphaned', ports);
  }
}
