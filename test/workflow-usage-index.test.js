import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildWorkflowUsageIndex, defaultWorkflowDirectory, executableGraphs, whereWorkflowSymbol } from '../dist/workflow/usage-index.js';

test('presentation entry never registers as an executable lifecycle', () => {
  const directory = defaultWorkflowDirectory();
  const graphs = executableGraphs(directory);
  assert.ok(graphs.size >= 10);
  assert.equal(graphs.has('main.mmd'), false);
  const entry = readFileSync(join(directory, 'main.mmd'), 'utf8');
  assert.match(entry, /state: Job Objective/);
  assert.match(entry, /graph: Review changes loop/);
  assert.match(entry, /unknown: reconcile first/);
  const targets = [...entry.matchAll(/click \w+ href "([^"]+\.mmd)"/g)].map(match => match[1]);
  assert.ok(targets.length >= 9);
  for (const target of targets) assert.ok(existsSync(join(directory, target)), target);
});

test('reverse symbol usage is derived from executable graphs with source locations', () => {
  const index = buildWorkflowUsageIndex(executableGraphs(defaultWorkflowDirectory()));
  assert.ok(index.length > 50);
  assert.ok(whereWorkflowSymbol(index, 'effect.launchTask', 'action').length > 0);
  assert.ok(whereWorkflowSymbol(index, 'worker.platform_failure', 'event').length > 0);
  assert.deepEqual(whereWorkflowSymbol(index, 'not-a-symbol'), []);
  for (const item of index) assert.ok(item.line > 0 && item.graph.endsWith('.mmd'));
});
