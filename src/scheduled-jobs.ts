import { GitHubClient, GitHubStore } from './store.js';
import { Job } from './types.js';
import { nextScheduleRun, scheduleBucket } from './scheduler.js';

export type ScheduledJobRef = { prNumber: number; jobId: string; bucket: string };
export type ScheduledRunStatus = 'completed' | 'skipped-idempotent' | 'skipped-active';
export type ScheduledRunResult = { job: Job; status: ScheduledRunStatus };
export type SchedulerEngine = { reconcile(jobId: string): Promise<unknown>; idle(): Promise<void> };

async function refresh(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>, ref: ScheduledJobRef): Promise<Job> {
  const store = new GitHubStore(client, repository, ref.prNumber, trustedAuthors);
  return await store.load(ref.jobId);
}

export async function runScheduledBucket(
  client: GitHubClient,
  repository: string,
  trustedAuthors: ReadonlySet<string>,
  ref: ScheduledJobRef,
  engine?: SchedulerEngine,
  now: Date = new Date(),
): Promise<ScheduledRunResult> {
  let job = await refresh(client, repository, trustedAuthors, ref);
  const schedule = job.schedule;
  if (!schedule) throw new Error(`Scheduled job ${job.id} has no schedule metadata`);
  const slot = new Date(schedule.nextRunAt);
  if (scheduleBucket(slot) !== ref.bucket || slot.getTime() > now.getTime()) {
    return { job, status: 'skipped-idempotent' };
  }
  if (schedule.lastScheduledSlot && new Date(schedule.lastScheduledSlot).getTime() >= slot.getTime()) {
    return { job, status: 'skipped-idempotent' };
  }

  if (job.state !== 'ACTIVE') return { job, status: 'skipped-idempotent' };
  const active = job.tasks.some(task => ['QUEUED', 'RUNNING'].includes(task.state));
  if (active && schedule.concurrencyPolicy === 'skip') {
    schedule.lastScheduledSlot = slot.toISOString();
    schedule.nextRunAt = nextScheduleRun(schedule, now).toISOString();
    job.updatedAt = now.toISOString();
    await new GitHubStore(client, repository, ref.prNumber, trustedAuthors).saveJob(job);
    return { job, status: 'skipped-active' };
  }
  if (active && schedule.concurrencyPolicy === 'queue') {
    return { job, status: 'skipped-active' };
  }

  const missedRunPolicy = schedule.missedRunPolicy;
  schedule.lastScheduledSlot = slot.toISOString();
  schedule.currentRunSlot = slot.toISOString();
  schedule.nextRunAt = nextScheduleRun(schedule, missedRunPolicy === 'run' ? slot : now).toISOString();
  job.updatedAt = now.toISOString();
  const schedulerStore = new GitHubStore(client, repository, ref.prNumber, trustedAuthors);
  await schedulerStore.saveJob(job);
  job = await schedulerStore.load(job.id);
  if (!engine) throw new Error('Scheduled jobs require the local relayd scheduler engine');
  await engine.reconcile(job.id);
  await engine.idle();
  const finished = await schedulerStore.load(job.id);
  if (!finished.schedule) throw new Error(`Scheduled job ${job.id} lost its schedule metadata`);
  finished.schedule.lastRunAt = now.toISOString();
  finished.updatedAt = now.toISOString();
  await schedulerStore.saveJob(finished);
  return { job: finished, status: 'completed' };
}
