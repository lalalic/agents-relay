import type { DurableStore } from './store.js';
import type { BlockedBaseline, Job, PlanTrigger, Task, TaskUnblockRecord } from './types.js';
import { applyTaskUnblockRetrySnapshot } from './task-actions.js';
import { tryTransitionTaskEvent } from './scheduler.js';
import { dispatchAuthoritativeUnblock } from './workflow/authoritative-unblock-v2.js';

export type UnblockSource = { source: 'cli' | 'blocker_job'; reason: string; blockerJobId?: string; resolution?: 'merge' | 'verified' };

export function isEffectivelyBlocked(task: Task): boolean { return task.kind !== 'planner' && task.state === 'BLOCKED'; }

function baselineFor(task: Task): BlockedBaseline {
  return task.blockedBaseline ?? { blockedAt: task.updatedAt, reason: task.error ?? undefined };
}

function unblockFacts(job: Job, tasks: Task[], currentHeadSha: string | null, reason: string): string[] {
  const facts = [`unblock: ${reason}`];
  const baselines = tasks.map(task => baselineFor(task));
  const heads = [...new Set(baselines.map(item => item.headSha).filter((item): item is string => Boolean(item)))];
  if (currentHeadSha && heads.some(head => head !== currentHeadSha)) facts.push(`PR head advanced from ${heads.join(', ')} to ${currentHeadSha}`);
  const times = baselines.map(item => Date.parse(item.blockedAt)).filter(Number.isFinite).sort((a, b) => a - b);
  const earliest = times[0];
  if (earliest !== undefined) for (const task of job.tasks) {
    if (tasks.some(item => item.id === task.id)) continue;
    const changedAt = Date.parse(task.updatedAt);
    if (!Number.isFinite(changedAt) || changedAt < earliest) continue;
    const detail = task.result?.summary ?? task.error ?? task.state;
    facts.push(`task ${task.id} -> ${task.state}: ${detail}`);
  }
  return [...new Set(facts)];
}

export function unconsumedUnblockTrigger(job: Job): PlanTrigger | undefined {
  const consumed = new Set((job.plans ?? []).flatMap(plan => plan.trigger.source === 'unblock' ? plan.trigger.taskIds ?? [] : []));
  const tasks = job.tasks.filter(task => task.state === 'UNBLOCKED' && task.unblock && !consumed.has(task.id));
  if (tasks.length === 0) {
    const legacy = job.changeCycle;
    if (!legacy || legacy.consumedByPlannerTaskId) return undefined;
    return { source: 'unblock', taskIds: legacy.taskIds, reason: legacy.reason, facts: legacy.facts, blockedHeadShas: legacy.baselineHeadShas, currentHeadSha: legacy.currentHeadSha, unblockSource: legacy.source };
  }
  const records = tasks.map(task => task.unblock as TaskUnblockRecord);
  return {
    source: 'unblock',
    taskIds: tasks.map(task => task.id),
    reason: [...new Set(records.map(item => item.reason))].join('; '),
    facts: [...new Set(records.flatMap(item => item.facts ?? [`unblock: ${item.reason}`]))],
    blockedHeadShas: [...new Set(records.map(item => item.baseline.headSha).filter((item): item is string => Boolean(item)))],
    currentHeadSha: records.map(item => item.currentHeadSha).find((item): item is string => Boolean(item)),
    unblockSource: records[0].source,
  };
}

export async function unblockAutonomousTasks(options: { store: DurableStore; job: Job; tasks: Task[]; trigger: UnblockSource; now?: string }): Promise<PlanTrigger> {
  const { store, job, trigger } = options;
  const tasks = options.tasks.filter(isEffectivelyBlocked);
  if (tasks.length === 0) throw new Error('No effective BLOCKED work task is available to unblock');
  const now = options.now ?? new Date().toISOString();
  const currentHeadSha = await store.headSha?.() ?? job.headSha ?? null;
  const facts = unblockFacts(job, tasks, currentHeadSha, trigger.reason);
  const apply = (current: Job): void => {
    for (const requested of tasks) {
      const task = current.tasks.find(item => item.id === requested.id);
      if (!task || !isEffectivelyBlocked(task)) throw new Error(`Task ${requested.id} changed before authoritative unblock`);
      const baseline = baselineFor(task);
      if (!tryTransitionTaskEvent(task, 'task.unblocked').accepted) throw new Error(`Task ${task.id} cannot be authoritatively unblocked`);
      task.blockedBaseline = baseline;
      task.unblock = { at: now, source: trigger.source, reason: trigger.reason, baseline, currentHeadSha: currentHeadSha ?? undefined, facts, blockerJobId: trigger.blockerJobId, resolution: trigger.resolution };
      task.updatedAt = now;
      delete task.blockedBy;
    }
    current.updatedAt = now;
  };
  if (store.mutateJob) {
    const committed = await store.mutateJob(job.id, current => { apply(current); return current; });
    Object.assign(job, structuredClone(committed));
  } else {
    apply(job);
    for (const task of tasks) await store.saveTask(task);
  }
  const planTrigger = unconsumedUnblockTrigger(job) ?? {
    source: 'unblock' as const, taskIds: tasks.map(task => task.id), reason: trigger.reason,
    facts, currentHeadSha: currentHeadSha ?? undefined, unblockSource: trigger.source,
  };
  return planTrigger;
}

export async function unblockTask(options: { store: DurableStore; job: Job; task: Task; trigger: UnblockSource; now?: string }): Promise<{ replanning: boolean; planTrigger?: PlanTrigger }> {
  if (!isEffectivelyBlocked(options.task)) throw new Error(`Task ${options.task.id} is not an effective BLOCKED work task`);
  let result: { replanning: boolean; planTrigger?: PlanTrigger } | undefined;
  const decision = await dispatchAuthoritativeUnblock(options.job.executionMode === 'autonomous', async actionId => {
    if (actionId === 'unblock.replan') {
      result = { replanning: true, planTrigger: await unblockAutonomousTasks({ store: options.store, job: options.job, tasks: [options.task], trigger: options.trigger, now: options.now }) };
      return {};
    }
    if (actionId === 'unblock.retry') {
      const now = options.now ?? new Date().toISOString();
      const currentHeadSha = await options.store.headSha?.() ?? options.job.headSha ?? null;
      const baseline = baselineFor(options.task); options.task.blockedBaseline = baseline;
      const facts = unblockFacts(options.job, [options.task], currentHeadSha, options.trigger.reason);
      options.task.unblock = { at: now, source: options.trigger.source, reason: options.trigger.reason, baseline, currentHeadSha: currentHeadSha ?? undefined, facts, blockerJobId: options.trigger.blockerJobId, resolution: options.trigger.resolution };
      const apply = (current: Job): void => {
        const task = current.tasks.find(item => item.id === options.task.id);
        if (!task || !isEffectivelyBlocked(task)) throw new Error(`Task ${options.task.id} changed before authoritative unblock`);
        if (!tryTransitionTaskEvent(task, 'task.unblocked').accepted) throw new Error(`Task ${task.id} cannot be authoritatively unblocked`);
        const baseline = baselineFor(task); task.blockedBaseline = baseline;
        task.unblock = { at: now, source: options.trigger.source, reason: options.trigger.reason, baseline, currentHeadSha: currentHeadSha ?? undefined, facts, blockerJobId: options.trigger.blockerJobId, resolution: options.trigger.resolution };
        applyTaskUnblockRetrySnapshot(task); task.updatedAt = now; delete task.blockedBy; current.updatedAt = now;
      };
      if (options.store.mutateJob) { const committed = await options.store.mutateJob(options.job.id, current => { apply(current); return current; }); Object.assign(options.job, structuredClone(committed)); }
      else { apply(options.job); await options.store.saveTask(options.task); }
      result = { replanning: false }; return {};
    }
    throw new Error('Unsupported authoritative unblock action ' + actionId);
  });
  if (!decision.accepted) throw new Error('Authoritative unblock graph rejected task.authoritative_unblock');
  if (!result) throw new Error('Authoritative unblock graph completed without an action result');
  return result;
}
