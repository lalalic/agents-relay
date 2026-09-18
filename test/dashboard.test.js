import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardHtml, serveDashboard } from '../dist/dashboard.js';
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
