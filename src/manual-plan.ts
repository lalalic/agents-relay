import { createPlannerRoundTask, pendingPlanForPlannerTask, recoverPendingPlannerTask } from './planner.js';
import { applyJobActivateAction } from './job-actions.js';
import { DurableStore } from './store.js';
import { Job, Task } from './types.js';

export async function executeManualPlan(
  store: DurableStore,
  jobId: string,
  guidance: string | undefined,
  timeoutMs: number,
  launchPlanner: (job: Job, task: Task) => Promise<void>,
): Promise<{ job: Job; round: Task }> {
  let job = await store.load(jobId);
  if (['COMPLETED', 'CANCELLED'].includes(job.state)) throw new Error(`Cannot plan terminal job ${job.id} (${job.state})`);
  const active = job.tasks.find(task => task.kind === 'planner' && ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state));
  if (active) throw new Error(`Planning round ${active.id} is already ${active.state}`);
  const recovered = recoverPendingPlannerTask(job, timeoutMs);
  const round = recovered ?? createPlannerRoundTask(job, { guidance, manual: true, timeoutMs });
  if (!recovered) await store.appendPlan(pendingPlanForPlannerTask(job, round));
  await store.appendTask(round);
  job = await store.load(jobId);
  if (job.state === 'DRAFT') {
    await applyJobActivateAction(job);
    await store.saveJob(job);
    job = await store.load(jobId);
  }
  const durableRound = job.tasks.find(task => task.id === round.id);
  if (!durableRound) throw new Error(`Planning round ${round.id} was not persisted`);
  await launchPlanner(job, durableRound);
  let completed = await store.load(jobId);
  let completedRound = completed.tasks.find(task => task.id === round.id);
  while (completedRound && ['QUEUED', 'RUNNING'].includes(completedRound.state)) {
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    completed = await store.load(jobId);
    completedRound = completed.tasks.find(task => task.id === round.id);
  }
  if (!completedRound) throw new Error(`Planning round ${round.id} disappeared`);
  if (completedRound.state !== 'SUCCEEDED') throw new Error(completedRound.error ?? `Planning round ${round.id} ended ${completedRound.state}`);
  return { job: completed, round: completedRound };
}
