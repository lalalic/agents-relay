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

test('ChatGPT Browser Workspace bootstrap discovers product admin helper through status', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-browser-workspace-'));
  try {
    const log = join(root, 'args.log');
    const adminLog = join(root, 'admin.log');
    const admin = join(root, 'admin.mjs');
    const command = join(root, 'fake-browser-workspace');
    await writeFile(admin, [
      "import { appendFile } from 'node:fs/promises';",
      "export async function ensureWorkspace(name, size) { await appendFile(process.env.FAKE_BW_ADMIN_LOG, JSON.stringify({name,size})+'\\n'); }",
    ].join('\n'));
    await writeFile(command, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FAKE_BW_LOG"',
      `printf '%s\\n' '${JSON.stringify({ admin_helper: admin })}'`,
    ].join('\n'), { mode: 0o700 });
    const previousLog = process.env.FAKE_BW_LOG;
    const previousAdminLog = process.env.FAKE_BW_ADMIN_LOG;
    process.env.FAKE_BW_LOG = log;
    process.env.FAKE_BW_ADMIN_LOG = adminLog;
    try {
      await ensureChatGptBrowserWorkspace(command);
    } finally {
      if (previousLog === undefined) delete process.env.FAKE_BW_LOG; else process.env.FAKE_BW_LOG = previousLog;
      if (previousAdminLog === undefined) delete process.env.FAKE_BW_ADMIN_LOG; else process.env.FAKE_BW_ADMIN_LOG = previousAdminLog;
    }
    assert.equal((await readFile(log, 'utf8')).trim(), 'status');
    assert.deepEqual(JSON.parse((await readFile(adminLog, 'utf8')).trim()), { name: 'Relay', size: 6 });
    assert.equal(CHATGPT_BROWSER_WORKSPACE, 'Relay');
    assert.equal(CHATGPT_BROWSER_WORKSPACE_POOL_SIZE, 6);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('default Browser Workspace CLI uses status discovery and no lifecycle CLI command', async () => {
  const source = await readFile(new URL('../src/adapters.ts', import.meta.url), 'utf8');
  assert.match(source, /\{ command: 'npx', prefix: \['browser-workspace'\] \}/);
  assert.match(source, /browserWorkspaceCommand\(browserWorkspaceCli\(command\), \['status'\]\)/);
  assert.match(source, /admin\.ensureWorkspace\(CHATGPT_BROWSER_WORKSPACE, CHATGPT_BROWSER_WORKSPACE_POOL_SIZE\)/);
  assert.doesNotMatch(source, /browserWorkspaceCommand\([^\n]+\['(?:workspace',\s*'create|create|workspace',\s*'delete|delete)'/);
});

test('ChatGPT adapter uses Browser Workspace one-shot auto-session platform run', async () => {
  const source = await readFile(new URL('../src/adapters.ts', import.meta.url), 'utf8');
  assert.match(source, /autoSessionBrowserWorkerRunner/);
  assert.match(source, /const action = delivery \? 'new-turn' : 'temporary-submit';/);
  assert.match(source, /\['platform', 'run', 'chatgpt', action, '--auto-session', '--config', configFile\]/);
  assert.doesNotMatch(source, /\['session', '(?:start|exec|stop)'/);
  assert.doesNotMatch(source, /\['platform', 'source', 'chatgpt', 'temporary-submit'/);
  assert.match(source, /this\.runner \?\? autoSessionBrowserWorkerRunner\(\)/);
  assert.deepEqual(new ChatGptAdapter().capabilities, ['model', 'chatgpt', 'browser-workspace']);
});


test('relayd best-effort bootstraps ChatGPT Browser Workspace before runtime startup', async () => {
  const source = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ ChatGptAdapter, CodexAdapter, ensureChatGptBrowserWorkspace \} from '\.\/adapters\.js'/);
  assert.match(source, /configureExecutionRouterRulesPath\(argv\);\s+try \{\s+await ensureChatGptBrowserWorkspace\(\);\s+\} catch \(error\) \{\s+process\.stderr\.write\(`Browser Workspace bootstrap skipped:/);
  assert.match(source, /const normalized = normalizeDaemonArguments\(argv\);/);
});
