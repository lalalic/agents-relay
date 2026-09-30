import { GitHubClient, GitHubStore, type DurableStore } from './store.js';
import { Job } from './types.js';
import { nextScheduleRun, scheduleBucket } from './scheduler.js';
import { dispatchScheduledRun } from './workflow/scheduled-run-v2.js';

export type ScheduledJobRef = { prNumber: number; jobId: string; bucket: string };
export type ScheduledRunStatus = 'completed' | 'skipped-idempotent' | 'skipped-active';
export type ScheduledRunResult = { job: Job; status: ScheduledRunStatus };
export type SchedulerEngine = { reconcile(jobId: string): Promise<unknown>; idle(): Promise<void> };

async function refresh(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>, ref: ScheduledJobRef, storeFactory?: () => DurableStore): Promise<Job> {
  const store = storeFactory ? storeFactory() : new GitHubStore(client, repository, ref.prNumber, trustedAuthors);
  return await store.load(ref.jobId);
}

export async function runScheduledBucket(
  client: GitHubClient,
  repository: string,
  trustedAuthors: ReadonlySet<string>,
  ref: ScheduledJobRef,
  engine?: SchedulerEngine,
  now: Date = new Date(),
  storeFactory?: () => DurableStore,
): Promise<ScheduledRunResult> {
  let job = await refresh(client, repository, trustedAuthors, ref, storeFactory);
  const schedule = job.schedule;
  if (!schedule) throw new Error('Scheduled job ' + job.id + ' has no schedule metadata');
  const slot = new Date(schedule.nextRunAt);
  const active = job.tasks.some(task => ['QUEUED', 'RUNNING'].includes(task.state));
  const schedulerStore = storeFactory ? storeFactory() : new GitHubStore(client, repository, ref.prNumber, trustedAuthors);
  let actionStatus: ScheduledRunStatus | null = null;
  const decision = await dispatchScheduledRun({
    slotDue: scheduleBucket(slot) === ref.bucket && slot.getTime() <= now.getTime(),
    slotUnclaimed: !schedule.lastScheduledSlot || new Date(schedule.lastScheduledSlot).getTime() < slot.getTime(),
    jobActive: job.state === 'ACTIVE', hasActiveTasks: active,
    concurrencySkip: schedule.concurrencyPolicy === 'skip', concurrencyQueue: schedule.concurrencyPolicy === 'queue',
    runMissed: schedule.missedRunPolicy === 'run',
  }, async actionId => {
    if (actionId === 'schedule.skipActiveAdvance') {
      schedule.lastScheduledSlot = slot.toISOString(); schedule.nextRunAt = nextScheduleRun(schedule, now).toISOString();
      job.updatedAt = now.toISOString(); await schedulerStore.saveJob(job); actionStatus = 'skipped-active'; return {};
    }
    if (actionId === 'schedule.claimFromSlot' || actionId === 'schedule.claimFromNow') {
      schedule.lastScheduledSlot = slot.toISOString(); schedule.currentRunSlot = slot.toISOString();
      schedule.nextRunAt = nextScheduleRun(schedule, actionId === 'schedule.claimFromSlot' ? slot : now).toISOString();
      job.updatedAt = now.toISOString(); await schedulerStore.saveJob(job); job = await schedulerStore.load(job.id); return {};
    }
    throw new Error('Unsupported schedule graph action ' + actionId);
  });
  if (!decision.accepted || decision.target === 'skip_idempotent') return { job, status: 'skipped-idempotent' };
  if (actionStatus === 'skipped-active' || decision.target === 'skip_active') return { job, status: 'skipped-active' };
  if (decision.target !== 'claimed') return { job, status: 'skipped-idempotent' };
  if (!engine) throw new Error('Scheduled jobs require the local relayd scheduler engine');
  await engine.reconcile(job.id);
  await engine.idle();
  const finished = await schedulerStore.load(job.id);
  if (!finished.schedule) throw new Error('Scheduled job ' + job.id + ' lost its schedule metadata');
  finished.schedule.lastRunAt = now.toISOString();
  finished.updatedAt = now.toISOString();
  await schedulerStore.saveJob(finished);
  return { job: finished, status: 'completed' };
}
