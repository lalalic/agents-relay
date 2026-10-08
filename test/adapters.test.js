import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCodexArgs, CodexAdapter, ChatGptAdapter, LaunchFailure } from '../dist/adapters.js';

const route = { provider: 'openai', model: 'gpt-5' };
const task = (overrides = {}) => ({
  id: 'chat-task',
  input: 'do the work',
  output: { kind: 'task_pr' },
  timeoutMs: 1000,
  routing: route,
  ...overrides,
});

function fakeRunner(response, requests = []) {
  return (_definition, request, _route, signal) => {
    requests.push(request);
    return {
      promise: signal.aborted
        ? Promise.reject(new Error('aborted'))
        : Promise.resolve(JSON.stringify(response)),
      cancel() {},
    };
  };
}

test('ChatGptAdapter is one-shot submit and returns delivery receipt only', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    const requests = [];
    const adapter = new ChatGptAdapter({
      agentPath,
      agentRunner: fakeRunner({
        operation: 'submit',
        status: 'submitted',
        verified: true,
        diagnostic_thread_id: 'diagnostic-only',
        user_message_id: 'u-1',
        verified_by: 'user-turn',
      }, requests),
    });
    const execution = adapter.launch(task(), new AbortController().signal);
    const result = await execution.promise;
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { prompt: 'do the work', tabClosePolicy: 'after-start' });
    assert.equal(execution.threadId, undefined);
    assert.equal(result.data.submitted, true);
    assert.equal(result.data.diagnosticThreadId, 'diagnostic-only');
    assert.equal(result.data.verifiedBy, 'user-turn');
    assert.match(result.summary, /terminal task state is event-owned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test('ChatGptAdapter forwards task attachments to the Temporary Chat runner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-files-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    const requests = [];
    const adapter = new ChatGptAdapter({
      agentPath,
      agentRunner: fakeRunner({ operation: 'submit', status: 'submitted', verified: true, user_message_id: 'u-files', verified_by: 'user-turn' }, requests),
    });
    await adapter.launch(task({ attachments: ['/tmp/a.txt', '/tmp/b.png'] }), new AbortController().signal).promise;
    assert.deepEqual(requests[0].files, ['/tmp/a.txt', '/tmp/b.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('ChatGptAdapter uses the Relay-owned chatgpt-worker agent contract, not a resolved Neo skill', async () => {
  let definition = '';
  const adapter = new ChatGptAdapter({
    agentRunner: (value) => {
      definition = value;
      return { promise: Promise.resolve(JSON.stringify({ operation:'submit', status:'submitted', verified:true })), cancel() {} };
    },
  });
  const executionContext = {
    project:{name:'project',path:'.',workspaceRoot:'.',neoRoot:null,globalRoot:'.'}, role:'worker', instructions:[],
    skills:[], agents:[], runtimes:[], delegation:{mode:'relay-child-task',parentTaskIdRequired:false}
  };
  await adapter.launch(task(), new AbortController().signal, { executionContext }).promise;
  assert.match(definition, /name: chatgpt-worker/);
  assert.match(definition, /Browser Workspace/);
});

test('ChatGptAdapter default runner uses Browser Workspace caller-owned session', async () => {
  const source = await readFile(new URL('../src/adapters.ts', import.meta.url), 'utf8');
  assert.match(source, /this\.runner \?\? browserWorkerRunner\(\)/);
  assert.match(source, /\['platform', 'run', 'chatgpt', 'temporary-submit', '--session-id', sessionId, '--config', configFile\]/);
  assert.match(source, /\['session', 'start'\]/);
  assert.match(source, /\['session', 'stop', sessionId\]/);
  assert.doesNotMatch(source, /\['session', 'exec'/);
  assert.doesNotMatch(source, /\['platform', 'source', 'chatgpt', 'temporary-submit'/);
});

test('ChatGptAdapter accepts composer-cleared submission receipts without a user turn id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-composer-cleared-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    const adapter = new ChatGptAdapter({
      agentPath,
      agentRunner: fakeRunner({ operation: 'submit', status: 'submitted', verified: true, user_message_id: null, verified_by: 'composer-cleared' }),
    });
    const result = await adapter.launch(task(), new AbortController().signal).promise;
    assert.equal(result.data.submitted, true);
    assert.equal(result.data.userMessageId, null);
    assert.equal(result.data.verifiedBy, 'composer-cleared');
    assert.match(result.summary, /terminal task state is event-owned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter rejects unverified or failed submission receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    const bad = new ChatGptAdapter({
      agentPath,
      agentRunner: fakeRunner({ operation: 'submit', status: 'submitted', verified: false }),
    });
    await assert.rejects(bad.launch(task(), new AbortController().signal).promise, LaunchFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter wraps submission transport failure as LaunchFailure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    const adapter = new ChatGptAdapter({
      agentPath,
      agentRunner: () => ({ promise: Promise.reject(new Error('browser unavailable')), cancel() {} }),
    });
    await assert.rejects(adapter.launch(task(), new AbortController().signal).promise, LaunchFailure);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter tab close policy releases only at the configured barrier', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-policy-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    for (const policy of ['after-start', 'never', 'after-terminal']) {
      let released = false;
      let resolveTerminal;
      const terminal = new Promise(resolve => { resolveTerminal = resolve; });
      const adapter = new ChatGptAdapter({
        agentPath,
        tabClosePolicy: policy,
        agentRunner: () => ({
        promise: Promise.resolve(JSON.stringify({ operation: 'submit', status: 'submitted', verified: true })),
          submitted: Promise.resolve(JSON.stringify({ operation: 'submit', status: 'submitted', verified: true })),
          release: () => { released = true; },
          cancel() {},
        }),
      });
      const execution = adapter.launch(task(), new AbortController().signal, {
        waitForWorkerStart: Promise.resolve(),
        waitForTerminal: terminal,
      });
      if (policy === 'after-terminal') {
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(released, false);
        resolveTerminal();
      }
      await execution.promise;
      assert.equal(released, policy !== 'never', policy);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGptAdapter rejects an unknown tab close policy', () => {
  assert.throws(() => new ChatGptAdapter({ tabClosePolicy: 'later' }), /Invalid ChatGPT tab close policy/);
});

test('ChatGptAdapter passes the close policy to the browser worker', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-worker-policy-request-'));
  try {
    const agentPath = join(root, 'browser-worker.agent.md');
    await writeFile(agentPath, '# fake browser worker');
    let request;
    const adapter = new ChatGptAdapter({
      agentPath,
      tabClosePolicy: 'never',
      agentRunner: (_definition, value) => {
        request = value;
        return { promise: Promise.resolve(JSON.stringify({ operation: 'submit', status: 'submitted', verified: true })), cancel() {} };
      },
    });
    await adapter.launch(task(), new AbortController().signal).promise;
    assert.equal(request.tabClosePolicy, 'never');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('buildCodexArgs prefers explicit profile and otherwise maps provider to Codex profile', () => {
  assert.deepEqual(
    buildCodexArgs({ provider: 'zai', model: 'glm-5.3-flash', reasoning: 'medium', cwd: '/workspace/project', profile: 'relay' }, 'inspect runtime'),
    ['exec', '--json', '-p', 'relay', '-m', 'glm-5.3-flash', '-c', 'model_reasoning_effort=medium', '-C', '/workspace/project', '--', 'inspect runtime'],
  );
  assert.deepEqual(
    buildCodexArgs({ provider: 'zai', model: 'glm-5.3-flash', reasoning: 'high' }, 'inspect runtime'),
    ['exec', '--json', '-p', 'zai', '-m', 'glm-5.3-flash', '-c', 'model_reasoning_effort=high', '--', 'inspect runtime'],
  );
});

test('CodexAdapter process exit is runtime-only, not a task result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-codex-'));
  try {
    const command = join(root, 'codex');
    await writeFile(command, ['#!/bin/sh', 'exit 0'].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const result = await new CodexAdapter(command).launch({ id: 'task', input: 'prompt', routing: { provider: 'zai', model: 'glm' } }, new AbortController().signal).promise;
    assert.match(result.summary, /terminal task state is event-owned/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CodexAdapter cancellation force-kills a process that ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-codex-cancel-'));
  try {
    const command = join(root, 'codex');
    await writeFile(command, [
      '#!/bin/sh',
      "trap '' TERM",
      'sleep 10',
    ].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const execution = new CodexAdapter(command).launch({ id: 'task', input: 'prompt', routing: { provider: 'zai', model: 'glm' } }, new AbortController().signal);
    await execution.launched;
    await new Promise(resolve => setTimeout(resolve, 100));
    const startedAt = Date.now();
    execution.cancel();
    await assert.rejects(execution.promise);
    assert.ok(Date.now() - startedAt < 3000, 'cancel should force the process to exit after the grace period');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('CodexAdapter still exposes diagnostic thread id without making it completion evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-codex-thread-'));
  try {
    const command = join(root, 'codex');
    await writeFile(command, [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'early-thread' })}'`,
      'sleep 0.05',
      'exit 0',
    ].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const execution = new CodexAdapter(command).launch({ id: 'task', input: 'prompt', routing: { provider: 'zai', model: 'glm' } }, new AbortController().signal);
    let observed;
    execution.onThreadStarted = value => { observed = value; };
    await execution.promise;
    assert.equal(execution.threadId, 'early-thread');
    assert.equal(observed, 'early-thread');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
