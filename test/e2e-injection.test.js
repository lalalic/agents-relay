import test from 'node:test';
import assert from 'node:assert/strict';
import {allowedE2eInjection, injectedWorkerExecution} from '../dist/e2e-injection.js';
import {classifyWorkerRejection} from '../dist/worker-rejection.js';

test('E2E injection only accepted in exact environment-authorized repository',()=>{
 const env={E2E_REPO:'lalalic/agents-relay-e2e'};
 assert.equal(allowedE2eInjection('lalalic/agents-relay-e2e','quota_exceeded',env),'quota_exceeded');
 assert.equal(allowedE2eInjection('lalalic/agents-relay','quota_exceeded',env),undefined);
 assert.equal(allowedE2eInjection('lalalic/agents-relay-e2e','anything',env),undefined);
 assert.equal(allowedE2eInjection('lalalic/agents-relay-e2e','model_not_found',{}),undefined);
});
test('injection produces an ordinary failed worker execution recognizable by production classifier',async()=>{
 for(const [kind,reason] of [['quota_exceeded','rate_limit_exceeded'],['model_not_found','model_not_found'],['provider_unavailable','provider_unavailable']]){
  const execution=injectedWorkerExecution(kind);
  await assert.rejects(execution.promise);
  assert.equal(execution.processExit.exitCode,1);
  assert.equal(classifyWorkerRejection(execution.processExit.stderr),reason);
 }
 assert.equal(classifyWorkerRejection('segfault'),'worker_process_failed');
});

test('Planner preserves hidden --test-injection option in its Task spec',async()=>{
 const {parsePlannerResult}=await import('../dist/planner.js');
 const plan=parsePlannerResult({objective_status:'in_progress',assessment:'test',next_tasks:[{
  id:'impl',input:'do work',output:{kind:'task_pr'},adapter:'codex',
  '--test-injection':'model_not_found',
  workerRequirements:{runtime:'codex',capabilities:['model','local_repo']}
 }]});
 assert.equal(plan.next_tasks[0].testInjection,'model_not_found');
 assert.equal(plan.next_tasks[0].workerRequirements.runtime,'codex');
});

test('projection injection consumes Planner declaration once, only in authorized repo',async()=>{
 const {consumeProjectionInjection,injectProjectionFailure}=await import('../dist/e2e-injection.js');
 let task={id:'impl',testInjection:'github_projection_failure',updatedAt:new Date(0).toISOString()};
 let current={repository:'lalalic/agents-relay-e2e',tasks:[task]};
 let changes=0;
 const relay={mutateJob:async(_job,fn)=>{current=fn(structuredClone(current));changes++;return current;},loadJob:async()=>structuredClone(current)};
 assert.equal(await consumeProjectionInjection(relay,'lalalic/other','job',{E2E_REPO:'lalalic/agents-relay-e2e'}),false);
 assert.equal(changes,0);
 assert.equal(await consumeProjectionInjection(relay,'lalalic/agents-relay-e2e','job',{E2E_REPO:'lalalic/agents-relay-e2e'}),true);
 assert.equal(current.tasks[0].testInjection,undefined);
 assert.equal(await consumeProjectionInjection(relay,'lalalic/agents-relay-e2e','job',{E2E_REPO:'lalalic/agents-relay-e2e'}),false);
});
