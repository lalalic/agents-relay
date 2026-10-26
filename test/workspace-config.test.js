import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from './test-runtime.js';
import { defaultWorkspaceRoot, resolveWorkspaceRoot } from '../dist/workspace.js';
import { normalizeDaemonArguments } from '../dist/relayd.js';

test('workspace root honors explicit, environment, then shared config precedence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-workspace-config-'));
  const priorConfig = process.env.NEO_WORKSPACE_CONFIG;
  const priorRoot = process.env.AGENTS_RELAY_WORKSPACE_ROOT;
  try {
    const configPath = join(root, 'workspace.json');
    const shared = join(root, 'shared');
    const env = join(root, 'env');
    const explicit = join(root, 'explicit');
    await Promise.all([mkdir(shared), mkdir(env), mkdir(explicit)]);
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceRoot: shared }));
    process.env.NEO_WORKSPACE_CONFIG = configPath;
    delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    assert.equal(await resolveWorkspaceRoot(), await realpath(shared));
    assert.equal(normalizeDaemonArguments([]).workspaceRoot, null);
    process.env.AGENTS_RELAY_WORKSPACE_ROOT = env;
    assert.equal(await resolveWorkspaceRoot(), await realpath(env));
    assert.equal(normalizeDaemonArguments([]).workspaceRoot, env);
    assert.equal(normalizeDaemonArguments(['--workspace-root', explicit]).workspaceRoot, explicit);
    assert.equal(await resolveWorkspaceRoot(explicit), await realpath(explicit));
  } finally {
    if (priorConfig === undefined) delete process.env.NEO_WORKSPACE_CONFIG;
    else process.env.NEO_WORKSPACE_CONFIG = priorConfig;
    if (priorRoot === undefined) delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    else process.env.AGENTS_RELAY_WORKSPACE_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('missing shared workspace config falls back to ~/Workspace', async () => {
  const priorConfig = process.env.NEO_WORKSPACE_CONFIG;
  const priorRoot = process.env.AGENTS_RELAY_WORKSPACE_ROOT;
  try {
    process.env.NEO_WORKSPACE_CONFIG = join(tmpdir(), `missing-workspace-config-${process.pid}.json`);
    delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    assert.equal(await resolveWorkspaceRoot(), defaultWorkspaceRoot());
    assert.equal(defaultWorkspaceRoot(), join(homedir(), 'Workspace'));
  } finally {
    if (priorConfig === undefined) delete process.env.NEO_WORKSPACE_CONFIG;
    else process.env.NEO_WORKSPACE_CONFIG = priorConfig;
    if (priorRoot === undefined) delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    else process.env.AGENTS_RELAY_WORKSPACE_ROOT = priorRoot;
  }
});

test('invalid shared workspace config fails without falling back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-workspace-config-invalid-'));
  const priorConfig = process.env.NEO_WORKSPACE_CONFIG;
  const priorRoot = process.env.AGENTS_RELAY_WORKSPACE_ROOT;
  try {
    const configPath = join(root, 'workspace.json');
    process.env.NEO_WORKSPACE_CONFIG = configPath;
    delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    await writeFile(configPath, '{');
    await assert.rejects(resolveWorkspaceRoot(), /Invalid workspace configuration.*valid JSON/);
    await writeFile(configPath, JSON.stringify({ schemaVersion: 2, workspaceRoot: root }));
    await assert.rejects(resolveWorkspaceRoot(), /Invalid workspace configuration/);
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceRoot: 'relative/path' }));
    await assert.rejects(resolveWorkspaceRoot(), /Invalid workspace configuration/);
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceRoot: join(root, 'missing') }));
    await assert.rejects(resolveWorkspaceRoot(), /Configured Workspace Root is not an accessible directory/);
  } finally {
    if (priorConfig === undefined) delete process.env.NEO_WORKSPACE_CONFIG;
    else process.env.NEO_WORKSPACE_CONFIG = priorConfig;
    if (priorRoot === undefined) delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    else process.env.AGENTS_RELAY_WORKSPACE_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  }
});
