import test from 'node:test';
import assert from 'node:assert/strict';
import { loadScenarios } from './harness.mjs';
import { runWorkflowReplay } from './workflow-replay.mjs';
test('L3 replay cannot certify mocked workflow effects as production full-path PASS', async () => {
  const scenarios = loadScenarios(new URL('./scenarios.json', import.meta.url)).filter(item => item.category === 'L3');
  const results = await runWorkflowReplay(scenarios); const negative = results.find(item => item.scenarioId === 'broken-terminal-trace');
  assert.equal(negative?.outcome, 'FAIL'); assert.ok(results.filter(item => item.scenarioId !== 'broken-terminal-trace').every(item => item.outcome === 'UNSUPPORTED'), JSON.stringify(results));
});
