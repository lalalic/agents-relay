import type { DurableStore } from './store.js';
import type { BlockedBaseline, Job, JobChangeCycle, Task, TaskUnblockRecord } from './types.js';
import { extendRetryBudget, transitionTaskEvent } from './scheduler.js';

export type UnblockSource = { source: 'cli' | 'blocker_job'; reason: string; blockerJobId?: string; resolution?: 'merge' | 'verified' };

export function isEffectivelyBlocked(task: Task): boolean { return task.kind !== 'planner' && task.state === 'BLOCKED' && !task.unblock; }

function baselineFor(task: Task): BlockedBaseline {
  return task.blockedBaseline ?? { blockedAt: task.updatedAt, reason: task.error ?? undefined };
}

function cycleFacts(job: Job, tasks: Task[], currentHeadSha: string | null, reason: string): string[] {
  const facts = [`unblock: ${reason}`];
  const baselines = tasks.map(task => baselineFor(task));
  const heads = [...new Set(baselines.map(item => item.headSha).filter((item): item is string => Boolean(item)))];
  if (currentHeadSha && heads.some(head => head !== currentHeadSha)) facts.push(`PR head advanced from ${heads.join(', ')} to ${currentHeadSha}`);
  const times = baselines.map(item => Date.parse(item.blockedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const earliest = times[0];
  if (earliest !== undefined) {
    for (const task of job.tasks) {
      if (tasks.some(item => item.id === task.id)) continue;
      const changedAt = Date.parse(task.updatedAt);
      if (!Number.isFinite(changedAt) || changedAt < earliest) continue;
      const detail = task.result?.summary ?? task.error ?? task.state;
      facts.push(`task ${task.id} -> ${task.state}: ${detail}`);
    }
  }
  return [...new Set(facts)];
}

export async function unblockAutonomousTasks(options: { store: DurableStore; job: Job; tasks: Task[]; trigger: UnblockSource; now?: string }): Promise<JobChangeCycle> {
  const { store, job, trigger } = options;
  const tasks = options.tasks.filter(isEffectivelyBlocked);
  if (tasks.length === 0) throw new Error('No effective BLOCKED work task is available to unblock');
  const now = options.now ?? new Date().toISOString();
  const currentHeadSha = await store.headSha?.() ?? job.headSha ?? null;
  for (const task of tasks) {
    const baseline = baselineFor(task);
    const record: TaskUnblockRecord = { at: now, source: trigger.source, reason: trigger.reason, baseline, currentHeadSha: currentHeadSha ?? undefined, blockerJobId: trigger.blockerJobId, resolution: trigger.resolution };
    task.blockedBaseline = baseline;
    task.unblock = record;
    task.updatedAt = now;
    delete task.blockedBy;
    await store.saveTask(task);
  }
  const baselineHeadShas = [...new Set(tasks.map(task => baselineFor(task).headSha).filter((item): item is string => Boolean(item)))];
  const cycle: JobChangeCycle = { triggeredAt: now, source: trigger.source, reason: trigger.reason, taskIds: tasks.map(task => task.id), baselineHeadShas, currentHeadSha: currentHeadSha ?? undefined, facts: cycleFacts(job, tasks, currentHeadSha, trigger.reason) };
  job.changeCycle = cycle;
  job.updatedAt = now;
  await store.saveJob(job);
  return cycle;
}

export async function unblockTask(options: { store: DurableStore; job: Job; task: Task; trigger: UnblockSource; now?: string }): Promise<{ replanning: boolean; changeCycle?: JobChangeCycle }> {
  if (!isEffectivelyBlocked(options.task)) throw new Error(`Task ${options.task.id} is not an effective BLOCKED work task`);
  if (options.job.executionMode === 'autonomous') {
    const changeCycle = await unblockAutonomousTasks({ store: options.store, job: options.job, tasks: [options.task], trigger: options.trigger, now: options.now });
    return { replanning: true, changeCycle };
  }
  options.task.maxAttempts = extendRetryBudget(options.task);
  await transitionTaskEvent(options.task, 'retry');
  options.task.error = null;
  options.task.leaseOwner = null; options.task.leaseExpiresAt = null; options.task.executionId = null;
  options.task.updatedAt = options.now ?? new Date().toISOString();
  delete options.task.blockedBy;
  await options.store.saveTask(options.task);
  return { replanning: false };
}

export function consumeChangeCycle(job: Job, plannerTaskId: string, now = new Date().toISOString()): boolean {
  if (!job.changeCycle || job.changeCycle.consumedByPlannerTaskId) return false;
  job.changeCycle.consumedByPlannerTaskId = plannerTaskId;
  job.updatedAt = now;
  return true;
}
