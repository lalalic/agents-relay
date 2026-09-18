import { GitHubRequestError } from '../dist/gateway/github.js';
import { createEventSink } from '../dist/gateway/events.js';
import { JobSupervisor } from '../dist/gateway/supervisor.js';
import { createActions } from '../dist/gateway/actions.js';
import { startGatewayServer } from '../dist/gateway/server.js';
import { renderJobComment, renderTaskComment } from '../dist/markers.js';

export const TOKEN = 'gateway-test-token-0123456789abcdef';

export function makeProject(overrides = {}) {
  return {
    name: 'agents-relay',
    repository: 'lalalic/agents-relay',
    localPath: '/tmp/agents-relay',
    baseBranch: 'main',
    adapter: 'codex',
    capabilities: ['model', 'codex'],
    routing: { provider: 'openai', model: 'gpt-5.3-codex', reasoning: 'high' },
    maxAttempts: 3,
    timeoutMs: 900000,
    maxConcurrent: 2,
    trustedAuthors: ['lalalic'],
    label: 'agents-relay',
    branchPrefix: 'agents-relay/',
    dashboardUrl: null,
    ...overrides
  };
}

export function makeConfig(overrides = {}) {
  return {
    token: TOKEN,
    bind: '127.0.0.1',
    port: 0,
    maxBodyBytes: 65536,
    maxActiveJobs: 8,
    createTimeoutMs: 5000,
    idleTtlMs: 1800000,
    watchdogMs: 60000,
    publicBaseUrl: null,
    codexCommand: 'codex',
    events: { enabled: false, natsUrl: 'nats://127.0.0.1:4222', subjectPrefix: 'agents-relay.events.job' },
    projects: [makeProject()],
    ...overrides
  };
}

export function fakeAdapter() {
  return {
    name: 'codex',
    id: 'codex',
    capabilities: ['model', 'codex'],
    launch(task) {
      return { id: `exec-${task.id}`, promise: Promise.resolve({ summary: 'worker finished' }), cancel: () => {} };
    }
  };
}

/** Reconciler stand-in for tests that must not launch an adapter. */
export function stubReconciler(store, { delayMs = 0, onReconcile = () => {} } = {}) {
  return {
    calls: 0,
    async watch() {
      return async () => {};
    },
    async reconcile(jobId) {
      this.calls += 1;
      onReconcile(jobId);
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      return store.load(jobId);
    }
  };
}

function notFound() {
  return new GitHubRequestError(404, 'Not Found', '');
}

function conflict(message) {
  return new GitHubRequestError(422, message, '');
}

function clonePull(pull) {
  return { ...pull, head: { ...pull.head } };
}

function cloneComment(comment) {
  return { id: comment.id, body: comment.body, updated_at: comment.updated_at, user: { login: comment.user.login } };
}

/**
 * In-memory stand-in for the GitHub REST surface the gateway uses. It is the durable store in these
 * tests, so no test ever performs a real GitHub write.
 */
export class FakeGitHub {
  constructor(project) {
    this.project = project;
    this.refs = new Map([[project.baseBranch, 'base-sha']]);
    this.commits = new Map([['base-sha', { tree: 'base-tree', parents: [] }]]);
    this.pulls = [];
    this.labels = new Map();
    this.comments = new Map();
    this.hiddenBranchLookups = new Map();
    this.failNext = { saveJob: false, appendTask: false };
    this.onRefConflict = null;
    this.trustedLogin = project.trustedAuthors[0];
    this.sequence = 0;
    this.counters = { calls: 0, writes: 0, commits: 0, refs: 0, pulls: 0, labels: 0, commentCreates: 0, commentPatches: 0, branchReads: 0, pullReads: 0, searches: 0 };
  }

  async request(path, init = {}) {
    const method = String(init.method ?? 'GET').toUpperCase();
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const url = new URL(`https://api.github.test${path}`);
    const segments = url.pathname.split('/').filter(Boolean).map(segment => decodeURIComponent(segment));
    this.counters.calls += 1;
    if (method !== 'GET') this.counters.writes += 1;
    return this.route(method, segments, url, body);
  }

  route(method, segments, url, body) {
    if (segments[0] === 'search' && segments[1] === 'issues' && method === 'GET') {
      this.counters.searches += 1;
      const label = /label:([^\s]+)/.exec(url.searchParams.get('q') ?? '')?.[1] ?? null;
      return {
        items: this.pulls
          .filter(pull => pull.state === 'open' && (label === null || (this.labels.get(pull.number) ?? []).includes(label)))
          .map(pull => ({ number: pull.number }))
      };
    }
    if (segments[0] !== 'repos' || `${segments[1]}/${segments[2]}` !== this.project.repository) {
      throw new Error(`FakeGitHub: unsupported path ${method} ${url.pathname}`);
    }
    const resource = segments[3];
    const rest = segments.slice(4);

    if (resource === 'branches' && rest.length === 1 && method === 'GET') {
      const branch = rest[0];
      this.counters.branchReads += 1;
      const hidden = this.hiddenBranchLookups.get(branch) ?? 0;
      if (hidden > 0) {
        this.hiddenBranchLookups.set(branch, hidden - 1);
        throw notFound();
      }
      const sha = this.refs.get(branch);
      if (!sha) throw notFound();
      return { commit: { sha } };
    }
    if (resource === 'git' && rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
      const commit = this.commits.get(rest[1]);
      if (!commit) throw notFound();
      return { sha: rest[1], tree: { sha: commit.tree }, parents: commit.parents.map(sha => ({ sha })) };
    }
    if (resource === 'git' && rest[0] === 'commits' && rest.length === 1 && method === 'POST') {
      this.counters.commits += 1;
      const sha = `commit-${this.counters.commits}`;
      this.commits.set(sha, { tree: body.tree, parents: body.parents ?? [] });
      return { sha, tree: { sha: body.tree }, parents: (body.parents ?? []).map(value => ({ sha: value })) };
    }
    if (resource === 'git' && rest[0] === 'refs' && method === 'POST') {
      const branch = String(body.ref).replace(/^refs\/heads\//, '');
      if (this.refs.has(branch)) {
        if (this.onRefConflict) this.onRefConflict(branch);
        throw conflict('Reference already exists');
      }
      this.counters.refs += 1;
      this.refs.set(branch, body.sha);
      return { ref: body.ref, object: { sha: body.sha } };
    }
    if (resource === 'pulls' && rest.length === 0 && method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      const head = url.searchParams.get('head');
      const branch = head === null ? null : head.split(':').slice(1).join(':');
      return this.pulls
        .filter(pull => (state === 'all' || pull.state === state) && (branch === null || pull.head.ref === branch))
        .map(clonePull);
    }
    if (resource === 'pulls' && rest.length === 0 && method === 'POST') {
      if (this.pulls.some(pull => pull.head.ref === body.head && pull.state === 'open')) throw conflict('A pull request already exists for this head');
      if (!this.refs.has(body.head)) throw conflict('Validation Failed: head branch not found');
      this.counters.pulls += 1;
      const number = 100 + this.counters.pulls;
      const pull = { number, html_url: `https://github.test/${this.project.repository}/pull/${number}`, state: 'open', merged: false, head: { ref: body.head }, title: body.title, body: body.body, draft: body.draft === true };
      this.pulls.push(pull);
      return clonePull(pull);
    }
    if (resource === 'pulls' && rest.length === 1 && method === 'GET') {
      this.counters.pullReads += 1;
      const pull = this.pulls.find(item => item.number === Number(rest[0]));
      if (!pull) throw notFound();
      return clonePull(pull);
    }
    if (resource === 'issues' && rest.length === 2 && rest[1] === 'labels' && method === 'POST') {
      this.counters.labels += 1;
      const number = Number(rest[0]);
      this.labels.set(number, [...new Set([...(this.labels.get(number) ?? []), ...body.labels])]);
      return body.labels.map(name => ({ name }));
    }
    if (resource === 'issues' && rest.length === 2 && rest[1] === 'comments' && method === 'GET') {
      return [...(this.comments.get(Number(rest[0])) ?? [])].map(cloneComment);
    }
    if (resource === 'issues' && rest.length === 2 && rest[1] === 'comments' && method === 'POST') {
      if (this.failNext.saveJob && body.body.includes('agents-relay:job:v1')) {
        this.failNext.saveJob = false;
        throw new GitHubRequestError(500, 'Injected job marker failure', '');
      }
      if (this.failNext.appendTask && body.body.includes('agents-relay:task:v1')) {
        this.failNext.appendTask = false;
        throw new GitHubRequestError(500, 'Injected task marker failure', '');
      }
      this.counters.commentCreates += 1;
      const number = Number(rest[0]);
      const comment = { id: ++this.sequence, body: body.body, user: { login: this.trustedLogin }, updated_at: new Date().toISOString() };
      this.comments.set(number, [...(this.comments.get(number) ?? []), comment]);
      return cloneComment(comment);
    }
    if (resource === 'issues' && rest.length === 2 && rest[0] === 'comments' && method === 'PATCH') {
      this.counters.commentPatches += 1;
      for (const list of this.comments.values()) {
        const found = list.find(comment => comment.id === Number(rest[1]));
        if (found) {
          found.body = body.body;
          found.updated_at = new Date().toISOString();
          return cloneComment(found);
        }
      }
      throw notFound();
    }
    throw new Error(`FakeGitHub: unsupported route ${method} ${url.pathname}`);
  }

  seedBranch(branch, sha = `seed-${++this.sequence}`) {
    this.refs.set(branch, sha);
    if (!this.commits.has(sha)) this.commits.set(sha, { tree: 'base-tree', parents: [] });
    return sha;
  }

  seedPull({ branch, number, state = 'open', merged = false, labels = [] }) {
    const pull = { number, html_url: `https://github.test/${this.project.repository}/pull/${number}`, state, merged, head: { ref: branch }, title: `seed ${number}`, body: '', draft: true };
    this.pulls.push(pull);
    if (labels.length > 0) this.labels.set(number, [...labels]);
    return pull;
  }

  seedJob({ job, task, prNumber, branch, labels = [this.project.label] }) {
    const branchName = branch ?? `${this.project.branchPrefix}${job.id}`;
    this.seedBranch(branchName);
    const pull = this.seedPull({ branch: branchName, number: prNumber, labels });
    const list = [...(this.comments.get(prNumber) ?? [])];
    list.push({ id: ++this.sequence, body: renderJobComment(job), user: { login: this.trustedLogin }, updated_at: new Date().toISOString() });
    if (task) list.push({ id: ++this.sequence, body: renderTaskComment(task), user: { login: this.trustedLogin }, updated_at: new Date().toISOString() });
    this.comments.set(prNumber, list);
    return { pull, branch: branchName };
  }

  jobCommentBody(prNumber) {
    const comment = (this.comments.get(prNumber) ?? []).find(item => item.body.includes('agents-relay:job:v1'));
    return comment ? comment.body : null;
  }

  taskCommentBodies(prNumber) {
    return (this.comments.get(prNumber) ?? []).filter(item => item.body.includes('agents-relay:task:v1')).map(item => item.body);
  }

  pullForBranch(branch) {
    return this.pulls.find(pull => pull.head.ref === branch) ?? null;
  }
}

/** Wires the real supervisor, actions, and HTTP server against the fake GitHub client. */
export async function startGateway({ fake, config, adapters, createReconciler, eventBus, emit, now } = {}) {
  const resolvedConfig = config ?? makeConfig();
  const client = fake ?? new FakeGitHub(resolvedConfig.projects[0]);
  const recorded = [];
  const bus = eventBus ?? { publish: async () => {}, subscribe: async () => async () => {} };
  const record = emit ?? (event => recorded.push(event));
  const events = createEventSink({ eventBus: bus, emit: record });
  const supervisor = new JobSupervisor({ config: resolvedConfig, client, eventBus: bus, emit: record, adapters: adapters ?? [fakeAdapter()], createReconciler, now });
  const actions = createActions({ config: resolvedConfig, client, supervisor, events });
  const gateway = await startGatewayServer({ config: resolvedConfig, actions });
  return {
    config: resolvedConfig,
    fake: client,
    supervisor,
    actions,
    events,
    recorded,
    port: gateway.port,
    url: `http://127.0.0.1:${gateway.port}`,
    close: async () => {
      await gateway.close();
      await supervisor.stop();
    }
  };
}

export function createJobBody(overrides = {}) {
  return { intent: 'Add a retry budget to the watchdog', project: 'agents-relay', idempotency_key: 'req-1', ...overrides };
}

export async function postJson(url, body, { token = TOKEN, contentType = 'application/json' } = {}) {
  const init = { method: 'POST', headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
  if (contentType !== null) init.headers['content-type'] = contentType;
  if (token !== null) init.headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${url}/v1/jobs`, init);
  return { status: response.status, body: await response.json().catch(() => null) };
}

export async function getJson(url, path, { token = TOKEN } = {}) {
  const init = { headers: {} };
  if (token !== null) init.headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${url}${path}`, init);
  const text = await response.text();
  let parsed = null;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}
