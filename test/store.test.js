import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardManagedJobs, GitHubStore, InMemoryStore } from '../dist/store.js';
import { AGENT_MARKER, JOB_MARKER, marker, parseAgent, parseJob, parseTask, TASK_MARKER } from '../dist/markers.js';

test('marker parser tolerates Mermaid arrows inside JSON string values', () => {
  const description = 'mermaid\\nflowchart TD\\nA --> B';
  const body = marker(JOB_MARKER, { id: 'mermaid-job', title: 'Mermaid', description, tasks: undefined });
  const parsed = parseJob(body);
  assert.equal(parsed?.id, 'mermaid-job');
  assert.equal(parsed?.description, description);
});

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

class ManagedGitHubClient {
  constructor(pulls = []) {
    this.pulls = pulls;
    this.comments = new Map();
    this.nextPr = Math.max(0, ...pulls.map(item => item.number)) + 1;
    this.nextComment = 1;
  }
  pulls;
  comments;
  nextPr;
  nextComment;
  async request(path, init = {}) {
    const method = String(init.method ?? 'GET');
    if (path.includes('/pulls?')) return this.pulls.filter(item => item.state === 'open');
    const pullMatch = path.match(/\/pulls\/(\d+)$/);
    if (method === 'GET' && pullMatch) return this.pulls.find(item => item.number === Number(pullMatch[1]));
    if (method === 'POST' && path.endsWith('/pulls')) {
      const body = JSON.parse(String(init.body));
      const pull = { number: this.nextPr++, title: body.title, body: body.body, state: 'open', head: { ref: body.head }, base: { ref: body.base } };
      this.pulls.push(pull);
      return pull;
    }
    const commentsMatch = path.match(/\/issues\/(\d+)\/comments/);
    if (method === 'GET' && commentsMatch) return this.comments.get(Number(commentsMatch[1])) ?? [];
    if (method === 'POST' && commentsMatch) {
      const pr = Number(commentsMatch[1]);
      const values = this.comments.get(pr) ?? [];
      const body = JSON.parse(String(init.body));
      const comment = githubComment(body.body, 'bot', this.nextComment++);
      values.push(comment);
      this.comments.set(pr, values);
      return comment;
    }
    const commentMatch = path.match(/\/issues\/comments\/(\d+)$/);
    if (commentMatch) {
      const id = Number(commentMatch[1]);
      for (const values of this.comments.values()) {
        const index = values.findIndex(item => item.id === id);
        if (index < 0) continue;
        if (method === 'DELETE') { values.splice(index, 1); return null; }
        const body = JSON.parse(String(init.body));
        values[index].body = body.body;
        return values[index];
      }
    }
    throw new Error('Unhandled fake GitHub request: ' + method + ' ' + path);
  }
}

test('managed job creation creates one PR and one durable job marker idempotently', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const client = new ManagedGitHubClient();
  const trusted = new Set(['bot']);
  const options = { id: 'managed', title: 'Managed work', head: 'feat/managed', base: 'main', body: 'body' };

  const first = await ensureManagedGitHubJob(client, 'owner/repo', trusted, options);
  const second = await ensureManagedGitHubJob(client, 'owner/repo', trusted, options);

  assert.equal(first.pr.number, second.pr.number);
  assert.equal(first.job.description, 'body');
  assert.equal(second.job.description, 'body');
  assert.equal(client.pulls.length, 1);
  const comments = client.comments.get(first.pr.number) ?? [];
  assert.equal(comments.filter(item => parseJob(item.body)?.id === 'managed').length, 1);
});

test('dashboard keeps every unfinished job and only the latest ten completed jobs', () => {
  const overview = (id, state, completedAt) => ({ job: { ...job(id), state, prNumber: Number(id.replace('job-', '')) }, githubState: completedAt ? 'MERGED' : 'OPEN', draft: id === 'job-99', mergedAt: completedAt, closedAt: null });
  const unfinished = [overview('job-1', 'OPEN', null), overview('job-2', 'FAILED', null)];
  const completed = Array.from({ length: 12 }, (_, index) => overview(`job-${index + 10}`, 'COMPLETED', `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`));
  const result = dashboardManagedJobs([...completed, ...unfinished]);
  assert.deepEqual(result.slice(0, 2).map(item => item.job.id), ['job-1', 'job-2']);
  assert.equal(result.length, 12);
  assert.deepEqual(result.slice(2).map(item => item.job.id), ['job-21', 'job-20', 'job-19', 'job-18', 'job-17', 'job-16', 'job-15', 'job-14', 'job-13', 'job-12']);
  assert.equal(result.some(item => item.job.id === 'job-10'), false);
});

test('managed job adoption initializes an existing PR with zero comments', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: '', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  const result = await ensureManagedGitHubJob(client, 'owner/repo', new Set(['bot']), { id: 'adopted', prNumber: 6 });

  assert.equal(result.pr.number, 6);
  assert.equal(client.pulls.length, 1);
  assert.equal((client.comments.get(6) ?? []).filter(item => parseJob(item.body)?.id === 'adopted').length, 1);
});

test('managed job repair removes duplicate markers without creating another', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: '', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  const duplicate = marker(JOB_MARKER, job('repair'));
  client.comments.set(6, [githubComment(duplicate, 'bot', 1), githubComment(duplicate, 'bot', 2)]);
  client.nextComment = 3;

  await ensureManagedGitHubJob(client, 'owner/repo', new Set(['bot']), { id: 'repair', prNumber: 6 });

  assert.equal((client.comments.get(6) ?? []).filter(item => parseJob(item.body)?.id === 'repair').length, 1);
});

test('managed GitHub task submission is gated on a durable job marker', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: '', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));

  await assert.rejects(() => store.load('gated'), /has no durable agents-relay:job:v1 marker/);
  await assert.rejects(() => store.appendTask(task('gated', 'child')), /has no durable agents-relay:job:v1 marker/);
  await ensureManagedGitHubJob(client, 'owner/repo', new Set(['bot']), { id: 'gated', prNumber: 6 });
  const durable = await store.load('gated');
  await store.appendTask(task(durable.id, 'child'));

  const comments = client.comments.get(6) ?? [];
  const jobIndex = comments.findIndex(item => parseJob(item.body)?.id === 'gated');
  const taskIndex = comments.findIndex(item => parseTask(item.body)?.id === 'child');
  assert.ok(jobIndex >= 0);
  assert.ok(taskIndex > jobIndex);
});

test('agent registrations persist through trusted stores and ignore forged markers', async () => {
  const agent = { id:'researcher', name:'Researcher', responsibility:'public research', role:'researcher', capabilities:['research'], boundaries:['no credentials'], endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{trustDomains:['public']}, evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null}, registeredAt:now(), updatedAt:now() };
  const comments = [githubComment(marker(JOB_MARKER, job('job-a'))), githubComment(marker(AGENT_MARKER, agent)), githubComment(marker(AGENT_MARKER, {...agent, id:'forged'}), 'attacker', 1001)];
  const store = githubWithComments(comments);
  assert.deepEqual((await store.listAgents()).map(item => item.id), ['researcher']);
  agent.availability = 'degraded';
  await store.saveAgent(agent);
  const fresh = githubWithComments(comments);
  assert.equal((await fresh.listAgents())[0].availability, 'degraded');
  assert.equal(parseAgent(comments[1].body).id, 'researcher');
});


test('task append is idempotent by job id and task id and rejects conflicting replay', async () => {
  const durableJob = job('idem');
  const comments = [githubComment(marker(JOB_MARKER, durableJob), 'bot', 1)];
  const store = githubWithComments(comments);
  const first = task('idem', 'child');
  first.capabilities = ['coding'];
  await store.appendTask(first);
  const replay = { ...first, createdAt: now(), updatedAt: now() };
  await store.appendTask(replay);
  assert.equal(comments.filter(item => parseTask(item.body)?.id === 'child').length, 1);

  const conflict = { ...replay, input: 'different work' };
  await assert.rejects(() => store.appendTask(conflict), /different definition/);
  assert.equal(comments.filter(item => parseTask(item.body)?.id === 'child').length, 1);
});

test('saveTask collapses duplicate durable markers for one job and task id', async () => {
  const durableJob = job('dedupe');
  const child = task('dedupe', 'child');
  const comments = [
    githubComment(marker(JOB_MARKER, durableJob), 'bot', 1),
    githubComment(marker(TASK_MARKER, child), 'bot', 2),
    githubComment(marker(TASK_MARKER, child), 'bot', 3)
  ];
  const client = new ManagedGitHubClient([{ number: 6, title: 'Existing', body: '', state: 'open', head: { ref: 'feat/existing' }, base: { ref: 'main' } }]);
  client.comments.set(6, comments);
  client.nextComment = 4;
  const store = new GitHubStore(client, 'owner/repo', 6, new Set(['bot']));
  child.state = 'RUNNING';
  await store.saveTask(child);
  assert.equal((client.comments.get(6) ?? []).filter(item => parseTask(item.body)?.id === 'child').length, 1);
  assert.equal((await store.load('dedupe')).tasks[0].state, 'RUNNING');
});

test('managed job creation bootstraps an empty head branch after GitHub no-commits 422', async () => {
  const { ensureManagedGitHubJob } = await import('../dist/cli.js');
  const calls = [];
  let bootstrapped = false;
  let pr = null;
  const comments = [];
  const client = {
    currentLogin: async () => 'bot',
    request: async (path, init = {}) => {
      const method = String(init.method ?? 'GET');
      calls.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : null });
      if (path.includes('/pulls?')) return pr ? [pr] : [];
      if (method === 'POST' && path.endsWith('/pulls')) {
        if (!bootstrapped) throw new Error('gh: Validation Failed (HTTP 422)');
        const body = JSON.parse(String(init.body));
        pr = { number: 7, title: body.title, body: body.body, state: 'open', head: { ref: body.head }, base: { ref: body.base } };
        return pr;
      }
      if (path.includes('/compare/main...feat/empty')) return { ahead_by: 0 };
      if (path.endsWith('/git/ref/heads/feat/empty')) return { object: { sha: 'parent' } };
      if (path.endsWith('/git/commits/parent')) return { tree: { sha: 'tree' } };
      if (method === 'POST' && path.endsWith('/git/commits')) return { sha: 'bootstrap' };
      if (method === 'PATCH' && path.endsWith('/git/refs/heads/feat/empty')) { bootstrapped = true; return { object: { sha: 'bootstrap' } }; }
      if (method === 'GET' && path.includes('/issues/7/comments')) return comments;
      if (method === 'POST' && path.includes('/issues/7/comments')) {
        const body = JSON.parse(String(init.body));
        const comment = githubComment(body.body, 'bot', comments.length + 1);
        comments.push(comment);
        return comment;
      }
      if (method === 'PATCH' && path.includes('/issues/comments/')) {
        const id = Number(path.split('/').at(-1));
        const row = comments.find(item => item.id === id);
        row.body = JSON.parse(String(init.body)).body;
        return row;
      }
      throw new Error('Unhandled fake request: ' + method + ' ' + path);
    }
  };

  const result = await ensureManagedGitHubJob(client, 'owner/repo', new Set(['bot']), {
    id: 'empty-job', title: 'Empty branch work', head: 'feat/empty', base: 'main', body: 'body'
  });

  assert.equal(result.pr.number, 7);
  assert.equal(bootstrapped, true);
  assert.equal(calls.filter(item => item.path.endsWith('/git/commits') && item.method === 'POST').length, 1);
  assert.equal(comments.filter(item => parseJob(item.body)?.id === 'empty-job').length, 1);
});
