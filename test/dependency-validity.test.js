import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { dependencyValidityFromArgs } from '../dist/cli-worker-task.js';
import { createTaskEntity } from '../dist/workflow/entity-creation.js';

test('CLI dependency validity parser accepts declared edge policies and rejects invalid input', () => {
  assert.deepEqual(dependencyValidityFromArgs(['--dependency-validity', '{"owner":"rerun"}'], ['owner']), { owner: 'rerun' });
  assert.equal(dependencyValidityFromArgs([], ['owner']), undefined);
  assert.throws(() => dependencyValidityFromArgs(['--dependency-validity', '{'], ['owner']), /valid JSON/);
  assert.throws(() => dependencyValidityFromArgs(['--dependency-validity', '{"other":"rerun"}'], ['owner']), /declared dependency/);
  assert.throws(() => dependencyValidityFromArgs(['--dependency-validity', '{"owner":"again"}'], ['owner']), /order-only, revalidate, or rerun/);
});

test('canonical Task creation rejects dependency policies outside declared edges', () => {
  const job = { id: 'job', tasks: [] };
  const task = { jobId: 'job', id: 'task', input: 'verify', adapter: 'codex', dependencies: ['owner'], dependencyValidity: { owner: 'rerun' } };
  assert.equal(createTaskEntity(job, task, { defer: true }).dependencyValidity.owner, 'rerun');
  assert.throws(() => createTaskEntity(job, { ...task, dependencyValidity: { other: 'rerun' } }, { defer: true }), /must identify a declared dependency/);
});
