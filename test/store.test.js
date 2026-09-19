import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore, InMemoryStore } from '../dist/store.js';
import { JOB_MARKER, marker, parseJob, parseTask, TASK_MARKER } from '../dist/markers.js';

const now = () => new Date().toISOString();
const task = (jobId, id, state = 'QUEUED') => ({
  jobId,
  id,
  parentTaskId: null,
  dependencies: [],
  capabilities: [],
  adapter: 'shell',
  input: 'true',
  state,
  attempt: 0,
  maxAttempts: 2,
  leaseOwner: null,
  leaseExpiresAt: null,
  executionId: null,
  threadId: null,
  result: null,
  error: null,
  timeoutMs: 1000,
  createdAt: now(),
  updatedAt: now(),
  continuation: null,
  continuationDeliveredAt: null
});
const job = id => ({
  id,
  title: id,
  prNumber: 1,
  repository: 'owner/repo',
  state: 'OPEN',
  continuation: null,
  createdAt: now(),
  updatedAt: now(),
  tasks: undefined
});
const githubComment = (body, login = 'bot', id = Math.floor(Math.random() * 1_000_000) + 100) => ({
  id,
  body,
  updated_at: now(),
  user: { login }
});
const trustedClient = comments => ({
  request: async (path, init = {}) => {
    const method = String(init.method ?? 'GET');
    if (method === 'GET') return comments;
    const requestBody = JSON.parse(String(init.body));
    if (method === 'POST') {
      comments.push(githubComment(requestBody.body));
      return comments.at(-1);
    }
    const id = Number(path.split('/').at(-1));
    const existing = comments.find(item => item.id === id);
    existing.body = requestBody.body;
    return existing;
  }
});
const githubWithComments = comments => new GitHubStore(trustedClient(comments), 'owner/repo', 1, new Set(['bot']));
const memoryWithComments = comments => {
  const store = new InMemoryStore();
  for (const item of comments) {
    const parsedJob = parseJob(item.body);
    if (parsedJob) void store.saveJob(parsedJob);
    const parsedTask = parseTask(item.body);
    if (parsedTask) void store.appendTask(parsedTask);
  }
  return store;
};

test('same task id remains scoped to its job', async () => {
  const shared = 'shared-task';
  const first = task('job-a', shared, 'SUCCEEDED');
  first.result = { summary: 'first job' };
  const second = task('job-b', shared);
  const comments = [
    githubComment(marker(JOB_MARKER, job('job-a'))),
    githubComment(marker(JOB_MARKER, job('job-b'))),
    githubComment(marker(TASK_MARKER, first)),
    githubComment(marker(TASK_MARKER, second))
  ];
  const github = githubWithComments(comments);
  const memory = memoryWithComments(comments);

  assert.deepEqual((await github.load('job-a')).tasks.map(item => item.id), [shared]);
  assert.deepEqual((await memory.load('job-a')).tasks.map(item => item.id), [shared]);
  assert.deepEqual((await github.load('job-b')).tasks.map(item => item.id), [shared]);
  assert.deepEqual((await memory.load('job-b')).tasks.map(item => item.id), [shared]);

  const loaded = await github.load('job-a');
  loaded.tasks[0].state = 'CANCELLED';
  await github.saveTask(loaded.tasks[0]);
  assert.equal((await github.load('job-a')).tasks[0].state, 'CANCELLED');
  assert.equal((await github.load('job-b')).tasks[0].state, 'QUEUED');

  const loadedMemory = await memory.load('job-a');
  loadedMemory.tasks[0].state = 'CANCELLED';
  await memory.saveTask(loadedMemory.tasks[0]);
  assert.equal((await memory.load('job-a')).tasks[0].state, 'CANCELLED');
  assert.equal((await memory.load('job-b')).tasks[0].state, 'QUEUED');

  const updated = comments.find(item => item.body.includes('"jobId":"job-a"') && item.body.includes(shared));
  assert.match(updated.body, /CANCELLED/);
  assert.doesNotMatch(updated.body, /"jobId":"job-b"/);
});

test('legacy tasks join only one trusted job and are never guessed with multiple', async () => {
  const legacyMarker = marker(TASK_MARKER, { ...task('', 'legacy', 'SUCCEEDED'), jobId: undefined });
  const soleJob = [githubComment(marker(JOB_MARKER, job('solo'))), githubComment(legacyMarker)];
  const multipleJobs = [githubComment(marker(JOB_MARKER, job('one'))), githubComment(marker(JOB_MARKER, job('two'))), githubComment(legacyMarker)];
  const soleGithub = githubWithComments(soleJob);
  const soleMemory = memoryWithComments(soleJob);
  const multipleGithub = githubWithComments(multipleJobs);
  const multipleMemory = memoryWithComments(multipleJobs);

  assert.deepEqual((await soleGithub.load('solo')).tasks.map(item => item.id), ['legacy']);
  assert.deepEqual((await soleMemory.load('solo')).tasks.map(item => item.id), ['legacy']);
  assert.deepEqual((await multipleGithub.load('one')).tasks, []);
  assert.deepEqual((await multipleMemory.load('one')).tasks, []);
});

test('job discovery is read-only and an explicit upsert pins the current PR', async () => {
  const comments = [
    githubComment(marker(JOB_MARKER, job('job-a')), 'bot', 10),
    githubComment(marker(TASK_MARKER, task('job-a', 'alpha')), 'bot', 11)
  ];
  const github = githubWithComments(comments);
  assert.deepEqual((await github.listJobs()).map(item => item.id), ['job-a']);
  const requested = { ...job('pinned'), prNumber: 999, repository: 'someone/else', tasks: [] };
  await github.upsertJobForCurrentPr(requested);
  const jobs = await github.listJobs();
  const pinned = jobs.find(item => item.id === 'pinned');
  assert.equal(pinned?.prNumber, 1);
  assert.equal(pinned?.repository, 'owner/repo');
  assert.ok(comments.some(item => item.body.includes('"id":"pinned"')));
});

test('job discovery reads durable jobs across open PRs without writing', async () => {
  const first = githubComment(marker(JOB_MARKER, { ...job('job-a'), prNumber: 1 }), 'bot', 21);
  const second = githubComment(marker(JOB_MARKER, { ...job('job-b'), prNumber: 2 }), 'bot', 22);
  const requests = [];
  const client = {
    request: async (path, init = {}) => {
      requests.push([path, String(init.method ?? 'GET')]);
      if (path.includes('/pulls?')) return [{ number: 1 }, { number: 2 }];
      if (path.includes('/issues/1/comments')) return [first];
      if (path.includes('/issues/2/comments')) return [second];
      throw new Error('unexpected request: ' + path);
    }
  };
  const store = new GitHubStore(client, 'owner/repo', 1, new Set(['bot']));
  assert.deepEqual((await store.listJobs()).map(item => item.id).sort(), ['job-a', 'job-b']);
  assert.equal(requests.every(([, method]) => method === 'GET'), true);
});

test('untrusted task markers are ignored and updates survive a fresh store', async () => {
  const durable = task('job-a', 'durable', 'SUCCEEDED');
  durable.result = { summary: 'durable' };
  const comments = [
    githubComment(marker(JOB_MARKER, job('job-a'))),
    githubComment(marker(TASK_MARKER, durable)),
    githubComment(marker(TASK_MARKER, task('job-a', 'forged')), 'attacker', 999)
  ];
  const github = githubWithComments(comments);
  const memory = memoryWithComments(comments.filter(item => item.user.login === 'bot'));
  const loaded = await github.load('job-a');

  assert.deepEqual(loaded.tasks.map(item => item.id), ['durable']);
  assert.deepEqual((await memory.load('job-a')).tasks.map(item => item.id), ['durable']);
  loaded.tasks[0].result.summary = 'updated';
  await github.saveTask(loaded.tasks[0]);

  const fresh = githubWithComments(comments);
  const reloaded = await fresh.load('job-a');
  assert.equal(reloaded.tasks[0].result.summary, 'updated');
  assert.equal(reloaded.tasks.some(item => item.id === 'forged'), false);
});
