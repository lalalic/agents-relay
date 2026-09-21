import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAdapter, LaunchFailure } from '../../dist/adapters.js';

const live = process.env.AGENTS_RELAY_RUN_CHATGPT_TEMP_QUALITY === '1';
const agentPath = process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT;
const route = { provider: 'chatgpt', model: 'account-defaults' };
const LIVE_TIMEOUT_MS = 30_000;

function liveTask(prompt, tabClosePolicy = 'after-start') {
  return {
    id: `temporary-quality-${Date.now()}`,
    input: prompt,
    output: { kind: 'task_pr' },
    routing: route,
    timeoutMs: 180_000,
    chatgptTabClosePolicy: tabClosePolicy,
  };
}

function requireLivePrerequisites() {
  assert.equal(live, true, 'set AGENTS_RELAY_RUN_CHATGPT_TEMP_QUALITY=1 to run live quality checks');
  assert.ok(agentPath, 'set AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT to the browser-worker agent definition');
}

function boundedExecution(timeoutMs = LIVE_TIMEOUT_MS) {
  const controller = new AbortController();
  let execution;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timer = setTimeout(() => {
    controller.abort();
    execution?.cancel();
    rejectDeadline(new Error(`live Temporary Chat quality scenario exceeded ${timeoutMs}ms`));
  }, timeoutMs);
  return {
    controller,
    setExecution(value) { execution = value; },
    race(promise) { return Promise.race([promise, deadline]); },
    cleanup() {
      clearTimeout(timer);
      controller.abort();
      execution?.cancel();
    },
  };
}

test('live Temporary Chat submission returns a verified acceptance receipt', { skip: !live, timeout: LIVE_TIMEOUT_MS + 5_000 }, async () => {
  requireLivePrerequisites();
  const bounded = boundedExecution();
  const adapter = new ChatGptAdapter({ agentPath });
  try {
    const execution = adapter.launch(
      liveTask('Reply with exactly TEMPORARY_CHAT_QUALITY_OK.'),
      bounded.controller.signal,
      { waitForWorkerStart: Promise.resolve() },
    );
    bounded.setExecution(execution);
    const result = await bounded.race(execution.promise);
    assert.equal(result.data.submitted, true);
    assert.match(result.summary, /terminal task state is event-owned/);
  } finally {
    bounded.cleanup();
  }
});

test('live Temporary Chat waits for terminal cleanup before releasing its owned tab', { skip: !live, timeout: LIVE_TIMEOUT_MS + 5_000 }, async () => {
  requireLivePrerequisites();
  let resolveTerminal = () => {};
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  const bounded = boundedExecution();
  const adapter = new ChatGptAdapter({ agentPath });
  try {
    const execution = adapter.launch(
      liveTask('Reply with exactly TEMPORARY_CHAT_CLEANUP_OK.', 'after-terminal'),
      bounded.controller.signal,
      { waitForTerminal: terminal },
    );
    bounded.setExecution(execution);
    let settled = false;
    void execution.promise.then(() => { settled = true; });
    await bounded.race(execution.launched);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'the owned tab must remain open until terminal evidence');

    resolveTerminal();
    const result = await bounded.race(execution.promise);
    assert.equal(result.data.submitted, true);
    assert.equal(settled, true);
  } finally {
    resolveTerminal();
    bounded.cleanup();
  }
});

test('failed Temporary Chat acceptance releases the owned tab and fails safely', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-temp-quality-'));
  const fakeAgentPath = join(root, 'browser-worker.agent.md');
  await writeFile(fakeAgentPath, '# controlled browser-worker boundary');
  let released = false;
  const adapter = new ChatGptAdapter({
    agentPath: fakeAgentPath,
    agentRunner: () => ({
      submitted: Promise.resolve(JSON.stringify({ operation: 'submit', status: 'submitted', verified: false })),
      promise: Promise.resolve('unverified'),
      release: () => { released = true; },
      cancel() {},
    }),
  });

  try {
    await assert.rejects(
      adapter.launch(liveTask('This must never be treated as accepted.'), new AbortController().signal).promise,
      LaunchFailure,
    );
    assert.equal(released, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stalled Temporary Chat submission is bounded and releases resources', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-temp-quality-stall-'));
  const fakeAgentPath = join(root, 'browser-worker.agent.md');
  await writeFile(fakeAgentPath, '# controlled browser-worker boundary');
  let cancelled = false;
  let released = false;
  const adapter = new ChatGptAdapter({
    agentPath: fakeAgentPath,
    agentRunner: (_definition, _request, _route, signal) => {
      signal.addEventListener('abort', () => {
        cancelled = true;
        released = true;
      }, { once: true });
      return {
        submitted: new Promise(() => {}),
        promise: new Promise(() => {}),
        release: () => { released = true; },
        cancel: () => { cancelled = true; },
      };
    },
  });
  const bounded = boundedExecution(50);

  try {
    const execution = adapter.launch(liveTask('This simulated Temporary Chat worker never submits.'), bounded.controller.signal);
    bounded.setExecution(execution);
    await assert.rejects(bounded.race(execution.promise), /exceeded 50ms/);
    assert.equal(cancelled, true);
    assert.equal(released, true);
  } finally {
    bounded.cleanup();
    await rm(root, { recursive: true, force: true });
  }
});
