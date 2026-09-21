import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAdapter } from '../../dist/adapters.js';
import { Reconciler } from '../../dist/reconciler.js';
import { InMemoryStore } from '../../dist/store.js';
import { NatsEventBus } from '../../dist/events.js';

const agentPath = process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT;
const route = { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'quality-suite', decidedAt: new Date().toISOString() };
const SUBMIT_TIMEOUT_MS = 45_000;
const EVENT_TIMEOUT_MS = 90_000;

function bounded(timeoutMs, label) {
  const controller = new AbortController();
  let execution;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    execution?.cancel();
    rejectDeadline(new Error(`${label} exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    controller,
    setExecution(value) { execution = value; },
    race(promise) { return Promise.race([promise, deadline]); },
    cleanup() { clearTimeout(timer); controller.abort(); execution?.cancel(); },
  };
}

function task(id, input, attachments) {
  const now = new Date().toISOString();
  return {
    id, parentTaskId: null, dependencies: [], capabilities: [], adapter: 'chatgpt',
    input, attachments, output: { kind: 'task_pr' }, routing: route,
    chatgptTabClosePolicy: 'after-start', state: 'QUEUED', attempt: 0, maxAttempts: 1,
    leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
    result: null, error: null, timeoutMs: EVENT_TIMEOUT_MS, createdAt: now, updatedAt: now,
  };
}

test('Temporary Chat submits a normal text prompt', { timeout: SUBMIT_TIMEOUT_MS + 5_000 }, async () => {
  assert.ok(agentPath, 'browser-worker agent path is required');
  const limit = bounded(SUBMIT_TIMEOUT_MS, 'text prompt');
  try {
    const execution = new ChatGptAdapter({ agentPath }).launch(
      task('quality-text', 'Reply with exactly TEMPORARY_CHAT_TEXT_OK.'),
      limit.controller.signal,
      { waitForWorkerStart: Promise.resolve() },
    );
    limit.setExecution(execution);
    const result = await limit.race(execution.promise);
    assert.equal(result.data.submitted, true);
    assert.ok(result.data.userMessageId, 'submission must become a durable user turn');
  } finally { limit.cleanup(); }
});

test('Temporary Chat submits a prompt with an attachment', { timeout: SUBMIT_TIMEOUT_MS + 5_000 }, async () => {
  assert.ok(agentPath, 'browser-worker agent path is required');
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-chatgpt-quality-'));
  const attachment = join(root, 'quality-attachment.txt');
  await writeFile(attachment, 'TEMPORARY_CHAT_ATTACHMENT_FIXTURE');
  const limit = bounded(SUBMIT_TIMEOUT_MS, 'attachment prompt');
  try {
    const execution = new ChatGptAdapter({ agentPath }).launch(
      task('quality-attachment', 'Read the attached file and reply with exactly TEMPORARY_CHAT_ATTACHMENT_OK.', [attachment]),
      limit.controller.signal,
      { waitForWorkerStart: Promise.resolve() },
    );
    limit.setExecution(execution);
    const result = await limit.race(execution.promise);
    assert.equal(result.data.submitted, true);
    assert.ok(result.data.userMessageId, 'attachment submission must become a durable user turn');
  } finally {
    limit.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});

test('managed Temporary Chat follows the worker event contract', { timeout: EVENT_TIMEOUT_MS + 10_000 }, async () => {
  assert.ok(agentPath, 'browser-worker agent path is required');
  const id = `quality-events-${Date.now()}`;
  const work = task('quality-event-contract', 'Quality check only. Follow the mandatory Agents Relay event contract. After task.started, publish task.completed with a short success message; do not modify files.');
  work.jobId = id;
  const now = new Date().toISOString();
  const job = {
    id, title: 'Temporary Chat event contract quality', objective: 'Verify real ChatGPT worker lifecycle events',
    executionMode: 'fixed', autoMerge: false, reviewEnabled: false, prNumber: 60, repository: 'lalalic/agents-relay',
    state: 'OPEN', continuation: null, createdAt: now, updatedAt: now, tasks: [work],
  };
  const store = new InMemoryStore(job);
  const bus = new NatsEventBus();
  const seen = [];
  const reconciler = new Reconciler(store, {
    owner: 'quality-suite', adapters: [new ChatGptAdapter({ agentPath })], eventBus: bus,
    startAckTimeoutMs: 60_000, chatgptTabClosePolicy: 'after-start', maxConcurrent: 1,
  });
  const stopWatch = await reconciler.watch(id);
  const stopSeen = await bus.subscribe(id, async event => { if (event.task_id === work.id) seen.push(event); });
  try {
    await reconciler.reconcile(id);
    const deadline = Date.now() + EVENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const durable = (await store.load(id)).tasks.find(item => item.id === work.id);
      if (['SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED'].includes(durable.state)) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const started = seen.filter(event => event.type === 'task.started');
    const terminal = seen.filter(event => ['task.completed', 'task.failed', 'task.blocked', 'task.cancelled'].includes(event.type));
    assert.equal(started.length, 1, 'worker must publish exactly one task.started');
    assert.equal(terminal.length, 1, 'worker must publish exactly one terminal task event');
  } finally {
    await stopWatch();
    await stopSeen();
  }
});
