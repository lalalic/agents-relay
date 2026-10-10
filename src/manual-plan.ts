import { createPlanRound, pendingPlan } from './planner.js';
import { applyJobActivateAction } from './job-actions.js';
import { DurableStore } from './store.js';
import { Job, Plan } from './types.js';

export async function executeManualPlan(
  store: DurableStore,
  jobId: string,
  guidance: string | undefined,
  timeoutMs: number,
  launchPlanner: (job: Job, plan: Plan) => Promise<void>,
): Promise<{ job: Job; round: Plan }> {
  let job = await store.load(jobId);
  if (['COMPLETED', 'CANCELLED'].includes(job.state)) throw new Error(`Cannot plan terminal job ${job.id} (${job.state})`);
  const active = pendingPlan(job);
  if (active && active.executionId) throw new Error(`Planning round ${active.id} is already PLANNING`);
  const round = active ?? createPlanRound(job, { guidance, manual: true, timeoutMs });
  if (!active && store.mutateJob) {
    const committed = await store.mutateJob(jobId, current => {
      if (['COMPLETED', 'CANCELLED'].includes(current.state)) throw new Error(`Cannot plan terminal job ${current.id} (${current.state})`);
      current.plans = [...(current.plans ?? []), structuredClone(round)].sort((a, b) => a.round - b.round);
      if (current.state === 'DRAFT') applyJobActivateAction(current);
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
