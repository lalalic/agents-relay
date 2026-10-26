import type { DurableStore } from './store.js';
import type { BlockedBaseline, Job, PlanTrigger, Task, TaskUnblockRecord } from './types.js';
import { applyTaskUnblockRetrySnapshot } from './task-actions.js';
import { tryTransitionTaskEvent } from './task-transitions.js';
import { dispatchAuthoritativeUnblock } from './workflow/authoritative-unblock-v2.js';
import { hasPendingTroubleshooterEscalation } from './task-recovery.js';

export type UnblockSource = { source: 'cli' | 'blocker_job'; reason: string; blockerJobId?: string; resolution?: 'merge' | 'verified' };

export function isEffectivelyBlocked(task: Task): boolean { return task.kind !== 'planner' && task.agentName === 'troubleshooter' && task.state === 'BLOCKED'; }
function assertNoPendingHumanEscalation(tasks: Task[]): void {
  if (tasks.some(task => task.agentName === 'troubleshooter' && task.escalation?.status === 'pending')) throw new Error('Blocked Troubleshooter requires an authorized human response; use task unblock --response');
}

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
  const consumed = new Set((job.plans ?? []).filter(plan => plan.status === 'SUCCEEDED').flatMap(plan => plan.trigger?.source === 'unblock' ? plan.trigger.taskIds ?? [] : []));
  const tasks = job.tasks.filter(task => task.agentName !== 'troubleshooter' && task.unblock && !consumed.has(task.id) && ['DRAFT', 'QUEUED'].includes(task.state));
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

/** A failed Planner round keeps the unblock pending, but must not spin up endless rounds. */
export function unblockNeedsNewPlan(job: Job): boolean {
  const pending = unconsumedUnblockTrigger(job);
  if (!pending) return false;
  const latest = job.plans?.at(-1);
  return !(latest?.status === 'FAILED' && latest.trigger?.source === 'unblock'
    && latest.trigger?.taskIds?.some(id => pending.taskIds?.includes(id)));
}

export async function unblockTask(options: { store: DurableStore; job: Job; task: Task; trigger: UnblockSource; now?: string }): Promise<{ replanning: boolean; planTrigger?: PlanTrigger }> {
  if (!isEffectivelyBlocked(options.task)) throw new Error(`Task ${options.task.id} is not an effective BLOCKED work task`);
  assertNoPendingHumanEscalation([options.task]);
  if (options.task.agentName !== 'troubleshooter' && hasPendingTroubleshooterEscalation(options.job, options.task)) {
    throw new Error(`Task ${options.task.id} cannot be directly unblocked while its Troubleshooter is awaiting human action`);
  }
  let result: { replanning: boolean; planTrigger?: PlanTrigger } | undefined;
  const decision = await dispatchAuthoritativeUnblock(options.task.agentName === 'troubleshooter', async actionId => {
    if (actionId === 'unblock.retry') {
      const now = options.now ?? new Date().toISOString();
      const currentHeadSha = await options.store.headSha?.() ?? options.job.headSha ?? null;
      const baseline = baselineFor(options.task); options.task.blockedBaseline = baseline;
      const facts = unblockFacts(options.job, [options.task], currentHeadSha, options.trigger.reason);
      options.task.unblock = { event: 'task.unblocked', at: now, source: options.trigger.source, reason: options.trigger.reason, baseline, currentHeadSha: currentHeadSha ?? undefined, facts, blockerJobId: options.trigger.blockerJobId, resolution: options.trigger.resolution };
      const apply = (current: Job): void => {
        const task = current.tasks.find(item => item.id === options.task.id);
        if (!task || !isEffectivelyBlocked(task)) throw new Error(`Task ${options.task.id} changed before authoritative unblock`);
        if (!tryTransitionTaskEvent(task, 'task.unblocked', {}).accepted) throw new Error(`Task ${task.id} cannot be authoritatively unblocked`);
        const baseline = baselineFor(task); task.blockedBaseline = baseline;
        task.unblock = { event: 'task.unblocked', at: now, source: options.trigger.source, reason: options.trigger.reason, baseline, currentHeadSha: currentHeadSha ?? undefined, facts, blockerJobId: options.trigger.blockerJobId, resolution: options.trigger.resolution };
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
