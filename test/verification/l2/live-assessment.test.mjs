import test from 'node:test';
import assert from 'node:assert/strict';
import { assess } from './live-codex-agents.mjs';

const route = {
  candidate: { workerId: 'codex', adapter: 'codex', routing: { decidedBy: 'test' } },
  model: { provider: 'openai', model: 'gpt-6-luna' }, selection: {},
};
const run = (id, expectedFile) => ({ id, sourceId: 'job/isolated/task/worker/execution/ex-1', expectedFile });
const execution = (response, events = [], expectedFileContents = null) => ({ answer: JSON.stringify(response), events, expectedFileContents, exitCode: 0, termination: null });

test('Job 482 planner cannot mark contradictory MCP evidence resolved', () => {
  const id = run('planner_mcp_conflict_job482');
  const poor = execution({ objective_status: 'in_progress', assessment: 'Worker context unknown; blocker resolved.', next_tasks: [{ input: 'Probe failing worker context to verify connection' }] });
  assert.equal(assess(id, poor, route).verdict, 'FAIL');
  const insufficient = execution({ objective_status: 'in_progress', assessment: 'Unresolved worker context', next_tasks: [{ input: 'Write report without probe' }] });
  assert.equal(assess(id, insufficient, route).verdict, 'FAIL');
});

test('Job 482 troubleshooter must diagnose without speculative retry', () => {
  const id = run('troubleshooter_mcp_conflict_job482');
  const wrong = execution({ confirmed_root_cause: null, evidence_ids: ['job/482/task/worker-17/execution/ex-3', 'orchestrator/session-9'], blocker_state: 'unresolved', retry_authorized: false, recommended_next_step: 'Retry blindly' });
  assert.equal(assess(id, wrong, route).verdict, 'FAIL');
});

test('isolated worker action rejects any invalid or extra event', () => {
  const id = run('worker_isolated_fixture_action', 'verified fixture output\n');
  const raw = (type, validation = []) => ({ raw: { type, source: { id: id.sourceId }, data: {} }, validation });
  const good = execution({}, [raw('task.started'), raw('task.completed')], id.expectedFile);
  assert.equal(assess(id, good, route).verdict, 'PASS');
  const bad = execution({}, [raw('task.started'), raw('task.completed'), raw('task.failed', ['rejected'])], id.expectedFile);
  assert.equal(assess(id, bad, route).verdict, 'FAIL');
});
