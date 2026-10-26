import assert from 'node:assert/strict';
import test from './test-runtime.js';
import { summarizeRuntime } from '../dist/runtime-summary.js';

function task(id, state, adapter, model, executionId = null, leaseExpiresAt = null) {
  return {
    jobId: 'j', id, dependencies: [], capabilities: [], adapter, input: id,
    continuation: null, continuationDeliveredAt: null, state, attempt: 1, maxAttempts: 3,
    leaseOwner: executionId ? 'relay' : null, leaseExpiresAt, executionId, threadId: null,
    result: null, error: null, timeoutMs: 1, createdAt: 'x', updatedAt: 'x',
    workerSelection: adapter === 'orchestrator' ? undefined : { workerId: adapter, adapter, capabilities: [], selectedBy: 'test', selectedAt: 'x' },
    routing: model ? { provider: 'test', model, decidedBy: 'test', decidedAt: 'x' } : undefined,
  };
}

test('runtime summary aggregates only currently running worker/model load', () => {
  const summary = summarizeRuntime([
    { id:'a', title:'a', priority:'P1', autoMerge:true, reviewEnabled:false, prNumber:1, repository:'x/y', state:'ACTIVE', continuation:null, createdAt:'x', updatedAt:'x', tasks:[
      task('c1','RUNNING','chatgpt','gpt-5.6-sol','exec-1','2026-09-27T04:00:00.000Z'),
      task('c2','RUNNING','codex','zai-5.3-flash'),
      task('done','SUCCEEDED','chatgpt','gpt-5.6-sol'),
    ]},
    { id:'b', title:'b', priority:'P1', autoMerge:true, reviewEnabled:false, prNumber:2, repository:'x/y', state:'DRAFT', continuation:null, createdAt:'x', updatedAt:'x', tasks:[
      task('c3','RUNNING','chatgpt','gpt-5.6-sol'),
    ]},
  ]);
  assert.deepEqual(summary, {
    activeJobs: 1,
    runningTasks: 3,
    workers: { chatgpt: 2, codex: 1 },
    models: [
      { model: 'gpt-5.6-sol', count: 2 },
      { model: 'zai-5.3-flash', count: 1 },
    ],
    running: [
      { repository:'x/y', prNumber:1, jobId:'a', jobTitle:'a', taskId:'c1', agentName:null, worker:'chatgpt', provider:'test', model:'gpt-5.6-sol', executionId:'exec-1', leaseExpiresAt:'2026-09-27T04:00:00.000Z' },
      { repository:'x/y', prNumber:1, jobId:'a', jobTitle:'a', taskId:'c2', agentName:null, worker:'codex', provider:'test', model:'zai-5.3-flash', executionId:null, leaseExpiresAt:null },
      { repository:'x/y', prNumber:2, jobId:'b', jobTitle:'b', taskId:'c3', agentName:null, worker:'chatgpt', provider:'test', model:'gpt-5.6-sol', executionId:null, leaseExpiresAt:null },
    ],
  });
});
