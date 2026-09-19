import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, githubPrUrl, serveDashboard } from '../dist/dashboard.js';
import { InMemoryStore } from '../dist/store.js';
import { MemoryEventBus } from '../dist/events.js';

const now = () => new Date().toISOString();
const task = (id, state = 'QUEUED') => ({
  id,
  projectName: 'Agents Relay',
  agentName: 'codex',
  parentTaskId: null,
  dependencies: [],
  capabilities: ['shell'],
  adapter: 'shell',
  input: `build ${id}`,
  routing: { provider: 'openai', model: 'gpt-5', reasoning: 'high', decidedBy: 'test', decidedAt: now() },
  continuation: null,
  continuationDeliveredAt: null,
  state,
  attempt: 1,
  maxAttempts: 3,
  leaseOwner: 'worker-1',
  leaseExpiresAt: now(),
  executionId: `exec-${id}`,
  threadId: `thread-${id}`,
  result: state === 'SUCCEEDED' ? { summary: `${id} finished` } : null,
  error: state === 'FAILED' ? `${id} failed` : null,
  timeoutMs: 300000,
  createdAt: now(),
  updatedAt: now(),
});
const job = (tasks = []) => ({
  id: 'dashboard-job',
  title: 'Agents Relay dogfood',
  prNumber: 1,
  repository: 'lalalic/agents-relay',
  state: 'RUNNING',
  continuation: null,
  createdAt: now(),
  updatedAt: now(),
  tasks,
});
const event = (type = 'task.milestone') => ({
  version: 1,
  event_id: 'event-1',
  job_id: 'dashboard-job',
  task_id: 'dashboard-ui',
  parent_task_id: 'orchestrator',
  type,
  status: 'running',
  timestamp: now(),
  visibility: 'orchestrator',
  level: 'info',
  message: `dashboard ${type}`,
});

test('dashboard is framework-free, accessible, and renders PR values safely', () => {
  assert.match(dashboardHtml, /data-dashboard-contract="safe-dom,named-relay-events,snapshot-events,bounded-event-history"/);
  assert.doesNotMatch(dashboardHtml, /innerHTML|document\.write|eval\(/);
  assert.match(dashboardHtml, /document\.createElement/);
  assert.match(dashboardHtml, /document\.createTextNode/);
  assert.match(dashboardHtml, /aria-live="polite"/);
  assert.match(dashboardHtml, /<html lang="en" data-dashboard-contract=/);
});

test('dashboard markup includes job summary, hierarchy, and execution contracts', () => {
  assert.match(dashboardHtml, /id="summary"/);
  assert.match(dashboardHtml, /id="jobs"/);
  assert.match(dashboardHtml, /Managed PRs \/ jobs/);
  assert.match(dashboardHtml, /GitHub PR/);
  assert.match(dashboardHtml, /countByState/);
  assert.match(dashboardHtml, /Attention: ' \+ indicators\.join/);
  assert.match(dashboardHtml, /function taskNode\(/);
  assert.match(dashboardHtml, /children\.get\(task\.id\)/);
  assert.match(dashboardHtml, /Last refresh/);
  assert.match(dashboardHtml, /Last event/);
  for (const label of ['Project', 'Agent', 'Parent task', 'Worker adapter', 'Provider / model / reasoning', 'Execution / thread', 'Attempt', 'Dependencies', 'Lease owner / expiry', 'Result', 'Error']) {
    assert.match(dashboardHtml, new RegExp(label));
  }
});

test('GitHub PR links use only validated durable repository and PR values', () => {
  assert.equal(githubPrUrl('lalalic/agents-relay', 1), 'https://github.com/lalalic/agents-relay/pull/1');
  assert.equal(githubPrUrl('owner/repo_name.example', 42), 'https://github.com/owner/repo_name.example/pull/42');

  for (const repository of ['', 'lalalic', '/agents-relay', '../evil', 'owner/.', 'owner/..', 'owner/repo?ref=x', 'owner/repo#fragment']) {
    assert.equal(githubPrUrl(repository, 1), null);
  }
  for (const prNumber of [0, -1, 1.5, '1', Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(githubPrUrl('lalalic/agents-relay', prNumber), null);
  }
});

test('dashboard renders GitHub PR values through safe DOM APIs with a fallback', () => {
  assert.match(dashboardHtml, /const url = githubPrUrl\(job\.repository, job\.prNumber\);/);
  assert.match(dashboardHtml, /const link = document\.createElement\('a'\);/);
  assert.match(dashboardHtml, /link\.href = url;/);
  assert.match(dashboardHtml, /link\.target = '_blank';/);
  assert.match(dashboardHtml, /link\.rel = 'noopener noreferrer';/);
  assert.match(dashboardHtml, /link\.textContent = 'GitHub PR';/);
  assert.match(dashboardHtml, /text\('unavailable'\)/);
  assert.doesNotMatch(dashboardHtml, /innerHTML|document\.write|eval\(/);
});

test('dashboard handles named and snapshot SSE messages with a bounded event feed', () => {
  for (const type of ['model.selected', 'task.started', 'task.milestone', 'task.completed', 'connection']) {
    assert.match(dashboardHtml, new RegExp(type));
  }
  assert.match(dashboardHtml, /new EventSource\('\/events'\)/);
  assert.match(dashboardHtml, /stream\.onmessage/);
  assert.match(dashboardHtml, /stream\.addEventListener\('relay'/);
  assert.match(dashboardHtml, /const MAX_EVENTS = 60;/);
  assert.match(dashboardHtml, /while \(eventFeed\.children\.length > MAX_EVENTS\)/);
});

test('usage API and live UI expose actual usage and explicit balance unavailability', () => {
  assert.match(dashboardHtml, /id="usage-heading"/);
  assert.match(dashboardHtml, /fetch\('\/api\/job'\), fetch\('\/api\/jobs'\), fetch\('\/api\/usage'\)/);
  assert.match(dashboardHtml, /function modelTable\(models\)/);
  assert.match(dashboardHtml, /function usageSource\(source\)/);
  assert.match(dashboardHtml, /Quota \/ balance: unavailable/);
  assert.match(dashboardHtml, /Current durable job/);
  assert.doesNotMatch(dashboardHtml, /innerHTML|document\.write|eval\(/);
});

test('dashboard server is localhost-bound and serves durable markup and JSON', async () => {
  const store = new InMemoryStore(job([task('dashboard-ui', 'RUNNING')]));
  const server = serveDashboard(store, 0, new MemoryEventBus(), 10000, 'dashboard-job');
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address === 'object' && address ? address.address : '', '127.0.0.1');
  const port = typeof address === 'object' && address ? address.port : 0;

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /text\/html/);
  const body = await page.text();
  assert.match(body, /data-dashboard-contract="safe-dom/);

  const jobsApi = await fetch(`http://127.0.0.1:${port}/api/jobs`);
  assert.equal(jobsApi.status, 200);
  const jobsPayload = await jobsApi.json();
  assert.equal(jobsPayload[0].job.id, 'dashboard-job');

  const api = await fetch(`http://127.0.0.1:${port}/api/job`);
  assert.equal(api.status, 200);
  const payload = await api.json();
  assert.equal(payload.tasks[0].threadId, 'thread-dashboard-ui');
  assert.equal(payload.tasks[0].projectName, 'Agents Relay');
  assert.equal(payload.tasks[0].agentName, 'codex');

  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('dashboard forwards named relay events over SSE', async () => {
  const store = new InMemoryStore(job([task('dashboard-ui')]));
  const bus = new MemoryEventBus();
  const server = serveDashboard(store, 0, bus, 30000, 'dashboard-job');
  await new Promise(resolve => server.once('listening', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  await fetch(`http://127.0.0.1:${port}/api/job`);
  const live = await fetch(`http://127.0.0.1:${port}/events`);
  assert.equal(live.status, 200);
  assert.match(live.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = live.body?.getReader();
  assert.ok(reader);

  await bus.publish(event());
  let text = '';
  for (let attempts = 0; attempts < 3; attempts += 1) {
    const chunk = await reader.read();
    text += new TextDecoder().decode(chunk.value);
    if (text.includes('event: relay')) break;
  }
  assert.match(text, /event: relay/);
  assert.match(text, /"type":"task\.milestone"/);
  assert.match(text, /"message":"dashboard task\.milestone"/);
  await reader.cancel();

  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
