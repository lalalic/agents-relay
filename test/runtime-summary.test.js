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

const now=Date.parse('2026-11-10T18:00:00.000Z');
const future='2026-11-10T18:05:00.000Z';
const past='2026-10-01T04:00:00.000Z';

test('runtime summary counts only active Jobs with current execution leases',()=>{
  const active={id:'a',title:'a',priority:'P1',autoMerge:true,reviewEnabled:false,prNumber:1,repository:'x/y',state:'ACTIVE',continuation:null,createdAt:'x',updatedAt:'x',tasks:[
    task('chat','RUNNING','chatgpt','gpt-5.6-sol','exec-1',future),
    task('codex','RUNNING','codex','zai-5.3-flash','exec-2',future),
    task('expired','RUNNING','codex','zai-5.3-flash','exec-3',past),
    task('without-lease','RUNNING','codex','zai-5.3-flash'),
    task('without-owner','RUNNING','codex','zai-5.3-flash','exec-4',future),
    task('done','SUCCEEDED','chatgpt','gpt-5.6-sol','exec-5',future),
  ]};
  active.tasks.find(t=>t.id==='without-owner').leaseOwner=null;
  const draft={...active,id:'draft',state:'DRAFT',tasks:[task('draft','RUNNING','codex','zai-5.3-flash','exec-6',future)]};
  const cancelled={...active,id:'cancelled',state:'CANCELLED',tasks:[task('cancelled','RUNNING','codex','zai-5.3-flash','exec-7',future)]};
  const summary=summarizeRuntime([active,draft,cancelled],now);
  assert.deepEqual(summary,{
    activeJobs:1,runningTasks:2,workers:{chatgpt:1,codex:1},
    models:[{model:'gpt-5.6-sol',count:1},{model:'zai-5.3-flash',count:1}],
    running:[
      {repository:'x/y',prNumber:1,jobId:'a',jobTitle:'a',taskId:'chat',agentName:null,worker:'chatgpt',provider:'test',model:'gpt-5.6-sol',executionId:'exec-1',leaseExpiresAt:future},
      {repository:'x/y',prNumber:1,jobId:'a',jobTitle:'a',taskId:'codex',agentName:null,worker:'codex',provider:'test',model:'zai-5.3-flash',executionId:'exec-2',leaseExpiresAt:future},
    ],
  });
});

test('historical RUNNING flags with expired leases do not count as live workers',()=>{
  const job={id:'old',title:'old',prNumber:7,repository:'x/old',state:'ACTIVE',tasks:[
    task('old-1','RUNNING','codex','glm-5.3-flash','old-1',past),
    task('old-2','RUNNING','codex','glm-5.3-flash','old-2',past),
    task('old-3','RUNNING','chatgpt','gpt-5.6-luna','old-3',past),
    task('old-4','RUNNING','codex','glm-5.3-flash','old-4',past),
    task('old-5','RUNNING','orchestrator',null),
  ]};
  const result=summarizeRuntime([job],now);
  assert.equal(result.activeJobs,1);
  assert.equal(result.runningTasks,0);
  assert.deepEqual(result.workers,{chatgpt:0,codex:0});
  assert.deepEqual(result.models,[]);
  assert.deepEqual(result.running,[]);
});
