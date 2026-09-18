import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJob, parseTask } from '../dist/markers.js';
import { jobIdFor, parseCreateJobRequest, requestFingerprint } from '../dist/gateway/schema.js';
import { FakeGitHub, createJobBody, getJson, makeConfig, makeProject, postJson, startGateway, stubReconciler } from './gateway-fake.js';

const stub = store => stubReconciler(store);

function nowIso() {
  return new Date().toISOString();
}

function seededJob(id, overrides = {}) {
  const now = nowIso();
  return { id, title: 'Seeded job', prNumber: 1, repository: 'lalalic/agents-relay', state: 'RUNNING', continuation: null, createdAt: now, updatedAt: now, tasks: [], ...overrides };
}

test('unconfigured projects are rejected before any GitHub write', async () => {
  const gateway = await startGateway();
  try {
    const response = await postJson(gateway.url, createJobBody({ project: 'not-configured' }));
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, 'unknown_project');
    assert.equal(gateway.fake.counters.calls, 0);
    assert.equal(gateway.fake.counters.writes, 0);
  } finally {
    await gateway.close();
  }
});

test('create_job anchors one empty commit, one draft PR, the label, and one marker pair', async () => {
  const gateway = await startGateway();
  try {
    const response = await postJson(gateway.url, createJobBody());
    assert.equal(response.status, 201);
    assert.equal(response.body.created, true);
    assert.equal(response.body.project, 'agents-relay');
    assert.match(response.body.job_id, /^agents-relay-[0-9a-f]{16}$/);
    assert.match(response.body.request_fingerprint, /^sha256:[0-9a-f]{64}$/);
    assert.equal(response.body.title, 'Add a retry budget to the watchdog');
    assert.equal(typeof response.body.task_id, 'string');
    assert.ok(response.body.task_id.length > 0);
    assert.equal(response.body.poll_after_ms, 5000);

    const jobId = response.body.job_id;
    const branch = `agents-relay/${jobId}`;
    assert.equal(gateway.fake.counters.commits, 1);
    assert.equal(gateway.fake.counters.refs, 1);
    assert.equal(gateway.fake.counters.pulls, 1);
    assert.equal(gateway.fake.counters.labels, 1);
    assert.equal(gateway.fake.refs.get(branch), 'commit-1');
    assert.deepEqual(gateway.fake.commits.get('commit-1'), { tree: 'base-tree', parents: ['base-sha'] });

    const pull = gateway.fake.pullForBranch(branch);
    assert.equal(pull.draft, true);
    assert.deepEqual(gateway.fake.labels.get(pull.number), ['agents-relay']);
    assert.equal(response.body.pr.number, pull.number);
    assert.equal(response.body.pr.url, pull.html_url);
    assert.equal(response.body.pr.branch, branch);
    assert.deepEqual(response.body.links, {
      self: `/v1/jobs/${jobId}`,
      status: `/v1/jobs/${jobId}`,
      pr: pull.html_url
    });

    const jobMarker = parseJob(gateway.fake.jobCommentBody(pull.number));
    assert.ok(jobMarker !== null);
    assert.equal(jobMarker.id, jobId);
    assert.equal(jobMarker.project, 'agents-relay');
    assert.equal(jobMarker.repository, 'lalalic/agents-relay');
    assert.equal(jobMarker.prNumber, pull.number);
    assert.deepEqual(jobMarker.requirements, []);
    assert.equal(jobMarker.createdBy.kind, 'gateway');
    assert.match(jobMarker.createdBy.keyFingerprint, /^sha256:[0-9a-f]{32}$/);

    const taskComments = gateway.fake.taskCommentBodies(pull.number);
    assert.equal(taskComments.length, 1);
    const task = parseTask(taskComments[0]);
    assert.ok(task !== null);
    assert.equal(task.jobId, jobId);
    assert.equal(task.projectName, 'agents-relay');
    assert.equal(task.parentTaskId, null);
    assert.deepEqual(task.dependencies, []);
    assert.equal(task.adapter, 'codex');
    assert.deepEqual(task.capabilities, ['model', 'codex']);
    assert.equal(task.routing.provider, 'openai');
    assert.equal(task.routing.model, 'gpt-5.3-codex');
    assert.equal(task.routing.reasoning, 'high');
    assert.equal(task.routing.cwd, '/tmp/agents-relay');
    assert.equal(task.routing.decidedBy, 'gateway-config');
    assert.equal(task.routing.decidedAt, jobMarker.createdAt);
    assert.equal(task.maxAttempts, 3);
    assert.equal(task.timeoutMs, 900000);
    assert.equal(task.input, 'Intent: Add a retry budget to the watchdog');
    // The real Reconciler drove the durable state machine through the supervisor.
    assert.notEqual(task.state, 'QUEUED');
    assert.notEqual(jobMarker.state, 'OPEN');
    assert.ok(gateway.recorded.some(event => event.type === 'job.created' && event.visibility === 'orchestrator'));
  } finally {
    await gateway.close();
  }
});

test('the initial task input composes intent, context, and requirements deterministically', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const response = await postJson(gateway.url, createJobBody({
      intent: '  Ship   the\nthing  ',
      context: 'line one\nline two',
      requirements: ['first  req', 'second\nreq']
    }));
    assert.equal(response.status, 201);
    const task = parseTask(gateway.fake.taskCommentBodies(response.body.pr.number)[0]);
    assert.equal(task.input, 'Intent: Ship the thing\n\nContext:\nline one\nline two\n\nRequirements:\n- first req\n- second req');

    const bare = await postJson(gateway.url, createJobBody({ idempotency_key: 'bare-key', context: '   ', requirements: [] }));
    const bareTask = parseTask(gateway.fake.taskCommentBodies(bare.body.pr.number)[0]);
    assert.equal(bareTask.input, 'Intent: Add a retry budget to the watchdog');
  } finally {
    await gateway.close();
  }
});

test('callers cannot select repository, cwd, command, adapter, provider, model, capabilities, or routing', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    for (const field of ['repository', 'cwd', 'command', 'adapter', 'provider', 'model', 'capabilities', 'routing', 'token', 'credentials']) {
      const response = await postJson(gateway.url, { ...createJobBody(), [field]: 'attacker-controlled' });
      assert.equal(response.status, 400, field);
      assert.equal(response.body.error.code, 'unknown_field', field);
    }
    assert.equal(gateway.fake.counters.writes, 0);

    const accepted = await postJson(gateway.url, createJobBody({ requirements: ['must not change routing'] }));
    assert.equal(accepted.status, 201);
    const task = parseTask(gateway.fake.taskCommentBodies(accepted.body.pr.number)[0]);
    assert.equal(task.adapter, 'codex');
    assert.deepEqual(task.capabilities, ['model', 'codex']);
    assert.equal(task.routing.cwd, '/tmp/agents-relay');
    assert.equal(task.routing.model, 'gpt-5.3-codex');
  } finally {
    await gateway.close();
  }
});

test('an identical retry reuses the same job, PR, and markers', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const body = createJobBody();
    const first = await postJson(gateway.url, body);
    const second = await postJson(gateway.url, body);
    assert.equal(first.status, 201);
    assert.equal(second.status, 200);
    assert.equal(second.body.created, false);
    assert.equal(second.body.job_id, first.body.job_id);
    assert.equal(second.body.pr.number, first.body.pr.number);
    assert.equal(second.body.pr.branch, first.body.pr.branch);
    assert.equal(second.body.request_fingerprint, first.body.request_fingerprint);
    assert.equal(gateway.fake.pulls.length, 1);
    assert.equal(gateway.fake.counters.commits, 1);
    assert.equal(gateway.fake.counters.refs, 1);
    assert.equal(gateway.fake.counters.pulls, 1);
    assert.equal(gateway.fake.taskCommentBodies(first.body.pr.number).length, 1);
    assert.ok(gateway.recorded.some(event => event.type === 'job.reused'));
  } finally {
    await gateway.close();
  }
});

test('a same-key writer that loses the ref race reconciles to the winner anchor', async () => {
  const project = makeProject();
  const body = createJobBody({ idempotency_key: 'race-key' });
  const parsed = parseCreateJobRequest(body);
  const fingerprint = requestFingerprint(parsed.value);
  const jobId = jobIdFor('agents-relay', 'race-key');
  const branch = `agents-relay/${jobId}`;

  const fake = new FakeGitHub(project);
  const winnerTask = {
    jobId,
    id: 'winner-task',
    projectName: 'agents-relay',
    parentTaskId: null,
    dependencies: [],
    capabilities: ['model', 'codex'],
    adapter: 'codex',
    input: 'Intent: Add a retry budget to the watchdog',
    routing: { provider: 'openai', model: 'gpt-5.3-codex', cwd: '/tmp/agents-relay', decidedBy: 'gateway-config', decidedAt: nowIso() },
    continuation: null,
    continuationDeliveredAt: null,
    state: 'QUEUED',
    attempt: 0,
    maxAttempts: 3,
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: null,
    timeoutMs: 900000,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  fake.seedJob({ job: seededJob(jobId, { requestFingerprint: fingerprint, project: 'agents-relay', createdBy: { kind: 'gateway', keyFingerprint: 'sha256:winner' } }), task: winnerTask, prNumber: 500 });
  // Our first branch read happened before the winner pushed the ref.
  fake.hiddenBranchLookups.set(branch, 1);

  const gateway = await startGateway({ fake, config: makeConfig({ projects: [project] }), createReconciler: stub });
  try {
    const response = await postJson(gateway.url, body);
    assert.equal(response.status, 200);
    assert.equal(response.body.created, false);
    assert.equal(response.body.job_id, jobId);
    assert.equal(response.body.pr.number, 500);
    assert.equal(gateway.fake.pulls.length, 1);
    assert.equal(gateway.fake.counters.refs, 0);
    assert.equal(gateway.fake.taskCommentBodies(500).length, 1);
  } finally {
    await gateway.close();
  }
});

test('the same key with a different request returns 409 and never mutates the job', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const first = await postJson(gateway.url, createJobBody());
    assert.equal(first.status, 201);
    const before = gateway.fake.jobCommentBody(first.body.pr.number);

    const conflict = await postJson(gateway.url, createJobBody({ intent: 'Delete production instead' }));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.error.code, 'idempotency_conflict');
    assert.equal(conflict.body.error.retryable, false);
    assert.equal(gateway.fake.jobCommentBody(first.body.pr.number), before);
    assert.equal(gateway.fake.pulls.length, 1);
    assert.equal(gateway.fake.taskCommentBodies(first.body.pr.number).length, 1);
    assert.ok(gateway.recorded.some(event => event.type === 'job.idempotency.conflict'));
  } finally {
    await gateway.close();
  }
});

test('a partial anchor is repaired by an identical retry on the same PR', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const body = createJobBody();
    gateway.fake.failNext.saveJob = true;
    const failed = await postJson(gateway.url, body);
    assert.equal(failed.status, 502);
    assert.equal(failed.body.error.code, 'github_unavailable');
    assert.equal(failed.body.error.retryable, true);
    assert.equal(gateway.fake.pulls.length, 1);
    assert.equal(gateway.fake.jobCommentBody(gateway.fake.pulls[0].number), null);
    assert.ok(gateway.recorded.some(event => event.type === 'job.create.failed' && event.visibility === 'user'));

    const retry = await postJson(gateway.url, body);
    assert.equal(retry.status, 201);
    assert.equal(retry.body.pr.number, gateway.fake.pulls[0].number);
    assert.equal(gateway.fake.pulls.length, 1);
    assert.equal(gateway.fake.counters.refs, 1);
    assert.equal(gateway.fake.counters.pulls, 1);
    const pull = gateway.fake.pulls[0];
    assert.ok(gateway.fake.jobCommentBody(pull.number).includes('agents-relay:job:v1'));
    assert.equal(gateway.fake.taskCommentBodies(pull.number).length, 1);
  } finally {
    await gateway.close();
  }
});

test('get_job returns a bounded view and never registers a runtime', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const created = await postJson(gateway.url, createJobBody({ context: 'secret-context-value', requirements: ['requirement-alpha'] }));
    const jobId = created.body.job_id;
    assert.equal(gateway.supervisor.size(), 1);
    const read = await getJson(gateway.url, `/v1/jobs/${jobId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.job_id, jobId);
    assert.equal(read.body.project, 'agents-relay');
    assert.equal(read.body.terminal, false);
    assert.equal(read.body.closed, false);
    assert.equal(read.body.title, 'Add a retry budget to the watchdog');
    assert.equal(read.body.lineage, null);
    assert.match(read.body.request_fingerprint, /^sha256:/);
    assert.equal(read.body.pr.number, created.body.pr.number);
    assert.equal(read.body.tasks.length, 1);

    const [task] = read.body.tasks;
    assert.equal(task.adapter, 'codex');
    assert.equal(task.state, 'QUEUED');
    assert.equal(task.attempt, 0);
    assert.equal(task.result_summary, null);
    assert.equal(task.error, null);
    for (const leaked of ['input', 'context', 'routing', 'continuation', 'capabilities']) {
      assert.equal(leaked in task, false, leaked);
    }
    const serialized = JSON.stringify(read.body);
    assert.equal(serialized.includes('secret-context-value'), false);
    assert.equal(serialized.includes('requirement-alpha'), false);
    assert.equal(serialized.includes('Intent:'), false);
    assert.equal('dashboard' in read.body.links, false);
    assert.equal(read.body.links.status, read.body.links.self);

    const missing = await getJson(gateway.url, '/v1/jobs/agents-relay-0000000000000000');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'not_found');

    const malformed = await getJson(gateway.url, '/v1/jobs/other-project-0000000000000000');
    assert.equal(malformed.status, 404);
  } finally {
    await gateway.close();
  }
});

test('a terminal or closed anchor is reported without mutating durable state', async () => {
  const project = makeProject();
  const fake = new FakeGitHub(project);
  const terminalJob = seededJob('agents-relay-9999999999999999', { state: 'COMPLETED', project: 'agents-relay', prNumber: 700 });
  fake.seedJob({ job: terminalJob, prNumber: 700 });
  fake.pulls[0].state = 'closed';

  const gateway = await startGateway({ fake, config: makeConfig({ projects: [project] }) });
  try {
    const read = await getJson(gateway.url, `/v1/jobs/${terminalJob.id}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.terminal, true);
    assert.equal(read.body.closed, true);
    assert.equal(read.body.state, 'COMPLETED');
    assert.equal(gateway.supervisor.size(), 0);
  } finally {
    await gateway.close();
  }
});

test('lineage and agent metadata are persisted, echoed, and never become dependencies', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const response = await postJson(gateway.url, createJobBody({
      parent: { job_id: 'agents-relay-parentjob0000000', task_id: 'parent-task-1' },
      agent: { name: 'chatgpt-hosted' }
    }));
    assert.equal(response.status, 201);
    const pull = response.body.pr.number;
    const job = parseJob(gateway.fake.jobCommentBody(pull));
    assert.equal(job.parentJobId, 'agents-relay-parentjob0000000');
    assert.equal(job.parentTaskId, 'parent-task-1');
    assert.equal(job.createdBy.agentName, 'chatgpt-hosted');
    assert.equal(JSON.stringify(job).includes('req-1'), false);

    const task = parseTask(gateway.fake.taskCommentBodies(pull)[0]);
    assert.equal(task.parentTaskId, null);
    assert.deepEqual(task.dependencies, []);
    assert.equal(task.agentName, 'chatgpt-hosted');

    const read = await getJson(gateway.url, `/v1/jobs/${response.body.job_id}`);
    assert.deepEqual(read.body.lineage, { parent_job_id: 'agents-relay-parentjob0000000', parent_task_id: 'parent-task-1', agent: 'chatgpt-hosted' });
    assert.equal(read.body.tasks[0].adapter, 'codex');
  } finally {
    await gateway.close();
  }
});

test('event publishing is best effort and never gates the HTTP outcome', async () => {
  const throwingBus = {
    publish: async () => {
      throw new Error('event bus down');
    },
    subscribe: async () => async () => {}
  };
  const gateway = await startGateway({ eventBus: throwingBus, createReconciler: stub });
  try {
    const response = await postJson(gateway.url, createJobBody());
    assert.equal(response.status, 201);
    assert.equal(response.body.created, true);
    assert.ok(gateway.recorded.some(event => event.type === 'job.created' && event.visibility === 'orchestrator'));
    assert.ok(gateway.recorded.some(event => event.type === 'event.transport.failed'));

    const before = gateway.recorded.length;
    const read = await getJson(gateway.url, `/v1/jobs/${response.body.job_id}`);
    assert.equal(read.status, 200);
    assert.equal(gateway.recorded.length, before);
  } finally {
    await gateway.close();
  }
});

test('a slow first reconciliation never blocks the create response', async () => {
  const gateway = await startGateway({
    config: makeConfig({ createTimeoutMs: 25 }),
    createReconciler: store => ({
      watch: async () => async () => {},
      reconcile: jobId => new Promise(resolve => {
        setTimeout(() => {
          void store.load(jobId).then(resolve, () => resolve({ state: 'OPEN' }));
        }, 250);
      })
    })
  });
  try {
    const started = Date.now();
    const response = await postJson(gateway.url, createJobBody());
    const elapsed = Date.now() - started;
    assert.equal(response.status, 201);
    assert.equal(response.body.reconciled, false);
    assert.equal(response.body.state, 'OPEN');
    assert.ok(elapsed < 200, `expected a bounded wait below the 250ms reconcile, took ${elapsed}ms`);
    const job = parseJob(gateway.fake.jobCommentBody(response.body.pr.number));
    assert.equal(job.state, 'OPEN');
    assert.equal(gateway.fake.taskCommentBodies(response.body.pr.number).length, 1);
  } finally {
    await gateway.close();
  }
});

test('public_base_url is used for links and the dashboard link only appears when configured', async () => {
  const project = makeProject({ dashboardUrl: 'https://dash.example/agents-relay' });
  const gateway = await startGateway({ config: makeConfig({ publicBaseUrl: 'https://relay.example', projects: [project] }), createReconciler: stub });
  try {
    const response = await postJson(gateway.url, createJobBody());
    assert.equal(response.status, 201);
    assert.equal(response.body.links.self, `https://relay.example/v1/jobs/${response.body.job_id}`);
    assert.equal(response.body.links.dashboard, 'https://dash.example/agents-relay');
    const read = await getJson(gateway.url, `/v1/jobs/${response.body.job_id}`);
    assert.equal(read.body.links.dashboard, 'https://dash.example/agents-relay');
  } finally {
    await gateway.close();
  }
});
