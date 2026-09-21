import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChatGptAdapter, LaunchFailure } from '../../dist/adapters.js';

const live = process.env.AGENTS_RELAY_RUN_CHATGPT_TEMP_QUALITY === '1';
const agentPath = process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT;
const route = { provider: 'chatgpt', model: 'account-defaults' };

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

test('live Temporary Chat submission returns a verified acceptance receipt', { skip: !live, timeout: 180_000 }, async () => {
  requireLivePrerequisites();
  const adapter = new ChatGptAdapter({ agentPath });
  const execution = adapter.launch(
    liveTask('Reply with exactly TEMPORARY_CHAT_QUALITY_OK.'),
    new AbortController().signal,
    { waitForWorkerStart: Promise.resolve() },
  );

  const result = await execution.promise;
  assert.equal(result.data.submitted, true);
  assert.match(result.summary, /terminal task state is event-owned/);
});

test('live Temporary Chat waits for terminal cleanup before releasing its owned tab', { skip: !live, timeout: 180_000 }, async () => {
  requireLivePrerequisites();
  let resolveTerminal;
  const terminal = new Promise(resolve => { resolveTerminal = resolve; });
  const adapter = new ChatGptAdapter({ agentPath });
  const execution = adapter.launch(
    liveTask('Reply with exactly TEMPORARY_CHAT_CLEANUP_OK.', 'after-terminal'),
    new AbortController().signal,
    { waitForTerminal: terminal },
  );

  let settled = false;
  void execution.promise.then(() => { settled = true; });
  await execution.launched;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(settled, false, 'the owned tab must remain open until terminal evidence');

  resolveTerminal();
  const result = await execution.promise;
  assert.equal(result.data.submitted, true);
  assert.equal(settled, true);
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
