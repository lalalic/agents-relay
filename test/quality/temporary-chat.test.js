import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAdapter } from '../../dist/adapters.js';

const agentPath = process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT;
const route = { provider: 'chatgpt', model: 'account-defaults', decidedBy: 'quality-suite', decidedAt: new Date().toISOString() };
const SUBMIT_TIMEOUT_MS = 120_000;

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
    result: null, error: null, timeoutMs: SUBMIT_TIMEOUT_MS, createdAt: now, updatedAt: now,
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
    const attachmentTask = task('quality-attachment', 'Read the attached file and reply with exactly TEMPORARY_CHAT_ATTACHMENT_OK.', [attachment]);
    const execution = new ChatGptAdapter({ agentPath }).launch(
      attachmentTask,
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
