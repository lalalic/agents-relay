import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeRuntime } from '../dist/runtime-summary.js';

function task(id, state, adapter, model) {
  return {
    jobId: 'j', id, dependencies: [], capabilities: [], adapter, input: id,
    continuation: null, continuationDeliveredAt: null, state, attempt: 1, maxAttempts: 3,
    leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
    result: null, error: null, timeoutMs: 1, createdAt: 'x', updatedAt: 'x',
    workerSelection: adapter === 'orchestrator' ? undefined : { workerId: adapter, adapter, capabilities: [], selectedBy: 'test', selectedAt: 'x' },
    routing: model ? { provider: 'test', model, decidedBy: 'test', decidedAt: 'x' } : undefined,
  };
}

test('runtime summary aggregates only currently running worker/model load', () => {
  const summary = summarizeRuntime([
    { id:'a', title:'a', priority:'P1', executionMode:'fixed', autoMerge:true, reviewEnabled:false, prNumber:1, repository:'x/y', state:'ACTIVE', continuation:null, createdAt:'x', updatedAt:'x', tasks:[
      task('c1','RUNNING','chatgpt','gpt-5.6-sol'),
      task('c2','RUNNING','codex','zai-5.3-flash'),
      task('done','SUCCEEDED','chatgpt','gpt-5.6-sol'),
    ]},
    { id:'b', title:'b', priority:'P1', executionMode:'fixed', autoMerge:true, reviewEnabled:false, prNumber:2, repository:'x/y', state:'DRAFT', continuation:null, createdAt:'x', updatedAt:'x', tasks:[
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
  });
});
