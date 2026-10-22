import test from 'node:test';
import assert from 'node:assert/strict';
import { forceRestateBlocked, forceRestateConverged } from '../../dist/force-restate-validation.js';

const base = { state: 'ACTIVE', tasks: [] };
test('Force Restate accepts completed, runnable routed work, or evidenced durable Troubleshooter block only', () => {
  assert.equal(forceRestateConverged({ ...base, state: 'COMPLETED' }), true);
  assert.equal(forceRestateConverged({ ...base, tasks: [{ id: 'work', kind: 'work', state: 'QUEUED', dependencies: [], adapter: 'codex', routing: {}, workerSelection: { adapter: 'codex', capabilities: ['model'] }, workerRequirements: { capabilities: ['model'] } }] }), true);
  assert.equal(forceRestateConverged({ ...base, tasks: [{ id: 'help', recoveryPlanId: 'plan-1', agentName: 'troubleshooter', state: 'BLOCKED', error: 'No worker is registered', result: { data: { evidence: 'Worker inventory is empty', unblock_conditions: 'Register a codex worker' } } }] }, 'plan-1'), true);
});
test('Force Restate rejects empty, dependency-blocked, unrouted, and fake queue states', () => {
  assert.equal(forceRestateConverged(base), false);
  assert.equal(forceRestateConverged({ ...base, tasks: [{ id: 'work', kind: 'work', state: 'QUEUED', dependencies: ['missing'], adapter: 'codex', routing: {}, workerSelection: { adapter: 'codex', capabilities: ['model'] }, workerRequirements: { capabilities: ['model'] } }] }), false);
  assert.equal(forceRestateConverged({ ...base, tasks: [{ id: 'work', kind: 'work', state: 'QUEUED', dependencies: [], adapter: 'codex' }] }), false);
  assert.equal(forceRestateConverged({ ...base, tasks: [{ id: 'work', kind: 'work', state: 'QUEUED', dependencies: [], adapter: 'codex', capabilities: ['special'], routing: {}, workerSelection: { adapter: 'codex', capabilities: [] } }] }), false, 'legacy task.capabilities remain worker requirements when workerRequirements is absent');
  assert.equal(forceRestateConverged({ ...base, state: 'FAILED', tasks: [] }), false);
});

test('unrelated blocked Troubleshooter cannot validate a forced Plan', () => {
  const job = { ...base, tasks: [{ id: 'old-recovery', recoveryPlanId: 'plan-old', agentName: 'troubleshooter', state: 'BLOCKED', error: 'diagnosed', result: { data: { evidence: 'logs confirm', unblock_conditions: 'add worker' } } }] };
  assert.equal(forceRestateBlocked(job, 'plan-current'), false);
});
