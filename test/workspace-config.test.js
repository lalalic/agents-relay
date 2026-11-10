import assert from 'node:assert/strict';
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from './test-runtime.js';
import { defaultWorkspaceRoot, resolveWorkspaceRoot } from '../dist/workspace.js';
import { normalizeDaemonArguments } from '../dist/relayd.js';

test('workspace root honors explicit and Relay environment without consulting harness configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-workspace-config-'));
  const priorConfig = process.env.NEO_WORKSPACE_CONFIG;
  const priorRoot = process.env.AGENTS_RELAY_WORKSPACE_ROOT;
  try {
    const configPath = join(root, 'workspace.json');
    const ignored = join(root, 'harness');
    const env = join(root, 'env');
    const explicit = join(root, 'explicit');
    await Promise.all([mkdir(ignored), mkdir(env), mkdir(explicit)]);
    await writeFile(configPath, JSON.stringify({ schemaVersion: 1, workspaceRoot: ignored }));
    process.env.NEO_WORKSPACE_CONFIG = configPath;
    delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    assert.equal(await resolveWorkspaceRoot(), defaultWorkspaceRoot());
    assert.equal(normalizeDaemonArguments([]).workspaceRoot, null);
    process.env.AGENTS_RELAY_WORKSPACE_ROOT = env;
    assert.equal(await resolveWorkspaceRoot(), await realpath(env));
    assert.equal(normalizeDaemonArguments([]).workspaceRoot, env);
    assert.equal(normalizeDaemonArguments(['--workspace-root', explicit]).workspaceRoot, explicit);
    assert.equal(await resolveWorkspaceRoot(explicit), await realpath(explicit));
    await assert.rejects(resolveWorkspaceRoot(join(root, 'missing')), /Configured Workspace Root/);
  } finally {
    if (priorConfig === undefined) delete process.env.NEO_WORKSPACE_CONFIG;
    else process.env.NEO_WORKSPACE_CONFIG = priorConfig;
    if (priorRoot === undefined) delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    else process.env.AGENTS_RELAY_WORKSPACE_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test('invalid Neo config does not affect standalone Relay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-ignores-other-config-'));
  const priorConfig = process.env.NEO_WORKSPACE_CONFIG;
  const priorRoot = process.env.AGENTS_RELAY_WORKSPACE_ROOT;
  try {
    const configPath = join(root, 'workspace.json');
    process.env.NEO_WORKSPACE_CONFIG = configPath;
    delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    await writeFile(configPath, '{ invalid json');
    assert.equal(await resolveWorkspaceRoot(), defaultWorkspaceRoot());
  } finally {
    if (priorConfig === undefined) delete process.env.NEO_WORKSPACE_CONFIG;
    else process.env.NEO_WORKSPACE_CONFIG = priorConfig;
    if (priorRoot === undefined) delete process.env.AGENTS_RELAY_WORKSPACE_ROOT;
    else process.env.AGENTS_RELAY_WORKSPACE_ROOT = priorRoot;
    await rm(root, { recursive: true, force: true });
  }
});
