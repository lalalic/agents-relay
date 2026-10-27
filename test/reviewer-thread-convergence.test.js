import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { materializePlannerChild } from '../dist/planner.js';
import { prepareReviewerThreadDelivery, recordThreadDelivery } from '../dist/reviewer-thread.js';

const now = new Date().toISOString();
function job() {
  return { id: 'review-routing-test', title: 'job', prNumber: 0, repository: 'local/job', state: 'ACTIVE',
    continuation: null, creatorThreadId: 'creator-thread',
    reviewerThreadId: 'configured-reviewer-thread', implementationThreadId: 'separate-implementation-thread',
    headSha: 'head-123', tasks: [], createdAt: now, updatedAt: now };
}
const context = { agents: [{ name: 'reviewer' }, { name: 'implementation' }] };
const plan = { id: 'plan-1', round: 1, source: 'model-planner', headSha: 'head-123' };
const spec = { id: 'review-planned', agentName: 'reviewer', input: 'Review head.', output: { kind: 'task_pr' } };

test('planner-created reviewer binds exact configured thread before dispatch without implementation bleed', () => {
  const task = materializePlannerChild({ ...job(), tasks: [{ id: 'implementation-root', kind: 'work', agentName: 'implementation', parentTaskId: null }] }, plan, spec, context);
  assert.equal(task.adapter, 'chatgpt');
  assert.equal(task.parentTaskId, null);
  assert.equal(task.workerRequirements.runtime, 'chatgpt');
  assert.equal(task.chatgptThreadDelivery.threadId, 'configured-reviewer-thread');
  assert.equal(task.chatgptThreadDelivery.threadSource, 'reviewer');
  assert.equal(task.chatgptThreadDelivery.reviewHeadSha, 'head-123');
  assert.equal(task.chatgptThreadDelivery.requestId, 'review-routing-test:review-planned:head-123');
  assert.equal(prepareReviewerThreadDelivery(job(), task).requestId, task.chatgptThreadDelivery.requestId);
  assert.equal(prepareReviewerThreadDelivery({ ...job(), reviewerThreadId: undefined }, task).threadId, 'creator-thread');
  assert.equal(prepareReviewerThreadDelivery(job(), task, 'override-thread').threadId, 'override-thread');
  assert.equal(prepareReviewerThreadDelivery(job(), { ...task, agentName: 'implementation' }), undefined);
});

test('reviewer new-turn receipt persists once across reloaded store and reconcile', async () => {
  const reviewer = materializePlannerChild(job(), plan, spec, context);
  reviewer.state = 'RUNNING';
  reviewer.executionId = 'exec-1';
  let saves = 0;
  let durable = structuredClone(reviewer);
  const store = {
    load: async () => ({ tasks: [structuredClone(durable)] }),
    saveTask: async task => { saves++; durable = structuredClone(task); },
  };
  await recordThreadDelivery(store, job().id, reviewer.id, 'exec-1', reviewer);
  const deliveredAt = durable.chatgptThreadDelivery.deliveredAt;
  assert.ok(deliveredAt);
  assert.equal(saves, 1);
  await recordThreadDelivery(store, job().id, reviewer.id, 'exec-1', reviewer);
  assert.equal(saves, 1);
  assert.equal(durable.chatgptThreadDelivery.deliveredAt, deliveredAt);
  assert.equal(prepareReviewerThreadDelivery(job(), durable).deliveredAt, deliveredAt);
  assert.throws(() => prepareReviewerThreadDelivery({ ...job(), reviewerThreadId: 'redirect' }, durable), /already delivered/);
});


test('planner-created primary work bound to implementation thread is materialized as ChatGPT', () => {
  const task = materializePlannerChild(job(), plan, {
    id: 'implementation-planned', agentName: null, input: 'Implement.', adapter: 'codex',
    workerRequirements: { runtime: 'chatgpt', capabilities: ['model', 'chatgpt', 'webhelm'] },
    output: { kind: 'task_pr' },
  }, context);
  assert.equal(task.adapter, 'chatgpt');
  assert.equal(task.workerRequirements.runtime, 'chatgpt');
  assert.ok(task.workerRequirements.capabilities.includes('webhelm'));
});
