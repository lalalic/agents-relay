import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { GitHubStore } from '../dist/store.js';
import { JOB_MARKER, TASK_MARKER, marker, parseJob } from '../dist/markers.js';
import { bucketStart, nextCronRun, parseJobSchedule, scheduleBucket } from '../dist/scheduler.js';
import { runScheduledBucket } from '../dist/scheduled-jobs.js';

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
function comment(body, id = 1) { return { id, body, updated_at: now(), user: { login: 'bot' } }; }
function fakeClient(comments) {
  const trusted = comments ?? [comment(marker(JOB_MARKER, scheduledJob()))];
  const state = { prBody: '', restPaths: [] };
  const findComment = (query, variables = {}) => {
    if (query.includes('headRefName baseRefName')) return { repository: { pullRequest: { number: 1, title: 'Scheduled objective', body: '', state: 'OPEN', headRefName: 'feat/scheduled', baseRefName: 'main' } } };
    if (query.includes('comments(last:100)') || query.includes('comments(first:100')) return { repository: { pullRequest: { comments: { nodes: trusted.map(item => ({ id: `IC_${item.id}`, databaseId: item.id, url: `https://github.com/owner/repo/pull/1#issuecomment-${item.id}`, body: item.body, updatedAt: item.updated_at, author: { login: item.user.login } })), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt')) return { repository: { pullRequest: { id: 'PR_1', state: 'OPEN', merged: false, mergedAt: null, closedAt: null, body: state.prBody } } };
    if (query.includes('addComment')) { const item = comment(variables.body, trusted.length + 1); trusted.push(item); return { addComment: { commentEdge: { node: { id: `IC_${item.id}` } } } }; }
    if (query.includes('updateIssueComment')) { const id = Number(String(variables.id).replace('IC_', '')); trusted.find(item => item.id === id).body = variables.body; return { updateIssueComment: { issueComment: { id: variables.id } } }; }
    if (query.includes('deleteIssueComment')) { const id = Number(String(variables.id).replace('IC_', '')); const index = trusted.findIndex(item => item.id === id); if (index >= 0) trusted.splice(index, 1); return { deleteIssueComment: { clientMutationId: null } }; }
    throw new Error('Unhandled fake GraphQL query: ' + query);
  };
  return {
    state,
    request: async (path, init = {}) => {
      state.restPaths.push(path);
      if (path === 'repos/owner/repo/pulls/1' && init.method === 'PATCH') { state.prBody = JSON.parse(String(init.body)).body; return { body: state.prBody }; }
      throw new Error('Unhandled fake REST path: ' + path);
    },
    graphql: async (query, variables = {}) => findComment(query, variables),
  };
}
const engine = counts => ({ reconcile: async () => { counts.reconciles += 1; }, idle: async () => {} });
const trusted = new Set(['bot']);
const store = client => new GitHubStore(client, 'owner/repo', 1, trusted);

test('schedule parsing validates resolution and timezone-aware recurrence', () => {
  const parsed = parseJobSchedule({ cron: '*/10 * * * *', timezone: 'America/Toronto', nextRunAt: '2026-09-21T09:20:00-04:00' });
  assert.equal(parsed.nextRunAt, '2026-09-21T13:20:00.000Z');
  assert.equal(nextCronRun('0 9 * * *', 'America/Toronto', at('2026-09-21T12:01:00Z')).toISOString(), '2026-09-21T13:00:00.000Z');
  assert.equal(scheduleBucket(at('2026-09-21T16:29:59.999Z')), '20260921T1620Z');
  assert.equal(nextCronRun('10/20 * * * *', 'UTC', at('2026-09-21T16:01:00Z')).toISOString(), '2026-09-21T16:10:00.000Z');
  assert.throws(() => parseJobSchedule({ cron: '*/5 * * * *', timezone: 'UTC' }), /10-minute/);
  assert.throws(() => parseJobSchedule({ cron: '*/10 * * * *', timezone: 'Not\/AZone' }), /timezone/);
});

test('local scheduler requires relayd engine and never falls back to cloud dispatch', async () => {
  const client = fakeClient();
  await assert.rejects(() => runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, undefined, at('2026-09-21T16:31:00Z')), /local relayd scheduler engine/);
  assert.ok(client.state.restPaths.every(path => !path.includes('/comments') && !path.startsWith('search/issues')));
});

test('duplicate local heartbeat cannot claim the same scheduled slot twice', async () => {
  const client = fakeClient();
  const counts = { reconciles: 0 };
  const first = await runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine(counts), at('2026-09-21T16:31:00Z'));
  const second = await runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine(counts), at('2026-09-21T16:32:00Z'));
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'skipped-idempotent');
  assert.equal(counts.reconciles, 1);
  const durable = await store(client).load('scheduled');
  assert.equal(durable.schedule.lastScheduledSlot, '2026-09-21T16:20:00.000Z');
  assert.equal(durable.schedule.nextRunAt, '2026-09-21T16:40:00.000Z');
  assert.equal(durable.schedule.lastRunAt, '2026-09-21T16:31:00.000Z');
});

test('missed-run policy controls whether due slots advance from slot or current time', async () => {
  const runJob = scheduledJob({ schedule: schedule('2026-09-21T16:20:00Z', { missedRunPolicy: 'run' }) });
  const runClient = fakeClient([comment(marker(JOB_MARKER, runJob))]);
  await runScheduledBucket(runClient, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine({ reconciles: 0 }), at('2026-09-21T16:31:00Z'));
  assert.equal((await store(runClient).load('scheduled')).schedule.nextRunAt, '2026-09-21T16:30:00.000Z');

  const skipClient = fakeClient();
  await runScheduledBucket(skipClient, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine({ reconciles: 0 }), at('2026-09-21T16:31:00Z'));
  assert.equal((await store(skipClient).load('scheduled')).schedule.nextRunAt, '2026-09-21T16:40:00.000Z');
});

test('active scheduled work can skip a slot without cloud wake side effects', async () => {
  const activeTask = { jobId:'scheduled', id:'active', kind:'work', parentTaskId:null, dependencies:[], capabilities:[], adapter:'orchestrator', input:'active', state:'RUNNING', attempt:1, maxAttempts:3, leaseOwner:null, leaseExpiresAt:null, executionId:null, threadId:null, result:null, error:null, timeoutMs:0, createdAt:now(), updatedAt:now(), continuation:null, continuationDeliveredAt:null };
  const client = fakeClient([comment(marker(JOB_MARKER, scheduledJob())), comment(marker(TASK_MARKER, activeTask), 2)]);
  const counts = { reconciles: 0 };
  const result = await runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine(counts), at('2026-09-21T16:31:00Z'));
  assert.equal(result.status, 'skipped-active');
  assert.equal(counts.reconciles, 0);
  assert.equal((await store(client).load('scheduled')).schedule.nextRunAt, '2026-09-21T16:40:00.000Z');
  assert.ok(client.state.restPaths.every(path => !path.includes('/comments') && !path.startsWith('search/issues')));
});

test('schedule metadata round-trips through the trusted job marker', () => {
  const job = scheduledJob();
  assert.deepEqual(parseJob(marker(JOB_MARKER, job)).schedule, job.schedule);
  assert.equal(bucketStart(at('2026-09-21T16:20:00Z')).getTime(), Date.parse('2026-09-21T16:20:00Z'));
});

test('managed scheduled creation persists metadata without scheduler labels', async () => {
  const client = fakeClient();
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const result = await ensureManagedGitHubJob(client, 'owner/repo', trusted, { id: 'scheduled', prNumber: 1, executionMode: 'autonomous', schedule: schedule() });
  assert.equal(result.job.schedule.nextRunAt, '2026-09-21T16:20:00Z');
  assert.ok(client.state.restPaths.every(path => !path.includes('/labels')));
});
