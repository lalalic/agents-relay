import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const moduleUrl = new URL('../dist/browser-worker-runtime.js', import.meta.url).href;
function importWithWorkspace(value) {
  const env = { ...process.env };
  if (value === undefined) delete env.AGENTS_RELAY_WEBHELM_WORKSPACE;
  else env.AGENTS_RELAY_WEBHELM_WORKSPACE = value;
  return spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)});`], {
    cwd: process.cwd(), env, encoding: 'utf8', timeout: 10000,
  });
}

test('browser pool can initialize without Neo workspace configuration', () => {
  const result = importWithWorkspace(undefined);
  assert.equal(result.status, 0, result.stderr);
});

test('browser workspace accepts explicit safe deployment-owned names', () => {
  const result = importWithWorkspace('Relay-Office');
  assert.equal(result.status, 0, result.stderr);
});

test('browser workspace rejects unsafe names', () => {
  const result = importWithWorkspace('../Neo');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /AGENTS_RELAY_WEBHELM_WORKSPACE must be a safe workspace name/);
});
