import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore } from '../dist/store.js';
import { JOB_MARKER, marker, parseJob } from '../dist/markers.js';
import {
  bucketStart,
  nextCronRun,
  nextScheduleRun,
  parseJobSchedule,
  parseRunBucketLabel,
  runBucketLabel,
  scheduleBucket,
} from '../dist/scheduler.js';
import {
  AUTONOMOUS_LABEL,
  dueBuckets,
  indexedDueQuery,
  listIndexedScheduledJobs,
  processDueScheduledJobs,
  runScheduledBucket,
} from '../dist/scheduled-jobs.js';

const now = () => new Date().toISOString();
const at = value => new Date(value);
const schedule = (nextRunAt = '2026-09-21T16:20:00Z', overrides = {}) => ({
  cron: '*/10 * * * *',
  timezone: 'UTC',
  nextRunAt,
  missedRunPolicy: 'skip',
  concurrencyPolicy: 'skip',
  lastScheduledSlot: null,
  lastRunAt: null,
  ...overrides,
});
const scheduledJob = (overrides = {}) => ({
  id: 'scheduled',
  title: 'Scheduled objective',
  objective: 'keep the objective current',
  executionMode: 'autonomous',
  schedule: schedule(),
  prNumber: 1,
  repository: 'owner/repo',
  state: 'OPEN',
  continuation: null,
  createdAt: now(),
  updatedAt: now(),
  tasks: [],
  ...overrides,
});

function fakeClient(initialLabels, comments, options = {}) {
  const state = { labels: [...initialLabels], searchQueries: [], searchPR: 1, deleted: [], added: [] };
  const comment = (body, id = 1) => ({ id, body, updated_at: now(), user: { login: 'bot' } });
  const trusted = comments ?? [comment(marker(JOB_MARKER, scheduledJob()))];
  const findComment = (query, variables = {}) => {
    if (query.includes('headRefName baseRefName')) {
      return { repository: { pullRequest: { number: 1, title: 'Scheduled objective', body: '', state: 'OPEN', headRefName: 'feat/scheduled', baseRefName: 'main' } } };
    }
    if (query.includes('comments(last:100)') || query.includes('comments(first:100')) {
      return { repository: { pullRequest: { comments: { nodes: trusted.map(item => ({ id: `IC_${item.id}`, databaseId: item.id, url: `https://github.com/owner/repo/pull/1#issuecomment-${item.id}`, body: item.body, updatedAt: item.updated_at, author: { login: item.user.login } })), pageInfo: { hasNextPage: false, endCursor: null } } } } };
    }
    if (query.includes('pullRequest(number:$number){id state merged mergedAt closedAt}')) {
      return { repository: { pullRequest: { id: 'PR_1', state: 'OPEN', merged: false, mergedAt: null, closedAt: null } } };
    }
    if (query.includes('addComment')) {
      const item = comment(variables.body, trusted.length + 1);
      trusted.push(item);
      return { addComment: { commentEdge: { node: { id: `IC_${item.id}` } } } };
    }
    if (query.includes('updateIssueComment')) {
      const id = Number(String(variables.id).replace('IC_', ''));
      trusted.find(item => item.id === id).body = variables.body;
      return { updateIssueComment: { issueComment: { id: variables.id } } };
    }
    if (query.includes('deleteIssueComment')) {
      const id = Number(String(variables.id).replace('IC_', ''));
      const index = trusted.findIndex(item => item.id === id);
      if (index >= 0) trusted.splice(index, 1);
      return { deleteIssueComment: { clientMutationId: null } };
    }
    throw new Error('Unhandled fake GraphQL query: ' + query);
  };
  return {
    state,
    request: async (path, init = {}) => {
      if (path.startsWith('search/issues?')) {
        const query = new URL(path, 'https://github.com').searchParams.get('q');
        state.searchQueries.push(query);
        const selected = options.alwaysDue ? 1 : Number(new URL(path, 'https://github.com').searchParams.get('q').includes(runBucketLabel('20260921T1620Z')));
        return { items: selected ? [{ number: state.searchPR }] : [] };
      }
      if (path === `repos/owner/repo/issues/1/labels?per_page=100&page=1`) return state.labels.map(label => ({ name: label }));
      if (path.startsWith('repos/owner/repo/labels/') && !init.method) {
        const label = decodeURIComponent(path.split('/').at(-1));
        if (!state.labels.includes(label)) throw new Error('404 Not Found');
        return { name: label };
      }
      if (path === 'repos/owner/repo/labels' && init.method === 'POST') {
        const label = JSON.parse(init.body);
        state.labels.push(label.name);
        state.added.push(label.name);
        return label;
      }
      if (path === `repos/owner/repo/issues/1/labels` && init.method === 'POST') {
        const { labels } = JSON.parse(init.body);
        for (const label of labels) if (!state.labels.includes(label)) state.labels.push(label);
        state.added.push(...labels);
        return labels;
      }
      if (path.startsWith(`repos/owner/repo/issues/1/labels/`) && init.method === 'DELETE') {
        const label = decodeURIComponent(path.split('/').at(-1));
        state.deleted.push(label);
        state.labels = state.labels.filter(item => item !== label);
        return null;
      }
      throw new Error('Unhandled fake REST path: ' + path);
    },
    graphql: async (query, variables = {}) => findComment(query, variables),
  };
}

const engine = counts => ({
  reconcile: async () => { counts.reconciles += 1; },
  idle: async () => {},
});
const trusted = new Set(['bot']);
const store = client => new GitHubStore(client, 'owner/repo', 1, trusted);

test('schedule parsing validates resolution, timezone-aware recurrence, and bucket labels', () => {
  const parsed = parseJobSchedule({ cron: '*/10 * * * *', timezone: 'America/Toronto', nextRunAt: '2026-09-21T09:20:00-04:00' });
  assert.equal(parsed.nextRunAt, '2026-09-21T13:20:00.000Z');
  assert.equal(nextCronRun('0 9 * * *', 'America/Toronto', at('2026-09-21T12:01:00Z')).toISOString(), '2026-09-21T13:00:00.000Z');
  assert.equal(scheduleBucket(at('2026-09-21T16:29:59.999Z')), '20260921T1620Z');
  assert.equal(runBucketLabel('20260921T1620Z'), 'agents-relay:next-run:20260921T1620Z');
  assert.equal(parseRunBucketLabel('agents-relay:next-run:20260921T1620Z'), '20260921T1620Z');
  assert.throws(() => parseJobSchedule({ cron: '*/5 * * * *', timezone: 'UTC' }), /10-minute/);
  assert.throws(() => parseJobSchedule({ cron: '*/10 * * * *', timezone: 'Not/AZone' }), /timezone/);
});

test('indexed discovery queries buckets without enumerating managed jobs', async () => {
  const client = fakeClient([AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')]);
  const due = await listIndexedScheduledJobs(client, 'owner/repo', trusted, dueBuckets(at('2026-09-21T16:31:00Z'), 3));
  assert.deepEqual(due, [{ prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }]);
  assert.deepEqual(client.state.searchQueries.map(query => query.endsWith('label:"agents-relay:next-run:20260921T1610Z"')), [true, false, false]);
  assert.match(indexedDueQuery('owner/repo', '20260921T1620Z'), /repo:owner\/repo is:open is:pr/);
});

test('a duplicate heartbeat cannot claim the same scheduled slot twice', async () => {
  const client = fakeClient([AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')]);
  const counts = { reconciles: 0 };
  const first = await runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine(counts), at('2026-09-21T16:31:00Z'));
  assert.equal(first.status, 'completed');
  const second = await runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine(counts), at('2026-09-21T16:32:00Z'));
  assert.equal(second.status, 'skipped-idempotent');
  assert.equal(counts.reconciles, 1);
  const durable = await store(client).load('scheduled');
  assert.equal(durable.schedule.lastScheduledSlot, '2026-09-21T16:20:00.000Z');
  assert.equal(durable.schedule.nextRunAt, '2026-09-21T16:40:00.000Z');
  assert.equal(durable.schedule.lastRunAt, '2026-09-21T16:31:00.000Z');
  assert.deepEqual(client.state.labels, [AUTONOMOUS_LABEL, runBucketLabel('20260921T1640Z')]);
});

test('processDueScheduledJobs is idempotent when GitHub search still returns the old bucket', async () => {
  const client = fakeClient([AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')], undefined, { alwaysDue: true });
  const counts = { reconciles: 0 };
  const first = await processDueScheduledJobs({
    client,
    repository: 'owner/repo',
    trustedAuthors: trusted,
    buckets: ['20260921T1620Z', '20260921T1630Z'],
    now: at('2026-09-21T16:31:00Z'),
    engine: () => engine(counts),
  });
  const second = await processDueScheduledJobs({
    client,
    repository: 'owner/repo',
    trustedAuthors: trusted,
    buckets: ['20260921T1620Z'],
    now: at('2026-09-21T16:31:01Z'),
    engine: () => engine(counts),
  });
  assert.deepEqual(first.map(result => result.status), ['completed']);
  assert.deepEqual(second.map(result => result.status), ['skipped-idempotent']);
  assert.equal(counts.reconciles, 1);
});

test('missed-run policy controls whether skipped slots are advanced or replayed', async () => {
  const runJob = scheduledJob({ schedule: schedule('2026-09-21T16:20:00Z', { missedRunPolicy: 'run' }) });
  const runClient = fakeClient([AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')], [comment(marker(JOB_MARKER, runJob))]);
  const runResult = await runScheduledBucket(runClient, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine({ reconciles: 0 }), at('2026-09-21T16:31:00Z'));
  const runDurable = await store(runClient).load('scheduled');
  const replaySchedule = runResult.job.schedule;
  assert.equal(runResult.status, 'completed');
  assert.equal(replaySchedule.missedRunPolicy, 'run');
  assert.equal(runDurable.schedule.nextRunAt, '2026-09-21T16:30:00.000Z');

  const skipClient = fakeClient([AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')]);
  const skipResult = await runScheduledBucket(skipClient, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine({ reconciles: 0 }), at('2026-09-21T16:31:00Z'));
  const skipDurable = await store(skipClient).load('scheduled');
  assert.equal(skipResult.status, 'completed');
  assert.equal(skipDurable.schedule.nextRunAt, '2026-09-21T16:40:00.000Z');
  assert.equal(runDurable.schedule.lastRunAt, '2026-09-21T16:31:00.000Z');
});

test('active scheduled work can skip a slot while retaining durable concurrency metadata', async () => {
  const activeJob = scheduledJob({ state: 'RUNNING' });
  const client = fakeClient([AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')], [comment(marker(JOB_MARKER, activeJob))]);
  const counts = { reconciles: 0 };
  const result = await runScheduledBucket(client, 'owner/repo', trusted, { prNumber: 1, jobId: 'scheduled', bucket: '20260921T1620Z' }, engine(counts), at('2026-09-21T16:31:00Z'));
  assert.equal(result.status, 'skipped-active');
  assert.equal(counts.reconciles, 0);
  const durable = await store(client).load('scheduled');
  assert.equal(durable.schedule.nextRunAt, '2026-09-21T16:40:00.000Z');
});

test('schedule metadata round-trips through the trusted job marker', async () => {
  const job = scheduledJob();
  const parsed = parseJob(marker(JOB_MARKER, job));
  assert.deepEqual(parsed.schedule, job.schedule);
  assert.equal(bucketStart(at('2026-09-21T16:20:00Z')).getTime(), Date.parse('2026-09-21T16:20:00Z'));
});

test('managed scheduled creation persists metadata and initializes the label index', async () => {
  const client = fakeClient([]);
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const result = await ensureManagedGitHubJob(client, 'owner/repo', trusted, {
    id: 'scheduled',
    prNumber: 1,
    executionMode: 'autonomous',
    schedule: schedule(),
  });
  assert.equal(result.job.schedule.nextRunAt, '2026-09-21T16:20:00Z');
  assert.deepEqual(client.state.labels, [AUTONOMOUS_LABEL, runBucketLabel('20260921T1620Z')]);
});

function comment(body, id = 1) {
  return { id, body, updated_at: now(), user: { login: 'bot' } };
}
