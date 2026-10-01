import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CHATGPT_BROWSER_WORKSPACE,
  CHATGPT_BROWSER_WORKSPACE_POOL_SIZE,
  ChatGptAdapter,
  ensureChatGptBrowserWorkspace,
} from '../dist/adapters.js';

test('ChatGPT Browser Workspace bootstrap creates agents-replay with pool size 6', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-workspace-'));
  try {
    const log = join(root, 'args.log');
    const command = join(root, 'fake-browser-workspace');
    await writeFile(command, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" > "$FAKE_BW_LOG"',
      'printf "{\\\"name\\\":\\\"agents-replay\\\",\\\"poolSize\\\":6}\\n"',
    ].join('\n'), { mode: 0o700 });
    const previous = process.env.FAKE_BW_LOG;
    process.env.FAKE_BW_LOG = log;
    try {
      await ensureChatGptBrowserWorkspace(command);
    } finally {
      if (previous === undefined) delete process.env.FAKE_BW_LOG;
      else process.env.FAKE_BW_LOG = previous;
    }
    assert.equal((await readFile(log, 'utf8')).trim(), 'create agents-replay 6');
    assert.equal(CHATGPT_BROWSER_WORKSPACE, 'agents-replay');
    assert.equal(CHATGPT_BROWSER_WORKSPACE_POOL_SIZE, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('ChatGPT adapter uses Browser Workspace session lifecycle', async () => {
  const source = await readFile(new URL('../src/adapters.ts', import.meta.url), 'utf8');
  assert.match(source, /sessionBrowserWorkerRunner/);
  assert.match(source, /\['session', 'start', '--workspace', CHATGPT_BROWSER_WORKSPACE\]/);
  assert.match(source, /\['session', 'exec', activeSessionId\]/);
  assert.match(source, /\['session', 'stop', activeSessionId\]/);
  assert.match(source, /this\.runner \?\? sessionBrowserWorkerRunner\(runtime\.root\)/);
  assert.deepEqual(new ChatGptAdapter().capabilities, ['model', 'chatgpt', 'browser-workspace']);
});


test('relayd bootstraps ChatGPT Browser Workspace before runtime startup', async () => {
  const source = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ ChatGptAdapter, CodexAdapter, ensureChatGptBrowserWorkspace \} from '\.\/adapters\.js'/);
  assert.match(source, /configureExecutionRouterRulesPath\(argv\);\s+await ensureChatGptBrowserWorkspace\(\);\s+const normalized = normalizeDaemonArguments\(argv\);/);
});
