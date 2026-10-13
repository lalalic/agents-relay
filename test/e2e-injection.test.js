import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {authorizedInjection,parseTestInjection,withTestInjection,consumeMethodInjection} from '../dist/e2e-injection.js';
import {classifyWorkerRejection} from '../dist/worker-rejection.js';
import {parsePlannerResult} from '../dist/planner.js';
const repo='lalalic/agents-relay-e2e';
const env={E2E_REPO:repo};

test('repo authorization and strict method configuration',()=>{
 assert.equal(authorizedInjection(repo,'model_not_found',env).method,'worker.codex.launch');
 assert.equal(authorizedInjection('other/repo','model_not_found',env),undefined);
 assert.equal(authorizedInjection(repo,'model_not_found',{}),undefined);
 assert.equal(parseTestInjection({method:'require(\"fs\")',action:'throw',execution:'skip'}),undefined);
 assert.equal(parseTestInjection({method:'github.projectLocalMerge',action:'throw',execution:'skip',error:{code:'503',message:'unavailable'}}).method,'github.projectLocalMerge');
});
test('worker method-level mock skips raw execution and gives normal classified exit',async()=>{
 for(const [kind,reason] of [['quota_exceeded','rate_limit_exceeded'],['model_not_found','model_not_found'],['provider_unavailable','provider_unavailable']]){
  let rawCalls=0;
  const e=withTestInjection('worker.codex.launch',parseTestInjection(kind),()=>{rawCalls++;throw Error('should not execute');});
  assert.equal(rawCalls,0);await assert.rejects(e.promise);
  assert.equal(e.processExit.exitCode,1);
  assert.equal(classifyWorkerRejection(e.processExit.stderr),reason);
 }
});
test('after action executes raw method then throws, pass runs as-is',async()=>{
 let calls=0;
 const config={method:'github.projectLocalMerge',action:'throw',execution:'after',error:{code:'SERVICE_UNAVAILABLE',message:'injected 503',status:503}};
 await assert.rejects(()=>withTestInjection('github.projectLocalMerge',config,()=>{calls++;return 'done'}),e=>e.code==='SERVICE_UNAVAILABLE'&&e.status===503);
 assert.equal(calls,1);
 assert.equal(await withTestInjection('github.projectLocalMerge',undefined,()=>{calls++;return 'ok'}),'ok');assert.equal(calls,2);
 assert.throws(()=>withTestInjection('github.projectLocalMerge',config,()=>{throw Error('real failure');}),/real failure/);
});
test('Planner retains structured --test-injection option',()=>{
 const config={method:'github.projectLocalMerge',action:'throw',execution:'skip',error:{code:'503',message:'injected'}};
 const plan=parsePlannerResult({objective_status:'in_progress',assessment:'test',next_tasks:[{title: 'Implement and verify durable task outputs', id:'impl',input:'work',output:{kind:'task_pr'},'--test-injection':config}]});
 assert.equal(plan.next_tasks[0].testInjection.method,config.method);assert.equal(plan.next_tasks[0].testInjection.error.message,config.error.message);
});
test('projection injection is atomically consumed once for authorized repository',async()=>{
 const original=process.env.E2E_REPO;process.env.E2E_REPO=repo;
 try{
  let current={repository:repo,tasks:[{id:'impl',testInjection:{method:'github.projectLocalMerge',action:'throw',execution:'skip',error:{code:'503',message:'failure'}},updatedAt:new Date(0).toISOString()}]};
  let writes=0;
  const relay={mutateJob:async(_job,fn)=>{current=fn(structuredClone(current));writes++;return current;},loadJob:async()=>structuredClone(current)};
  assert.equal(await consumeMethodInjection(relay,'other/repo','job','github.projectLocalMerge'),undefined);
  assert.equal(writes,0);
  const config=await consumeMethodInjection(relay,repo,'job','github.projectLocalMerge');assert.equal(config.action,'throw');
  assert.equal(current.tasks[0].testInjection,undefined);
  assert.equal(await consumeMethodInjection(relay,repo,'job','github.projectLocalMerge'),undefined);
 }finally{if(original===undefined)delete process.env.E2E_REPO;else process.env.E2E_REPO=original;}
});

test('browser workspace command injection is registered, and runner contract requests it',async()=>{
 const c=parseTestInjection({method:'browserWorkspace.command',action:'throw',execution:'skip',error:{code:'BROWSER_WORKSPACE_UNAVAILABLE',message:'E2E unavailable',status:503}});
 assert.equal(c.method,'browserWorkspace.command');
 let calls=0;
 assert.throws(()=>withTestInjection('browserWorkspace.command',c,()=>{calls++;return 'ok'}),/E2E unavailable/);
 assert.equal(calls,0);
 const source=(await import('node:fs/promises')).readFile;
 const contract=await source(new URL('../e2e/scenarios/010-browser-workspace-runtime-failure.md',import.meta.url),'utf8');
 assert.match(contract,/"method":"browserWorkspace.command"/);
});
