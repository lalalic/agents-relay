import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import { createPlanRound, pendingPlan } from './planner.js';
import { applyJobActivateAction } from './job-actions.js';
import { DurableStore } from './store.js';
import { Job, Plan } from './types.js';
import { classifyTaskResolution, type TaskResolutionClassification } from './workflow/task-resolution.js';

export async function executeManualPlan(
  store: DurableStore,
  jobId: string,
  guidance: string | undefined,
  timeoutMs: number,
  launchPlanner: (job: Job, plan: Plan) => Promise<void>,
  cleanHistory?: readonly (TaskResolutionClassification & { taskId: string })[],
): Promise<{ job: Job; round: Plan }> {
  let job = await store.load(jobId);
  if (['COMPLETED', 'CANCELLED'].includes(job.state)) throw new Error(`Cannot plan terminal job ${job.id} (${job.state})`);
  if (job.pause) throw new Error(`Cannot plan paused Job ${job.id}; resume it first`);
  const active = pendingPlan(job);
  if (active && active.executionId) throw new Error(`Planning round ${active.id} is already PLANNING`);
  let round = active ?? createPlanRound(job, { guidance, manual: true, timeoutMs });
  if (store.mutateJob) {
    const committed = await store.mutateJob(jobId, current => {
      if (['COMPLETED', 'CANCELLED'].includes(current.state)) throw new Error(`Cannot plan terminal job ${current.id} (${current.state})`);
      if (current.pause) throw new Error(`Cannot plan paused Job ${current.id}; resume it first`);
      const concurrent = pendingPlan(current);
      if (cleanHistory) {
        if (concurrent) throw new Error(`--force-clean-history requires no pending Plan (${concurrent.id})`);
        const failed = current.tasks.filter(task => task.kind !== 'planner' && task.state === 'FAILED' && !task.resolutionClassification);
        const provided = new Map(cleanHistory.map(item => [item.taskId, item]));
        if (provided.size !== cleanHistory.length || failed.length !== provided.size || failed.some(task => !provided.has(task.id))) throw new Error('--force-clean-history requires exactly one explicit classification for every FAILED work Task');
        for (const task of failed) {
          const item = provided.get(task.id)!;
          if (item.targetTaskId === task.id || !current.tasks.some(target => target.id === item.targetTaskId)) throw new Error(`Classification for ${task.id} must target a different durable Task in this Job`);
          classifyTaskResolution(task, item);
        }
        const unknown = current.tasks.filter(task => task.kind !== 'planner' && task.state === 'FAILED' && task.failureReason === 'worker_outcome_unknown');
        if (unknown.length) throw new Error(`--force-clean-history cannot proceed while FAILED Task execution outcomes are unknown: ${unknown.map(task => task.id).join(', ')}`);
      }
      if (concurrent) {
        if (concurrent.executionId) throw new Error(`Planning round ${concurrent.id} is already PLANNING`);
        round = structuredClone(concurrent);
      } else {
        round = createPlanRound(current, { guidance, manual: true, timeoutMs });
        current.plans = [...(current.plans ?? []), structuredClone(round)].sort((a, b) => a.round - b.round);
      }
      if (current.state === 'DRAFT') {
        const activation = dispatchJobLifecycleSync(current, 'activate');
        if (!activation.accepted) throw new Error(`Job ${current.id} activation rejected`);
      }
      return current;
    });
    job = structuredClone(committed);
  } else {
    if (!active) await store.appendPlan(round);
    job = await store.load(jobId);
    if (job.state === 'DRAFT') { await applyJobActivateAction(job); await store.saveJob(job); job = await store.load(jobId); }
  }
  const durableRound = (job.plans ?? []).find(plan => plan.id === round.id);
  if (!durableRound) throw new Error(`Planning round ${round.id} was not persisted`);
  await launchPlanner(job, durableRound);
  let completed = await store.load(jobId);
  let completedRound = (completed.plans ?? []).find(plan => plan.id === round.id);
  while (completedRound?.status === 'PLANNING') {
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    completed = await store.load(jobId);
    completedRound = (completed.plans ?? []).find(plan => plan.id === round.id);
  }
  if (!completedRound) throw new Error(`Planning round ${round.id} disappeared`);
  if (completedRound.status !== 'SUCCEEDED') throw new Error(completedRound.error ?? `Planning round ${round.id} ended ${completedRound.status}`);
  return { job: completed, round: completedRound };
}
