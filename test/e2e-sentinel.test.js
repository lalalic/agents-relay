import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../e2e/runner/watch.mjs', import.meta.url), 'utf8');
const definition = source.slice(source.indexOf('function scenario002('), source.indexOf('\nlet working=false;'));
function detect(job, ageMs, scenario='001-happy-path', evidence={workerFailedOrBlocked:false,troubleshooterCreated:false,troubleshooterSucceeded:false,originalRetried:false}) {
  const state = { lastEventAt: new Date(Date.now()-ageMs).toISOString(), evidence };
  return runInNewContext(`${definition}\ndetect(job)`, { job, state, scenario, staleMs: 240000, Date, Math, Number, JSON });
}
test('E2E watcher does not call an active 15-minute review stalled after four minutes', () => {
  const job={state:'ACTIVE',tasks:[{id:'review',state:'RUNNING',timeoutMs:900000,updatedAt:new Date(Date.now()-300000).toISOString()}]};
  assert.equal(detect(job, 300000),null);
  job.tasks[0].updatedAt=new Date(Date.now()-950000).toISOString();
  assert.equal(detect(job, 950000).type,'STALLED');
});


test('E2E npm entry point exposes thread and scenario controls', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts.e2e, 'node e2e/runner/run.mjs');
  const runner = readFileSync(new URL('../e2e/runner/run.mjs', import.meta.url), 'utf8');
  assert.match(runner, /omit --thread/);
  assert.match(runner, /browser-workspace/);
  assert.match(runner, /new-thread/);
  assert.match(runner, /--scenario 001/);
  assert.match(runner, /scenarioArg/);
});


test('Scenario 002 treats first worker failure as trigger while waiting for automatic Troubleshooter', () => {
  const now=new Date().toISOString();
  const job={state:'ACTIVE',tasks:[{id:'work',kind:'work',agentName:'implementation',state:'FAILED',attempt:1,error:'recoverable blocker',updatedAt:now}],plans:[]};
  assert.equal(detect(job,0,'002-worker-blocker-troubleshooter-recovery',{workerFailedOrBlocked:true,troubleshooterCreated:false,troubleshooterSucceeded:false,originalRetried:false}),null);
});

test('Scenario 002 reports missing Troubleshooter only after recovery grace', () => {
  const old=new Date(Date.now()-45000).toISOString();
  const job={state:'ACTIVE',tasks:[{id:'work',kind:'work',agentName:'implementation',state:'FAILED',attempt:1,error:'recoverable blocker',updatedAt:old}],plans:[]};
  assert.equal(detect(job,45000,'002-worker-blocker-troubleshooter-recovery',{workerFailedOrBlocked:true,troubleshooterCreated:false,troubleshooterSucceeded:false,originalRetried:false}).type,'TROUBLESHOOTER_NOT_CREATED');
});

test('Scenario 002 requires successful recovery of the original Task before terminal PASS', () => {
  const now=new Date().toISOString();
  const job={state:'COMPLETED',reviewEnabled:true,localMerge:{status:'succeeded'},plans:[],tasks:[
    {id:'work',kind:'work',agentName:'implementation',state:'SUCCEEDED',attempt:2,updatedAt:now},
    {id:'troubleshoot-work-a1',kind:'work',agentName:'troubleshooter',parentTaskId:'work',state:'SUCCEEDED',attempt:1,updatedAt:now},
    {id:'review',kind:'work',agentName:'reviewer',state:'SUCCEEDED',attempt:1,updatedAt:now}
  ]};
  assert.equal(detect(job,0,'002-worker-blocker-troubleshooter-recovery',{workerFailedOrBlocked:true,troubleshooterCreated:true,troubleshooterSucceeded:true,originalRetried:true}),null);
});

test('watcher supports controller expected-cancel marker instead of treating every cancel as defect', () => {
  assert.match(source,/expectedCancelPath/);
  assert.match(source,/e2e_superseded/);
  const cancelRunner=readFileSync(new URL('../e2e/runner/cancel-round.mjs', import.meta.url),'utf8');
  assert.match(cancelRunner,/expectedCancelMarker/);
});


test('E2E watcher gives QUEUED tasks their configured timeout plus grace', () => {
  const job={state:'ACTIVE',tasks:[{id:'review',state:'QUEUED',timeoutMs:900000,updatedAt:new Date(Date.now()-300000).toISOString()}],plans:[]};
  assert.equal(detect(job,300000),null);
  job.tasks[0].updatedAt=new Date(Date.now()-950000).toISOString();
  assert.equal(detect(job,950000).type,'STALLED');
});


test('Scenario 001 treats GitHub PR as optional and archives any bound display PR', () => {
  assert.match(source,/githubEnabled===true/);
  assert.doesNotMatch(source,/GITHUB_PR_NOT_CREATED/);
  assert.match(source,/GITHUB_AUTH_UNAVAILABLE/);
  assert.doesNotMatch(source,/externalPrNumber/);
  assert.match(source,/GITHUB_PR_NOT_ARCHIVED/);
});


test('Scenario 001 runner preflights GitHub authentication before creating a Job', () => {
  const runner=readFileSync(new URL('../e2e/runner/run.mjs', import.meta.url),'utf8');
  assert.match(runner,/function e2ePreflight\(\)/);
  assert.match(runner,/PRECONDITION_GITHUB_AUTH_UNAVAILABLE/);
  assert.ok(runner.indexOf('e2ePreflight();') < runner.indexOf("const prep=["));
});
