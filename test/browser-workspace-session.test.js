import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ChatGptAdapter,
  ensureChatGptWebHelmReady,
  parseDriverJson,
} from '../dist/adapters.js';

test('ChatGPT WebHelm preflight validates platform and daemon without creating a workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-webhelm-preflight-'));
  try {
    const log = join(root, 'args.log');
    const command = join(root, 'fake-webhelm');
    await writeFile(command, [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$FAKE_BW_LOG"',
      'if [ "$1" = "platform" ]; then',
      '  printf \'%s\\n\' \'{"platform":"chatgpt"}\'',
      'elif [ "$1" = "status" ]; then',
      '  printf \'%s\\n\' \'{"daemon":{"running":true}}\'',
      'else',
      '  exit 2',
      'fi',
    ].join('\n'), { mode: 0o700 });
    const previousLog = process.env.FAKE_BW_LOG;
    process.env.FAKE_BW_LOG = log;
    try {
      await ensureChatGptWebHelmReady(command);
    } finally {
      if (previousLog === undefined) delete process.env.FAKE_BW_LOG; else process.env.FAKE_BW_LOG = previousLog;
    }
    assert.equal((await readFile(log, 'utf8')).trim(), 'platform profile chatgpt\nstatus');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('global WebHelm CLI preflight does not create a Relay workspace', async () => {
  const source = await readFile(new URL('../src/adapters.ts', import.meta.url), 'utf8');
  assert.match(source, /prefix: \['--yes', 'webhelm@latest'\]/);
  assert.match(source, /browserWorkspaceCommand\(cli, \['status'\]\)/);
  assert.match(source, /\['platform', 'profile', 'chatgpt'\]/);
  assert.match(source, /status\.daemon\?\.running !== true/);
  assert.doesNotMatch(source, /ensureWorkspace|CHATGPT_BROWSER_WORKSPACE|--workspace/);
  assert.doesNotMatch(source, /browserWorkspaceCommand\([^\n]+\['(?:workspace',\s*'create|create|workspace',\s*'delete|delete)'/);
});

test('ChatGPT adapter wraps WebHelm in a leased Browser Pool without modifying WebHelm', async () => {
  const adapter=await readFile(new URL('../src/adapters.ts',import.meta.url),'utf8');
  const runtime=await readFile(new URL('../src/browser-worker-runtime.ts',import.meta.url),'utf8');
  assert.match(adapter,/browserWorkerRunner/);
  assert.match(adapter,/pooledWebHelmRun/);
  assert.match(runtime,/\['session','start','--workspace',WORKSPACE\]/);
  assert.match(runtime,/\['session','stop',sessionId\]/);
  assert.match(runtime,/activate_tab/);
  assert.match(runtime,/workspace_resize/);
  assert.deepEqual(new ChatGptAdapter().capabilities,['model','chatgpt','webhelm']);
});

test('Browser Workspace runner unwraps the generic platform result envelope', () => {
  assert.equal(parseDriverJson('{"result":{"operation":"submit","status":"submitted"}}').status, 'submitted');
});

test('Browser Workspace runner unwraps a JSON receipt from platform stdout', () => {
  assert.equal(parseDriverJson('{"result":{"stdout":"{\\"operation\\":\\"submit\\",\\"status\\":\\"submitted\\"}\\n"}}').status, 'submitted');
});


test('relayd checks WebHelm readiness before startup without creating a group', async () => {
  const source = await readFile(new URL('../src/relayd.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ ChatGptAdapter, CodexAdapter, ensureChatGptWebHelmReady \} from '\.\/adapters\.js'/);
  assert.match(source, /configureExecutionRouterRulesPath\(argv\);\s+try \{\s+await ensureChatGptWebHelmReady\(\);\s+\} catch \(error\) \{\s+process\.stderr\.write\(`WebHelm readiness check skipped:/);
  assert.match(source, /const normalized = normalizeDaemonArguments\(argv\);/);
});
