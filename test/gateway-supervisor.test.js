import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJob } from '../dist/markers.js';
import { FakeGitHub, createJobBody, getJson, makeConfig, makeProject, postJson, startGateway, stubReconciler } from './gateway-fake.js';

const stub = store => stubReconciler(store);

function nowIso() {
  return new Date().toISOString();
}

function job(id, state, overrides = {}) {
  return { id, title: 'Seeded job', prNumber: 0, repository: 'lalalic/agents-relay', state, continuation: null, createdAt: nowIso(), updatedAt: nowIso(), tasks: [], ...overrides };
}

test('repeated create and get calls for one job keep exactly one runtime and one watchdog', async () => {
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const first = await postJson(gateway.url, createJobBody());
    const jobId = first.body.job_id;
    assert.equal(gateway.supervisor.size(), 1);
    const runtime = gateway.supervisor.get(jobId);
    assert.ok(runtime);
    assert.equal(runtime.prNumber, first.body.pr.number);

    const second = await postJson(gateway.url, createJobBody());
    assert.equal(second.status, 200);
    const read = await getJson(gateway.url, `/v1/jobs/${jobId}`);
    assert.equal(read.status, 200);

    assert.equal(gateway.supervisor.size(), 1);
    assert.equal(gateway.supervisor.get(jobId), runtime);
    assert.equal(gateway.supervisor.get(jobId).watchdog, runtime.watchdog);
  } finally {
    await gateway.close();
  }
});

test('max_active_jobs bounds resident runtimes and reports capacity_exceeded', async () => {
  const gateway = await startGateway({ config: makeConfig({ maxActiveJobs: 1 }), createReconciler: stub });
  try {
    const first = await postJson(gateway.url, createJobBody({ idempotency_key: 'capacity-1' }));
    assert.equal(first.status, 201);
    assert.equal(gateway.supervisor.atCapacity(), true);

    const second = await postJson(gateway.url, createJobBody({ idempotency_key: 'capacity-2' }));
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'capacity_exceeded');
    assert.equal(second.body.error.retryable, true);
    assert.ok(second.body.error.retry_after_ms > 0);
    assert.equal(gateway.fake.pulls.length, 1);
    assert.equal(gateway.fake.counters.refs, 1);

    const reuse = await postJson(gateway.url, createJobBody({ idempotency_key: 'capacity-1' }));
    assert.equal(reuse.status, 200);
    assert.equal(reuse.body.created, false);
    assert.equal(gateway.supervisor.size(), 1);
  } finally {
    await gateway.close();
  }
});

test('project max_concurrent is passed to each job Reconciler and no global scheduler is created', async () => {
  const gateway = await startGateway({ config: makeConfig({ projects: [makeProject({ maxConcurrent: 5 })] }) });
  try {
    const response = await postJson(gateway.url, createJobBody());
    assert.equal(response.status, 201);
    const runtime = gateway.supervisor.get(response.body.job_id);
    assert.equal(runtime.reconciler.options.maxConcurrent, 5);
    assert.equal(runtime.reconciler.options.owner.startsWith('gateway-'), true);
  } finally {
    await gateway.close();
  }
});

test('idle eviction drops a terminal runtime while get_job still reads durable state', async () => {
  let clock = 1_000_000;
  const gateway = await startGateway({ config: makeConfig({ idleTtlMs: 1000 }), createReconciler: stub, now: () => clock });
  try {
    const created = await postJson(gateway.url, createJobBody());
    const jobId = created.body.job_id;
    const runtime = gateway.supervisor.get(jobId);
    runtime.lastKnownState = 'COMPLETED';

    clock += 1500;
    assert.equal(gateway.supervisor.evictIdle(), 1);
    assert.equal(gateway.supervisor.size(), 0);

    const read = await getJson(gateway.url, `/v1/jobs/${jobId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.job_id, jobId);
    assert.equal(read.body.tasks.length, 1);
    assert.equal(read.body.links.pr, created.body.pr.url);

    clock += 60000;
    assert.equal(gateway.supervisor.evictIdle(), 0);
  } finally {
    await gateway.close();
  }
});

test('recovery discovers PR numbers by search, resolves head.ref through the pulls API, and skips terminal jobs', async () => {
  const project = makeProject();
  const fake = new FakeGitHub(project);
  const runningId = 'agents-relay-1111111111111111';
  const terminalId = 'agents-relay-2222222222222222';
  fake.seedJob({ job: job(runningId, 'RUNNING', { prNumber: 10 }), prNumber: 10 });
  fake.seedJob({ job: job(terminalId, 'COMPLETED', { prNumber: 11 }), prNumber: 11, branch: 'unparseable-branch' });

  const reconcileCalls = [];
  const gateway = await startGateway({
    fake,
    config: makeConfig({ projects: [project] }),
    createReconciler: store => stubReconciler(store, { onReconcile: jobId => reconcileCalls.push(jobId) })
  });
  try {
    const report = await gateway.supervisor.recover();
    assert.deepEqual(report, { discovered: 2, recovered: 1, skippedTerminal: 1, skippedUnresolved: 0 });
    assert.equal(fake.counters.searches, 1);
    assert.equal(fake.counters.pullReads, 2);
    assert.equal(gateway.supervisor.size(), 1);
    assert.equal(gateway.supervisor.get(runningId).prNumber, 10);
    assert.equal(gateway.supervisor.has(terminalId), false);
    assert.deepEqual(reconcileCalls, [runningId]);
  } finally {
    await gateway.close();
  }
});

test('recovery treats an unparseable branch without a marker as unresolved instead of inventing a job', async () => {
  const project = makeProject();
  const fake = new FakeGitHub(project);
  fake.seedBranch('agents-relay/');
  fake.seedPull({ branch: 'agents-relay/', number: 12, labels: [project.label] });

  const gateway = await startGateway({ fake, config: makeConfig({ projects: [project] }), createReconciler: stub });
  try {
    const report = await gateway.supervisor.recover();
    assert.deepEqual(report, { discovered: 1, recovered: 0, skippedTerminal: 0, skippedUnresolved: 1 });
    assert.equal(gateway.supervisor.size(), 0);
  } finally {
    await gateway.close();
  }
});

test('shutdown stops every runtime and clears the watchdog', async () => {
  let cleared = 0;
  const gateway = await startGateway({ createReconciler: stub });
  try {
    const response = await postJson(gateway.url, createJobBody());
    const runtime = gateway.supervisor.get(response.body.job_id);
    const original = globalThis.clearInterval;
    try {
      globalThis.clearInterval = value => {
        cleared += 1;
        return original(value);
      };
      await gateway.supervisor.stop();
    } finally {
      globalThis.clearInterval = original;
    }
    assert.equal(cleared >= 1, true);
    assert.equal(gateway.supervisor.size(), 0);
    assert.equal(gateway.supervisor.has(runtime.jobId), false);
  } finally {
    await gateway.close();
  }
});
