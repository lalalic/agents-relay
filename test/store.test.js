import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubStore, InMemoryStore } from '../dist/store.js';
import { AGENT_MARKER, AGENT_REGISTRY_MARKER, JOB_MARKER, marker, parseAgentRegistry, parseJob, parseTask, TASK_MARKER } from '../dist/markers.js';

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


class RegistryGitHubClient {
  constructor() {
    this.issues = new Map();
    this.comments = new Map();
    this.nextIssue = 20;
    this.nextComment = 200;
  }
  issues;
  comments;
  nextIssue;
  nextComment;
  seedIssue(repository, body, login = 'bot') {
    const number = this.nextIssue++;
    const values = this.issues.get(repository) ?? [];
    values.push({ number, body, state: 'open', user: { login } });
    this.issues.set(repository, values);
    return number;
  }
  seedComment(repository, issue, body, login = 'bot') {
    const key = repository + '#' + issue;
    const values = this.comments.get(key) ?? [];
    const value = githubComment(body, login, this.nextComment++);
    values.push(value);
    this.comments.set(key, values);
    return value;
  }
}
RegistryGitHubClient.prototype.request = async function(path, init = {}) {
  const method = String(init.method ?? 'GET');
  const issueList = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\?state=all/);
  if (method === 'GET' && issueList) return this.issues.get(issueList[1]) ?? [];
  const repoComments = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\?/);
  if (method === 'GET' && repoComments) {
    const prefix = repoComments[1] + '#';
    return [...this.comments.entries()].filter(([key]) => key.startsWith(prefix)).flatMap(([, values]) => values);
  }
  const issueComments = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments/);
  if (issueComments) {
    const repository = issueComments[1];
    const issue = Number(issueComments[2]);
    const key = repository + '#' + issue;
    if (method === 'GET') return this.comments.get(key) ?? [];
    if (method === 'POST') {
      const body = JSON.parse(String(init.body));
      return this.seedComment(repository, issue, body.body);
    }
  }
  const createIssue = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/);
  if (method === 'POST' && createIssue) {
    const repository = createIssue[1];
    const body = JSON.parse(String(init.body));
    const number = this.seedIssue(repository, body.body);
    return { number, body: body.body, state: 'open', user: { login: 'bot' } };
  }
  const patchComment = path.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/comments\/(\d+)$/);
  if (method === 'PATCH' && patchComment) {
    const repository = patchComment[1];
    const id = Number(patchComment[2]);
    const body = JSON.parse(String(init.body));
    for (const [key, values] of this.comments.entries()) {
      if (!key.startsWith(repository + '#')) continue;
      const existing = values.find(item => item.id === id);
      if (existing) { existing.body = body.body; return existing; }
    }
  }
  throw new Error('Unhandled registry GitHub request: ' + method + ' ' + path);
};

const registryAgent = id => ({
  id, name:id, responsibility:'work', role:'worker', capabilities:['typescript'], boundaries:[],
  endpoint:{kind:'adapter',target:'codex'}, runtime:{adapter:'codex'}, availability:'available', routing:{},
  evidence:{evaluations:[],outcomes:{succeeded:0,failed:0,timedOut:0},lastObservedAt:null},
  registeredAt:now(), updatedAt:now()
});

test('repository registry is shared across PR stores and keeps legacy PR agents readable', async () => {
  const client = new RegistryGitHubClient();
  const trusted = new Set(['bot']);
  const legacyIssue = client.seedIssue('owner/repo', 'legacy PR');
  client.seedComment('owner/repo', legacyIssue, marker(AGENT_MARKER, registryAgent('legacy')));

  const first = new GitHubStore(client, 'owner/repo', 1, trusted);
  await first.saveAgent(registryAgent('shared'));
  const second = new GitHubStore(client, 'owner/repo', 9, trusted);

  assert.deepEqual((await second.listAgents()).map(item => item.id).sort(), ['legacy', 'shared']);
  const registries = (client.issues.get('owner/repo') ?? []).filter(item => parseAgentRegistry(item.body)?.scope === 'repository');
  assert.equal(registries.length, 1);

  const updated = registryAgent('shared');
  updated.availability = 'degraded';
  updated.evidence = {
    evaluations:[{jobId:'job-9',taskId:'task-1',executionId:'exec-1',attempt:1,taskKind:'typescript',capabilities:['typescript'],outcome:'success',observedAt:now(),version:'gpt-5.6',latencyMs:123,cost:0.2}],
    outcomes:{succeeded:1,failed:0,timedOut:0},
    lastObservedAt:now()
  };
  await second.saveAgent(updated);
  const persisted=(await new GitHubStore(client, 'owner/repo', 3, trusted).listAgents()).find(item => item.id === 'shared');
  assert.equal(persisted.availability, 'degraded');
  assert.deepEqual(persisted.capabilities,['typescript']);
  assert.equal(persisted.evidence.evaluations[0].executionId,'exec-1');
  assert.equal(persisted.evidence.evaluations[0].cost,0.2);
  assert.deepEqual(persisted.evidence.outcomes,{succeeded:1,failed:0,timedOut:0});
});

test('registry trusts only configured authors for registry ownership and agent markers', async () => {
  const client = new RegistryGitHubClient();
  const trusted = new Set(['bot']);
  const good = client.seedIssue('owner/repo', marker(AGENT_REGISTRY_MARKER, { scope:'repository', repository:'owner/repo', createdAt:now() }), 'bot');
  client.seedIssue('owner/repo', marker(AGENT_REGISTRY_MARKER, { scope:'repository', repository:'owner/repo', createdAt:now() }), 'other');
  client.seedComment('owner/repo', good, marker(AGENT_MARKER, registryAgent('trusted')), 'bot');
  client.seedComment('owner/repo', good, marker(AGENT_MARKER, registryAgent('ignored')), 'other');

  const store = new GitHubStore(client, 'owner/repo', 9, trusted);
  assert.deepEqual((await store.listAgents()).map(item => item.id), ['trusted']);
});

test('global registry lookup is explicit and isolated from repository legacy markers', async () => {
  const client = new RegistryGitHubClient();
  const trusted = new Set(['bot']);
  const globalIssue = client.seedIssue('owner/global-agents', marker(AGENT_REGISTRY_MARKER, { scope:'global', repository:'owner/global-agents', createdAt:now() }));
  const localIssue = client.seedIssue('owner/repo', 'legacy PR');
  client.seedComment('owner/global-agents', globalIssue, marker(AGENT_MARKER, registryAgent('global')));
  client.seedComment('owner/repo', localIssue, marker(AGENT_MARKER, registryAgent('legacy-local')));

  const store = new GitHubStore(client, 'owner/repo', 9, trusted);
  assert.deepEqual((await store.listAgents([{ kind:'global', repository:'owner/global-agents' }])).map(item => item.id), ['global']);
  await assert.rejects(() => store.listAgents([{ kind:'repository', repository:'owner/other' }]), /cannot cross repositories/);
});
