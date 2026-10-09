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
  assert.match(source,/UNEXPECTED_EXTRA_TROUBLESHOOTER/);
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

test('scenario 004 installs deterministic failed-recovery gate and watcher accepts only durable exhaustion', async()=>{
  const prepare=await read('../e2e/runner/prepare-round.mjs');
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(prepare,/function prepareScenario004/);
  assert.match(prepare,/E2E004_TROUBLESHOOTER_MUST_FAIL/);
  assert.match(prepare,/E2E004_TROUBLESHOOTER_FAILURE/);
  assert.match(watch,/function scenario004Passed/);
  assert.match(watch,/recoveryFailures/);
  assert.match(watch,/recoveryExhausted/);
  assert.match(watch,/RECURSIVE_RECOVERY/);
  assert.match(watch,/expectedTerminalFailure:true/);
});

test('completed Job allows bounded GitHub projection convergence before blocking handoff', async()=>{
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(watch,/projectionPendingSince/);
  assert.match(watch,/pendingMs>=30000/);
  assert.match(watch,/GITHUB_PR_NOT_MERGED/);
  assert.match(watch,/projectionPendingSince=null/);
});


test('GitHub-enabled completed Job requires external MERGED before PASS', async()=>{
  const watch=await read('../e2e/runner/watch.mjs');
  assert.match(watch,/const externalReady=!github\.enabled \|\| external\?\.githubState==='MERGED'/);
  assert.match(watch,/j\.state==='COMPLETED'&&!issue&&externalReady/);
});
