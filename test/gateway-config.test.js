import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadGatewayConfig } from '../dist/gateway/config.js';
import { parseJob, parseTask, renderJobComment, renderTaskComment } from '../dist/markers.js';

const validProject = {
  name: 'agents-relay',
  repository: 'lalalic/agents-relay',
  local_path: '/Users/chengli/Workspace/agents-relay',
  base_branch: 'main',
  adapter: 'codex',
  capabilities: ['model', 'codex'],
  routing: { provider: 'openai', model: 'gpt-5.3-codex', reasoning: 'high' },
  max_attempts: 3,
  timeout_ms: 900000,
  max_concurrent: 2,
  trusted_authors: ['lalalic']
};

async function withConfig(raw, run) {
  const directory = await mkdtemp(join(tmpdir(), 'agents-relay-gateway-'));
  const path = join(directory, 'gateway.json');
  await writeFile(path, JSON.stringify(raw));
  try {
    return await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function env(path, overrides = {}) {
  return { AGENTS_RELAY_GATEWAY_CONFIG: path, AGENTS_RELAY_GATEWAY_TOKEN: 'x'.repeat(40), ...overrides };
}

function project(overrides = {}) {
  return { ...validProject, ...overrides };
}

test('gateway config loads an explicit allowlisted project with defaults', async () => {
  await withConfig({ projects: [validProject] }, async path => {
    const config = loadGatewayConfig(env(path));
    assert.equal(config.bind, '127.0.0.1');
    assert.equal(config.port, 8790);
    assert.equal(config.maxBodyBytes, 65536);
    assert.equal(config.maxActiveJobs, 8);
    assert.equal(config.publicBaseUrl, null);
    assert.equal(config.projects.length, 1);
    const [loaded] = config.projects;
    assert.equal(loaded.name, 'agents-relay');
    assert.equal(loaded.localPath, '/Users/chengli/Workspace/agents-relay');
    assert.equal(loaded.adapter, 'codex');
    assert.equal(loaded.maxConcurrent, 2);
    assert.equal(loaded.label, 'agents-relay');
    assert.equal(loaded.branchPrefix, 'agents-relay/');
    assert.deepEqual(loaded.trustedAuthors, ['lalalic']);
    assert.equal(loaded.dashboardUrl, null);
    assert.equal(config.events.enabled, false);
  });
});

test('gateway config honors environment overrides and rejects unsafe transport values', async () => {
  await withConfig({ public_base_url: 'https://relay.example/', max_active_jobs: 4, create_timeout_ms: 250, idle_ttl_ms: 60000, projects: [project({ dashboard_url: 'https://dash.example' })] }, async path => {
    const config = loadGatewayConfig(env(path, { AGENTS_RELAY_GATEWAY_BIND: '0.0.0.0', AGENTS_RELAY_GATEWAY_PORT: '8899', AGENTS_RELAY_GATEWAY_MAX_BODY_BYTES: '2048' }));
    assert.equal(config.publicBaseUrl, 'https://relay.example');
    assert.equal(config.bind, '0.0.0.0');
    assert.equal(config.port, 8899);
    assert.equal(config.maxBodyBytes, 2048);
    assert.equal(config.maxActiveJobs, 4);
    assert.equal(config.createTimeoutMs, 250);
    assert.equal(config.idleTtlMs, 60000);
    assert.equal(config.projects[0].dashboardUrl, 'https://dash.example');
  });

  await withConfig({ public_base_url: 'http://relay.example', projects: [validProject] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), ConfigError);
  });
});

test('gateway config fails closed on tokens, project shapes, and unknown keys', async () => {
  await withConfig({ projects: [validProject] }, async path => {
    assert.throws(() => loadGatewayConfig({ AGENTS_RELAY_GATEWAY_CONFIG: path }), /must be at least 32/);
    assert.throws(() => loadGatewayConfig(env(path, { AGENTS_RELAY_GATEWAY_TOKEN: 'short' })), /must be at least 32/);
  });

  await withConfig({ projects: [validProject], scheduler: 'distributed' }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /unsupported keys: scheduler/);
  });

  await withConfig({ projects: [project({ adapter: 'shell' })] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /adapter must be "codex"/);
  });

  await withConfig({ projects: [project({ capabilities: ['model', 'shell'] })] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /capabilities unsupported by codex/);
  });

  await withConfig({ projects: [project({ local_path: 'relative/path' })] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /local_path must be an absolute path/);
  });

  await withConfig({ projects: [project({ branch_prefix: 'agents-relay' })] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /branch_prefix must end with/);
  });

  await withConfig({ projects: [project(), project({ repository: 'lalalic/other' })] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /Duplicate project name/);
  });

  await withConfig({ projects: [project({ routing: { provider: 'openai', model: 'm', api_key: 'sk-secret' } })] }, async path => {
    assert.throws(() => loadGatewayConfig(env(path)), /routing has unsupported keys: api_key/);
  });

  assert.throws(() => loadGatewayConfig({ AGENTS_RELAY_GATEWAY_TOKEN: 'x'.repeat(40) }), /config.* is required/);
});

test('marker-v1 job and task records round-trip with and without gateway extension fields', () => {
  const now = new Date().toISOString();
  const legacy = { id: 'legacy-1', title: 'Legacy job', prNumber: 1, repository: 'lalalic/agents-relay', state: 'OPEN', continuation: null, createdAt: now, updatedAt: now, tasks: [] };
  const legacyRound = parseJob(renderJobComment(legacy));
  assert.ok(legacyRound !== null);
  assert.equal(legacyRound.id, 'legacy-1');
  assert.equal(legacyRound.project, undefined);
  assert.equal(legacyRound.requestFingerprint, undefined);
  assert.match(renderJobComment(legacy), /agents-relay:job:v1/);

  const extended = {
    ...legacy,
    id: 'agents-relay-0123456789abcdef',
    project: 'agents-relay',
    requirements: ['keep it small'],
    requestFingerprint: 'sha256:abc',
    parentJobId: 'agents-relay-parent',
    parentTaskId: 'parent-task',
    createdBy: { kind: 'gateway', keyFingerprint: 'sha256:def', agentName: 'chatgpt-hosted' }
  };
  const extendedRound = parseJob(renderJobComment(extended));
  assert.equal(extendedRound.project, 'agents-relay');
  assert.deepEqual(extendedRound.requirements, ['keep it small']);
  assert.equal(extendedRound.requestFingerprint, 'sha256:abc');
  assert.equal(extendedRound.parentJobId, 'agents-relay-parent');
  assert.equal(extendedRound.parentTaskId, 'parent-task');
  assert.deepEqual(extendedRound.createdBy, { kind: 'gateway', keyFingerprint: 'sha256:def', agentName: 'chatgpt-hosted' });

  const legacyTask = {
    jobId: 'legacy-1',
    id: 'task-1',
    parentTaskId: null,
    dependencies: [],
    capabilities: [],
    adapter: 'shell',
    input: 'true',
    state: 'QUEUED',
    attempt: 0,
    maxAttempts: 1,
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: null,
    timeoutMs: 1000,
    createdAt: now,
    updatedAt: now,
    continuation: null,
    continuationDeliveredAt: null
  };
  const taskRound = parseTask(renderTaskComment(legacyTask));
  assert.ok(taskRound !== null);
  assert.equal(taskRound.id, 'task-1');
  assert.equal(taskRound.jobId, 'legacy-1');
  assert.equal(taskRound.parentTaskId, null);
  assert.match(renderTaskComment(legacyTask), /agents-relay:task:v1/);
});
