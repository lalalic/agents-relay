import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { JOB_MARKER, marker, parseJob } from '../dist/markers.js';
import { bucketStart, nextCronRun, parseJobSchedule, scheduleBucket } from '../dist/scheduler.js';
import { runScheduledBucketFromStore } from '../dist/scheduled-jobs.js';
import { InMemoryStore } from '../dist/store.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const now = () => new Date().toISOString();
const at = value => new Date(value);
const schedule = (nextRunAt = '2026-09-21T16:20:00Z', overrides = {}) => ({
  cron: '*/10 * * * *', timezone: 'UTC', nextRunAt,
  missedRunPolicy: 'skip', concurrencyPolicy: 'skip',
  lastScheduledSlot: null, currentRunSlot: null, lastRunAt: null, ...overrides,
});
const scheduledJob = (overrides = {}) => ({
  id: 'scheduled', title: 'Scheduled objective', objective: 'keep the objective current',
  executionMode: 'autonomous', schedule: schedule(), prNumber: 1, repository: 'owner/repo',
  state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(), tasks: [], ...overrides,
});
const engine = counts => ({ reconcile: async () => { counts.reconciles += 1; }, idle: async () => {} });

test('schedule parsing validates resolution and timezone-aware recurrence', () => {
  const parsed = parseJobSchedule({ cron: '*/10 * * * *', timezone: 'America/Toronto', nextRunAt: '2026-09-21T09:20:00-04:00' });
  assert.equal(parsed.nextRunAt, '2026-09-21T13:20:00.000Z');
  assert.equal(nextCronRun('0 9 * * *', 'America/Toronto', at('2026-09-21T12:01:00Z')).toISOString(), '2026-09-21T13:00:00.000Z');
  assert.equal(scheduleBucket(at('2026-09-21T16:29:59.999Z')), '20260921T1620Z');
  assert.equal(nextCronRun('10/20 * * * *', 'UTC', at('2026-09-21T16:01:00Z')).toISOString(), '2026-09-21T16:10:00.000Z');
  assert.throws(() => parseJobSchedule({ cron: '*/5 * * * *', timezone: 'UTC' }), /10-minute/);
  assert.throws(() => parseJobSchedule({ cron: '*/10 * * * *', timezone: 'Not\/AZone' }), /timezone/);
});

test('local scheduler requires an engine, never GitHub', async () => {
  const local = new InMemoryStore(scheduledJob());
  await assert.rejects(() => runScheduledBucketFromStore(local, {jobId:'scheduled',bucket:'20260921T1620Z'}, undefined, at('2026-09-21T16:31:00Z')), /reconcile|undefined/);
});

test('duplicate local heartbeat does not claim the same slot twice', async () => {
  const local = new InMemoryStore(scheduledJob());
  const counts = { reconciles: 0 };
  const ref = {jobId:'scheduled',bucket:'20260921T1620Z'};
  const first = await runScheduledBucketFromStore(local,ref,engine(counts),at('2026-09-21T16:31:00Z'));
  const second = await runScheduledBucketFromStore(local,ref,engine(counts),at('2026-09-21T16:32:00Z'));
  assert.equal(first.status,'completed');
  assert.equal(second.status,'skipped-idempotent');
  assert.equal(counts.reconciles,1);
  assert.equal((await local.load('scheduled')).schedule.lastScheduledSlot,'2026-09-21T16:20:00.000Z');
});

test('missed run policy is local only', async () => {
  for (const policy of ['run','skip']) {
    const local = new InMemoryStore(scheduledJob({schedule:schedule('2026-09-21T16:20:00Z',{missedRunPolicy:policy})}));
    const result = await runScheduledBucketFromStore(local,{jobId:'scheduled',bucket:'20260921T1620Z'},engine({reconciles:0}),at('2026-09-21T16:31:00Z'));
    assert.equal(result.status,'completed');
  }
});

test('active scheduled work skips a slot without any external side effect', async () => {
  const local=new InMemoryStore(scheduledJob({tasks:[{id:'active',state:'RUNNING'}]}));
  const result=await runScheduledBucketFromStore(local,{jobId:'scheduled',bucket:'20260921T1620Z'},engine({reconciles:0}),at('2026-09-21T16:31:00Z'));
  assert.equal(result.status,'skipped-active');
});

test('schedule metadata round-trips through the trusted job marker', () => {
  const job = scheduledJob();
  assert.deepEqual(parseJob(marker(JOB_MARKER, job)).schedule, job.schedule);
  assert.equal(bucketStart(at('2026-09-21T16:20:00Z')).getTime(), Date.parse('2026-09-21T16:20:00Z'));
});

test('scheduled Job creation persists to local SQLite without GitHub API', async () => {
  const directory=await mkdtemp(join(tmpdir(),'relay-scheduled-create-'));
  try {
    let githubCalls=0;
    const client={request:async()=>{githubCalls++;throw Error('GitHub forbidden');},
      graphql:async()=>{githubCalls++;throw Error('GitHub forbidden');}};
    const { ensureManagedGitHubJob } = await import('../dist/cli.js');
    const { SQLiteRelayStore, relayJobStorePath } = await import('../dist/relay-store.js');
    const result = await ensureManagedGitHubJob(client, 'owner/repo', new Set(), {
      idempotencyKey:'scheduled',executionMode:'autonomous',schedule:schedule(),storeDirectory:directory,
    });
    assert.equal(result.job.prNumber,0);
    assert.equal(result.job.schedule.nextRunAt,'2026-09-21T16:20:00Z');
    assert.equal(githubCalls,0);
    const sqlite = new SQLiteRelayStore(relayJobStorePath(directory,result.job.id));
    assert.equal((await sqlite.loadJob(result.job.id)).schedule.nextRunAt,'2026-09-21T16:20:00Z');
    sqlite.close();
  } finally {await rm(directory,{recursive:true,force:true});}
});
