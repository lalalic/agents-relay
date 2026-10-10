import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {reviewHeadSha} from '../e2e/runner/evidence.mjs';

const root=fileURLToPath(new URL('..',import.meta.url));
const read=async path=>readFile(new URL(path,import.meta.url),'utf8');

test('compressed E2E catalog defines objective ladder and external injected scenarios', async()=>{
  const catalog=await read('../e2e/scenarios/README.md');
  for(const id of ['003-objective-exception-ladder','004-objective-recovery-exhaustion-escalation','005-watchdog-stale-generation','006-provider-quota-reroute','007-projection-isolation-retry','008-async-browser-handoff','009-daemon-restart-orphan','010-browser-workspace-runtime-failure']) assert.match(catalog,new RegExp(id));
});

test('scenario 003 preparation installs deterministic worker and review gates', async()=>{
  const source=await read('../e2e/runner/prepare-round.mjs');
  assert.match(source,/e2e-003-check-worker-gate\.mjs/);
  assert.match(source,/e2e-003-clear-worker-gate\.mjs/);
  assert.match(source,/e2e-003-review-gate\.mjs/);
  assert.match(source,/e2e-003-r\$\{round\}-review-fix-1\.json/);
  assert.match(source,/e2e-003-r\$\{round\}-review-fix-2\.json/);
  assert.match(source,/review\.changes_required/);
  assert.match(source,/Graph must create the review-fix Tasks/);
});

test('scenario 003 watcher requires recovery, two distinct rejected heads, fixes, and approval', async()=>{
  const source=await read('../e2e/runner/watch.mjs');
  assert.match(source,/function scenario003/);
  assert.match(source,/reviewChangesRequired/);
  assert.match(source,/new Set\(state\.evidence\.reviewHeads/);
  assert.match(source,/REVIEW_FIX_LADDER_MISSING/);
  assert.match(source,/FINAL_REVIEW_APPROVAL_MISSING/);
  assert.match(source,/UNEXPECTED_DUPLICATE_ROOT_RECOVERY/);
});

test('external injector stays outside SQLite and supports process, stale-event, and daemon faults', async()=>{
  const source=await read('../e2e/runner/inject.mjs');
  assert.doesNotMatch(source,/SQLiteRelayStore|relayStorePath|openLocalManagedStore/);
  assert.match(source,/process\.kill\(current\.pid,'SIGTERM'\)/);
  assert.match(source,/replayStaleTerminal/);
  assert.match(source,/pm2','restart','agents-relayd/);
  for(const script of ['prepare-round.mjs','watch.mjs','inject.mjs']){
    const result=spawnSync(process.execPath,['--check',`${root}/e2e/runner/${script}`],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
  }
});


test('review evidence normalizes observed snake_case and camelCase immutable head payloads',()=>{
  assert.equal(reviewHeadSha({data:{outcome:{head_sha:'sha-stage-2'}}}),'sha-stage-2');
  assert.equal(reviewHeadSha({data:{head_sha:'sha-stage-1'}}),'sha-stage-1');
  assert.equal(reviewHeadSha({data:{review:{headSha:'sha-normalized'}}}),'sha-normalized');
  assert.equal(reviewHeadSha({head_sha:'sha-top-level'}),'sha-top-level');
  assert.equal(reviewHeadSha({data:{}}),null);
});

test('scenario 004 requires failed Troubleshooter retry and ultimate Job completion', async()=>{
  const prepare=await read('../e2e/runner/prepare-round.mjs');
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(prepare,/function prepareScenario004/);
  assert.match(prepare,/E2E004_TROUBLESHOOTER_FAIL_ONCE/);
  assert.match(prepare,/E2E004_TROUBLESHOOTER_FAILURE/);
  assert.match(watch,/TROUBLESHOOTER_RETRY_NOT_PROVEN/);
  assert.match(watch,/recoveryFailures/);
  assert.match(watch,/RECOVERY_BUDGET_EXHAUSTED/);
  assert.match(watch,/RECURSIVE_RECOVERY/);
  assert.doesNotMatch(watch,/expectedTerminalFailure:true/);
});

test('completed Job allows bounded GitHub projection convergence before blocking handoff', async()=>{
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(watch,/projectionPendingSince/);
  assert.match(watch,/pendingMs>=30000/);
  assert.match(watch,/GITHUB_PR_NOT_ARCHIVED/);
  assert.match(watch,/projectionPendingSince=null/);
});


test('GitHub-enabled completion accepts optional archived display PR for judgment', async()=>{
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(watch,/const externalReady=!github\.enabled \|\| boundPr<=0 \|\|/);
  assert.match(watch,/\['CLOSED','MERGED'\]\.includes/);
  assert.match(watch,/kind:'scenario_completion_judgment'/);
  assert.match(watch,/externalReady,issue:issue\|\|null/);
});

test('scenario 003 permits independent reviewer/runtime recovery while requiring exactly one root recovery', async()=>{
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(watch,/const rootRecoveries=root\?recoveries\.filter\(x=>x\.parentTaskId===root\.id\):\[\]/);
  assert.match(watch,/UNEXPECTED_DUPLICATE_ROOT_RECOVERY/);
  assert.match(watch,/INCIDENTAL_RECOVERY_UNRESOLVED/);
  assert.doesNotMatch(watch,/UNEXPECTED_EXTRA_TROUBLESHOOTER/);
});

test('scenario 005 watcher performs event-triggered injection and refuses PASS without both receipts',async()=>{
  const source=await read('../e2e/runner/watch.mjs');
  const injector=await read('../e2e/runner/inject.mjs');
  assert.match(source,/scenario005Decision\(j,newEvents/);
  assert.match(source,/terminate-from-event/);
  assert.match(source,/SCENARIO_005_EVIDENCE_MISSING/);
  assert.match(source,/STALE_INJECTION_FAILED/);
  assert.match(injector,/task\.executionId!==executionId/);
  assert.match(injector,/\['QUEUED','RUNNING'\]\.includes\(task\.state\)/);
  assert.match(injector,/process\.kill\(pid,0\)/);
});

test('scenario 005 enforces local process execution and immediately rejects PID-less launches',async()=>{const prep=await read('../e2e/runner/prepare-round.mjs'); const logic=await read('../e2e/runner/scenario-005.mjs'); assert.match(prep,/workerRequirements.*runtime/); assert.match(logic,/UNINJECTABLE_WORKER/);});

test('scenario 005 deliberately terminated worker failure is watched while graph recovery progresses',async()=>{const source=await read('../e2e/runner/watch.mjs');assert.match(source,/expectedFailure && recovery\.some/);assert.match(source,/receipt\.executionId/);});


test('runner watches a durable Job even when synchronous initial planning fails',async()=>{
 const source=await read('../e2e/runner/run.mjs');
 assert.match(source,/round-preparation-partially-failed/);
 assert.match(source,/preparationStartedAt/);
 assert.match(source,/watcherWillStart:true/);
 assert.match(source,/const child=spawn\(process\.execPath,watchArgs/);
});

test('watcher escalates every abnormal computed runtime status transition for model judgment', async()=>{
  const watcher=await read('../e2e/runner/watch.mjs');
  const handoff=await read('../e2e/runner/handoff.mjs');
  assert.match(watcher,/new Set\(\['FAILED','BLOCKED'\]\)/);
  assert.match(watcher,/kind:'runtime_status_judgment'/);
  assert.match(watcher,/pendingAbnormalStatus=/);
  assert.match(watcher,/lastAbnormalStatusKey/);
  assert.match(handoff,/payload\.kind==='runtime_status_judgment'/);
  assert.match(handoff,/Determine if this is expected scenario fault injection/);
});

test('COMPLETED runtime transitions require same-thread scenario judgment rather than automatic PASS',async()=>{
 const watcher=await read('../e2e/runner/watch.mjs');const handoff=await read('../e2e/runner/handoff.mjs');
 assert.match(watcher,/kind:'scenario_completion_judgment'/);
 assert.match(watcher,/completion_judgment_submitted/);
 assert.match(watcher,/awaiting_completion_judgment/);
 assert.doesNotMatch(watcher,/state\.phase='passed';/);
 assert.match(handoff,/payload\.kind==='scenario_completion_judgment'/);
 assert.match(handoff,/COMPLETED alone is NOT PASS/);
});

test('scenario 006 watches worker events but is unaware of injection implementation',async()=>{
 const watch=await read('../e2e/runner/watch.mjs');
 const run=await read('../e2e/runner/run.mjs');
 assert.doesNotMatch(watch,/worker-rejection-injected\.json|E2E_WORKER_REJECTION_INJECT_COMMAND|testInjection/);
 assert.doesNotMatch(run,/E2E_WORKER_REJECTION_INJECT_COMMAND/);
});

test('scenario 006 rejects completed job without structured quota reroute and same-task retry',async()=>{
 const watch=await read('../e2e/runner/watch.mjs');
 assert.match(watch,/SCENARIO_006_EVIDENCE_MISSING/);
 assert.match(watch,/e\.type==='task.failed'&&e.data\?\.reason/);
 assert.match(watch,/e\.type==='task.rerouting'/);
 assert.match(watch,/Number\(original\.attempt\)>=2/);
});

test('scenario 006 uses planner declaration rather than external injector',async()=>{
 const spec=await read('../e2e/scenarios/006-provider-quota-reroute.md');
 assert.match(spec,/--test-injection/);
 const plan=await read('../src/planner.ts');
 assert.match(plan,/task\['--test-injection'\]/);
});

test('scenario 007 watcher ignores private injection implementation',async()=>{
 const watcher=await read('../e2e/runner/watch.mjs');
 assert.doesNotMatch(watcher,/e2e\/faults|projection-failure\.json|E2E_PROJECTION_FAULT_DIR/);
});

test('009 daemon restart triggers only after a real implementation process launch',async()=>{
 const watch=await read('../e2e/runner/watch.mjs');
 assert.match(watch,/scenario.startsWith\('009-'\)/);
 assert.match(watch,/task.process.launched/);
 assert.match(watch,/daemon-restarted\.json/);
 assert.match(watch,/restart-daemon/);
});
