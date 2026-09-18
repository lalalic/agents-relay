import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCodexArgs, CodexAdapter } from '../dist/adapters.js';

test('buildCodexArgs applies provider, model, reasoning, cwd, and profile in order', () => {
  const args = buildCodexArgs({
    provider: 'zai',
    model: 'glm-5.3-flash',
    reasoning: 'medium',
    cwd: '/workspace/project',
    profile: 'relay',
  }, 'inspect runtime');
  assert.deepEqual(args, [
    'exec',
    '--json',
    '-p', 'relay',
    '-m', 'glm-5.3-flash',
    '-c', 'model_provider=zai',
    '-c', 'model_reasoning_effort=medium',
    '-C', '/workspace/project',
    '--', 'inspect runtime',
  ]);
});

test('buildCodexArgs omits absent optional routing fields', () => {
  const args = buildCodexArgs({ provider: 'zai', model: 'glm-5.3-flash' }, 'prompt');
  assert.deepEqual(args, [
    'exec',
    '--json',
    '-m', 'glm-5.3-flash',
    '-c', 'model_provider=zai',
    '--', 'prompt',
  ]);
});

test('CodexAdapter buffers a thread id emitted before callback attachment', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-codex-'));
  try {
    const command = join(root, 'codex');
    await writeFile(command, [
      '#!/bin/sh',
      `printf '%s\\n' '${JSON.stringify({ type: 'thread.started', thread_id: 'early-thread' })}'`,
      'while true; do sleep 0.1; done',
    ].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const adapter = new CodexAdapter(command);
    const execution = adapter.launch({
      id: 'task',
      input: 'prompt',
      routing: { provider: 'zai', model: 'glm-5.3-flash' },
    }, new AbortController().signal);
    let observedThreadId;
    execution.onThreadStarted = threadId => { observedThreadId = threadId; };
    execution.promise.catch(() => {});
    for (let attempts = 0; attempts < 100 && observedThreadId === undefined; attempts += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(execution.threadId, 'early-thread');
    assert.equal(observedThreadId, 'early-thread');
    execution.cancel();
    await execution.promise.catch(() => {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
