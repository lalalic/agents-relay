import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideProjectionFailure } from '../dist/workflow/projection-conflict-v2.js';

test('Projection Conflict v2 graph owns deterministic-conflict disposition', () => {
  const deterministic = decideProjectionFailure({ deterministicDefinitionConflict: true });
  assert.equal(deterministic.accepted, true);
  assert.equal(deterministic.target, 'conflict');
  assert.deepEqual(deterministic.actions, []);

  const transient = decideProjectionFailure({ deterministicDefinitionConflict: false });
  assert.equal(transient.accepted, true);
  assert.equal(transient.target, 'retry');
});

test('Projection Conflict v2 graph is the single authority for conflict vs retry', () => {
  // Missing fact is not deterministic: absent evidence never classifies a conflict.
  assert.equal(decideProjectionFailure({}).target, 'retry');
});

test('projection CLI help is available without job storage', async () => {
  const { spawnSync } = await import('node:child_process');
  const help = spawnSync(process.execPath, ['dist/cli.js', 'projection', '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /projection resolve/);
  assert.match(help.stdout, /never\s+auto-overwritten/);
});
