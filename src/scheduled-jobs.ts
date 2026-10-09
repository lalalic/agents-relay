import type { DurableStore } from './store.js';
import type { Job } from './types.js';
import { nextScheduleRun, scheduleBucket } from './scheduler.js';
import { dispatchScheduledRun } from './workflow/scheduled-run-v2.js';

export type ScheduledRunStatus = 'completed' | 'skipped-idempotent' | 'skipped-active';
export type ScheduledRunResult = { job: Job; status: ScheduledRunStatus };
export type SchedulerEngine = { reconcile(jobId: string): Promise<unknown>; idle(): Promise<void> };

/** Local-first schedule entrypoint: immutable Job ID selects the SQLite store. */
export async function runScheduledBucketFromStore(
  store: DurableStore,
  ref: { jobId: string; bucket: string },
  engine: SchedulerEngine,
  now = new Date(),
): Promise<ScheduledRunResult> {
  // SQLite authority provides an atomic claim. The fallback retains the
  // existing in-memory test adapter, but cannot be used for production claims.
  if (store.claimScheduledSlot) {
    if (!store.finishScheduledSlot) throw new Error('Atomic scheduled completion is required');
    const claimed = await store.claimScheduledSlot(ref.jobId, ref.bucket, now);
    if (claimed.status !== 'completed') return claimed;
    const slot = claimed.job.schedule?.currentRunSlot;
    if (!slot) throw new Error('Claimed schedule slot missing durable currentRunSlot');
    await engine.reconcile(ref.jobId);
    await engine.idle();
    const job = await store.finishScheduledSlot(ref.jobId, slot, now);
    return { job, status: 'completed' };
  }
  let job = await store.load(ref.jobId);
  if (!job.schedule) throw new Error('Scheduled job ' + job.id + ' has no schedule metadata');
  const schedule = job.schedule;
  const slot = new Date(schedule.nextRunAt);
  const active = job.tasks.some(task => ['QUEUED', 'RUNNING'].includes(task.state));
  let claimed = false;
  let status: ScheduledRunStatus = 'skipped-idempotent';
  const decision = await dispatchScheduledRun({
    slotDue: scheduleBucket(slot) === ref.bucket && slot.getTime() <= now.getTime(),
    slotUnclaimed: !schedule.lastScheduledSlot || new Date(schedule.lastScheduledSlot).getTime() < slot.getTime(),
    jobActive: job.state === 'ACTIVE', hasActiveTasks: active,
    concurrencySkip: schedule.concurrencyPolicy === 'skip', concurrencyQueue: schedule.concurrencyPolicy === 'queue',
    runMissed: schedule.missedRunPolicy === 'run',
  }, async actionId => {
    if (actionId === 'schedule.skipActiveAdvance') {
      schedule.lastScheduledSlot = slot.toISOString();
      schedule.nextRunAt = nextScheduleRun(schedule, now).toISOString();
      status = 'skipped-active';
    } else if (actionId === 'schedule.claimFromSlot' || actionId === 'schedule.claimFromNow') {
      schedule.lastScheduledSlot = slot.toISOString();
      schedule.currentRunSlot = slot.toISOString();
      schedule.nextRunAt = nextScheduleRun(schedule, actionId === 'schedule.claimFromSlot' ? slot : now).toISOString();
      claimed = true;
      status = 'completed';
    } else throw new Error('Unknown local schedule action: ' + actionId);
    job.updatedAt = now.toISOString();
    await store.saveJob(job);
    return {};
  });
  if (!decision.accepted || !claimed) return { job, status };
  await engine.reconcile(job.id);
  await engine.idle();
  job = await store.load(job.id);
  if (!job.schedule) throw new Error('Scheduled job lost schedule metadata');
  job.schedule.lastRunAt = now.toISOString();
  // A claim and its completion can share the same wall-clock timestamp.
  // Advance the snapshot revision to satisfy SQLite's stale-write guard.
  job.updatedAt = new Date(Math.max(now.getTime(), Date.parse(job.updatedAt) + 1)).toISOString();
  await store.saveJob(job);
  return { job, status: 'completed' };
}
