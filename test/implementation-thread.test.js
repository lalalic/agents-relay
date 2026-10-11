import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { marker, parseJob, renderJobBody } from '../dist/markers.js';
import { recordThreadDelivery, resolveImplementationThreadDestination, resolveImplementationTaskThreadDestination, resolveReviewerThreadDestination } from '../dist/reviewer-thread.js';

const now = () => new Date().toISOString();
const baseJob = () => ({ id: 'job', title: 'job', prNumber: 0, repository: 'local/job', state: 'ACTIVE', executionMode: 'fixed', continuation: null, createdAt: now(), updatedAt: now(), tasks: [] });

test('implementation thread metadata persists and remains distinct from creator/reviewer threads', () => {
  const job = { ...baseJob(), creatorThreadId: 'creator', reviewerThreadId: 'reviewer', implementationThreadId: ' implementation ' };
  const parsed = parseJob(renderJobBody(job));
  assert.equal(parsed?.implementationThreadId, ' implementation ');
  assert.equal(resolveImplementationThreadDestination(parsed), 'implementation');
  assert.equal(resolveReviewerThreadDestination(parsed)?.source, 'reviewer');
  assert.throws(() => resolveImplementationThreadDestination({ implementationThreadId: ' ' }), /implementation thread ID/);
  assert.equal(parseJob(marker('agents-relay:job:v1', { ...job, implementationThreadId: undefined }))?.implementationThreadId, undefined);
});

test('thread delivery receipt accepts one generation once and a retry generation freshly', async () => {
  let task = { id: 'work', state: 'RUNNING', executionId: 'exec-1', chatgptThreadDelivery: { kind: 'new-turn', threadId: 'thread', threadSource: 'implementation', requestId: 'job:work:exec-1', jobId: 'job', prNumber: 0, executionId: 'exec-1', deliveredAt: null } };
  const store = { load: async () => ({ tasks: [task] }), saveTask: async value => { task = value; } };
  await recordThreadDelivery(store, 'job', 'work', 'exec-1', task);
  const first = task.chatgptThreadDelivery.deliveredAt;
  await recordThreadDelivery(store, 'job', 'work', 'exec-1', task);
  assert.equal(task.chatgptThreadDelivery.deliveredAt, first);
  task = { ...task, executionId: 'exec-2', chatgptThreadDelivery: { ...task.chatgptThreadDelivery, requestId: 'job:work:exec-2', executionId: 'exec-2', deliveredAt: null } };
  await recordThreadDelivery(store, 'job', 'work', 'exec-2', task);
  assert.ok(task.chatgptThreadDelivery.deliveredAt);
  assert.notEqual(task.chatgptThreadDelivery.requestId, 'job:work:exec-1');
});


test('implementation thread ownership does not capture troubleshooter or reviewer routing', () => {
  const job = { ...baseJob(), implementationThreadId: 'implementation-owner' };
  assert.equal(resolveImplementationTaskThreadDestination(job, { agentName: 'implementation' }), 'implementation-owner');
  assert.equal(resolveImplementationTaskThreadDestination(job, { agentName: 'troubleshooter' }), null);
  assert.equal(resolveImplementationTaskThreadDestination(job, { agentName: 'reviewer' }), null);
  assert.equal(resolveImplementationTaskThreadDestination(job, { agentName: undefined }), null);
});
