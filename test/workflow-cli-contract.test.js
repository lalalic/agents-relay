import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowCliResult } from '../dist/cli-workflow.js';
test('CLI graph discovery, inspect, where, evaluate are read-only', () => {
  assert.ok(workflowCliResult(['discover']).graphs.includes('task-lifecycle.mmd'));
  assert.ok(workflowCliResult(['inspect','--graph','task-lifecycle.mmd']).nodes.length);
  assert.ok(workflowCliResult(['where','--id','effect.launchTask']).length);
  assert.equal(workflowCliResult(['evaluate','--graph','task-lifecycle.mmd','--state','DRAFT','--event','queue']).mode, 'dry-run');
});
test('CLI rejects unauthorized actions and absent durable trace', () => {
  assert.throws(() => workflowCliResult(['action','--id','effect.mergePullRequest']), /authorization/);
  assert.throws(() => workflowCliResult(['trace']), /authorization/);
  assert.throws(() => workflowCliResult(['inspect','--graph','main.mmd']), /unknown executable/);
});
