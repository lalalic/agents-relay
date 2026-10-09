#!/usr/bin/env node
// Prepare one fresh E2E round against any local Git repository without changing its current checkout.
// Relay owns the managed execution worktree. This runner only creates the source ref and bootstraps the Job.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
const relayRoot=resolve(import.meta.dirname,'../..');
const argv=process.argv.slice(2);
const opt=(name,def='')=>{const i=argv.indexOf('--'+name);return i<0?def:argv[i+1]};
const required=name=>{const v=opt(name);if(!v)throw Error(`--${name} is required`);return v};
const repo=required('repo');
const repositoryCheckout=resolve(required('checkout'));
const scenario=required('scenario');
const round=Number(required('round'));
const base=opt('base','main');
const branch=opt('branch',`e2e/${scenario}-r${round}`);
const jobId=opt('job',`${scenario}-r${round}`);
const title=opt('title',`${scenario} round ${round}`);
const objectiveFile=resolve(required('objective-file'));
const date=new Date().toISOString().slice(0,10);
const runDir=resolve(opt('run-dir',`e2e/runs/${date}/${scenario}/r${round}`));
if(!Number.isInteger(round)||round<1)throw Error('--round must be a positive integer');
if(!existsSync(objectiveFile))throw Error(`objective file not found: ${objectiveFile}`);
const run=(cwd,args,timeout=120000)=>{const p=spawnSync(args[0],args.slice(1),{cwd,encoding:'utf8',timeout,maxBuffer:8e6});if(p.status!==0)throw Error(p.stderr||p.stdout||`${args[0]} exited ${p.status}`);return p.stdout.trim()};
const tracked=run(repositoryCheckout,['git','status','--porcelain']).split('\n').filter(Boolean).filter(line=>!/^\?\? /.test(line));
if(tracked.length)throw Error('workload repository has tracked modifications; use a clean repository state');
const existing=spawnSync('git',['show-ref','--verify','--quiet',`refs/heads/${branch}`],{cwd:repositoryCheckout});
if(existing.status===0){
  const checkedOut=run(repositoryCheckout,['git','worktree','list','--porcelain']).split('\n\n').some(record=>record.split('\n').includes(`branch refs/heads/${branch}`));
  if(checkedOut)throw Error(`source branch is already checked out: ${branch}`);
  run(repositoryCheckout,['git','branch','-D',branch]);
}
run(repositoryCheckout,['git','branch',branch,base]);
mkdirSync(runDir,{recursive:true});

function repositoryBoundary(scenarioName){
  return `# E2E TEST WORKLOAD — ${scenarioName}\n\nThis Job exists only to validate the production Agents Relay lifecycle. It is not a product-development or Relay-repair Job.\n\n## Repository boundary\n\nAll workload, test, review-fix, and recovery changes for this Job MUST stay inside \`${repo}\` and its managed source branch. Do not create self-jobs, repair Jobs, branches, commits, or source changes in \`lalalic/agents-relay\` or any other repository.\n\nIf an Agents Relay runtime/orchestration defect is encountered, preserve exact evidence in this Job and stop. The external E2E controller owns repairing Agents Relay and starting a fresh round. Workers, reviewers, and troubleshooters in this Job must never repair Agents Relay itself.\n\nRelay/Graph owns automatic Troubleshooter creation, exact-original-Task recovery/retry, review/fix generation, final review orchestration, local merge, Job COMPLETED, and projected GitHub PR merge. Do not create replacement business Tasks or manually perform lifecycle effects.\n\n---\n\n`;
}

function withSetupWorktree(callback){
  const setupWorktree=resolve(runDir,'setup-worktree');
  if(existsSync(setupWorktree)){
    spawnSync('git',['worktree','remove','--force',setupWorktree],{cwd:repositoryCheckout,encoding:'utf8'});
    rmSync(setupWorktree,{recursive:true,force:true});
  }
  run(repositoryCheckout,['git','worktree','add',setupWorktree,branch]);
  try{return callback(setupWorktree)}finally{run(repositoryCheckout,['git','worktree','remove','--force',setupWorktree]);}
}

function prepareScenario002(){
  return withSetupWorktree(setupWorktree=>{
    mkdirSync(join(setupWorktree,'.e2e'),{recursive:true});
    mkdirSync(join(setupWorktree,'scripts'),{recursive:true});
    writeFileSync(join(setupWorktree,'.e2e','worker-blocker.json'),JSON.stringify({scenario:'002-worker-blocker-troubleshooter-recovery',round,blocker:'present'},null,2)+'\n');
    writeFileSync(join(setupWorktree,'scripts','e2e-002-check-blocker.mjs'),`#!/usr/bin/env node\nimport {existsSync} from 'node:fs';\nconst marker=new URL('../.e2e/worker-blocker.json',import.meta.url);\nif(existsSync(marker)){\n  console.error('E2E_RECOVERABLE_BLOCKER: .e2e/worker-blocker.json is present. Do not remove it from the implementation worker. Publish task.failed with this exact blocker evidence. Troubleshooter recovery must run: node scripts/e2e-002-clear-blocker.mjs, then retry the exact original task.');\n  process.exit(42);\n}\nconsole.log('E2E blocker cleared');\n`);
    writeFileSync(join(setupWorktree,'scripts','e2e-002-clear-blocker.mjs'),`#!/usr/bin/env node\nimport {existsSync,unlinkSync} from 'node:fs';\nconst marker=new URL('../.e2e/worker-blocker.json',import.meta.url);\nif(existsSync(marker))unlinkSync(marker);\nconsole.log('E2E recoverable blocker cleared');\n`);
    run(setupWorktree,['git','add','.e2e/worker-blocker.json','scripts/e2e-002-check-blocker.mjs','scripts/e2e-002-clear-blocker.mjs']);
    run(setupWorktree,['git','commit','-m',`test: prepare ${scenario} round ${round} blocker`]);
    const generated=resolve(runDir,'objective.generated.md');
    const baseObjective=readFileSync(objectiveFile,'utf8');
    writeFileSync(generated,repositoryBoundary(scenario)+`# Scenario 002 recovery protocol\n\nFor the FIRST implementation attempt, before making any requested product change, run:\n\n    node scripts/e2e-002-check-blocker.mjs\n\nIf it exits 42, the implementation worker MUST NOT remove or modify the blocker. It MUST publish canonical task.failed for the current execution, preserving the exact E2E_RECOVERABLE_BLOCKER evidence from stderr, then stop.\n\nOnly the automatic Troubleshooter is authorized to remove the blocker. It must inspect original Task event history, run \`node scripts/e2e-002-clear-blocker.mjs\`, commit the recovery change when needed, then reactivate/retry the EXACT original implementation Task through the dedicated recovery path.\n\nOn retry, run the guard again; it must report the blocker cleared before normal implementation continues.\n\n---\n\n${baseObjective}`);
    return generated;
  });
}

function prepareScenario003(){
  return withSetupWorktree(setupWorktree=>{
    mkdirSync(join(setupWorktree,'.e2e'),{recursive:true});
    mkdirSync(join(setupWorktree,'scripts'),{recursive:true});
    writeFileSync(join(setupWorktree,'.e2e','e2e-003-worker-gate.json'),JSON.stringify({scenario:'003-objective-exception-ladder',round,gate:'first-worker-failure-required'},null,2)+'\n');
    writeFileSync(join(setupWorktree,'scripts','e2e-003-check-worker-gate.mjs'),`#!/usr/bin/env node\nimport {existsSync} from 'node:fs';\nconst marker=new URL('../.e2e/e2e-003-worker-gate.json',import.meta.url);\nif(existsSync(marker)){\n  console.error('E2E003_FIRST_WORKER_FAILURE: first implementation attempt must fail now. Do not remove the marker. Publish canonical task.failed with this evidence. Automatic Troubleshooter must inspect events, run node scripts/e2e-003-clear-worker-gate.mjs, commit removal, then recover the EXACT original Task using the dedicated task recover path.');\n  process.exit(42);\n}\nconsole.log('E2E003_WORKER_GATE_CLEAR');\n`);
    writeFileSync(join(setupWorktree,'scripts','e2e-003-clear-worker-gate.mjs'),`#!/usr/bin/env node\nimport {existsSync,unlinkSync} from 'node:fs';\nconst marker=new URL('../.e2e/e2e-003-worker-gate.json',import.meta.url);\nif(existsSync(marker))unlinkSync(marker);\nconsole.log('E2E003_WORKER_GATE_CLEARED_BY_TROUBLESHOOTER');\n`);
    writeFileSync(join(setupWorktree,'scripts','e2e-003-review-gate.mjs'),`#!/usr/bin/env node\nimport {existsSync} from 'node:fs';\nconst one=new URL('../fixtures/e2e-003-r${round}-review-fix-1.json',import.meta.url);\nconst two=new URL('../fixtures/e2e-003-r${round}-review-fix-2.json',import.meta.url);\nif(!existsSync(one)){\n  console.log(JSON.stringify({stage:1,outcome:'changes_required',finding:'Create fixtures/e2e-003-r${round}-review-fix-1.json with JSON {"scenario":"e2e-003-objective-exception-ladder","round":${round},"reviewFix":1,"result":"addressed"} and extend the deterministic Node test for this round to assert those exact values. Run npm test and commit the fix.'}));\n  process.exit(11);\n}\nif(!existsSync(two)){\n  console.log(JSON.stringify({stage:2,outcome:'changes_required',finding:'Create fixtures/e2e-003-r${round}-review-fix-2.json with JSON {"scenario":"e2e-003-objective-exception-ladder","round":${round},"reviewFix":2,"result":"addressed"} and extend the deterministic Node test for this round to assert those exact values. Run npm test and commit the fix.'}));\n  process.exit(12);\n}\nconsole.log(JSON.stringify({stage:3,outcome:'approve',message:'Both round ${round} review-fix fixtures exist; approve only after verifying the requested implementation and npm test on this exact immutable head.'}));\n`);
    run(setupWorktree,['git','add','.e2e/e2e-003-worker-gate.json','scripts/e2e-003-check-worker-gate.mjs','scripts/e2e-003-clear-worker-gate.mjs','scripts/e2e-003-review-gate.mjs']);
    run(setupWorktree,['git','commit','-m',`test: prepare ${scenario} round ${round} gates`]);
    const generated=resolve(runDir,'objective.generated.md');
    const baseObjective=readFileSync(objectiveFile,'utf8');
    writeFileSync(generated,repositoryBoundary(scenario)+`# Scenario 003 exception-ladder protocol\n\n## Implementation protocol\n\nThe ORIGINAL implementation Task must run \`node scripts/e2e-003-check-worker-gate.mjs\` before any requested product change on every attempt. On attempt 1 it exits 42: publish canonical \`task.failed\` with the exact E2E003_FIRST_WORKER_FAILURE evidence and stop. The implementation worker MUST NOT clear the gate.\n\nOnly the automatic Troubleshooter may clear it. From the original failure evidence and event history, the Troubleshooter must run \`node scripts/e2e-003-clear-worker-gate.mjs\`, commit the marker removal, then recover the EXACT original implementation Task using the dedicated task-recover path. It must not create replacement implementation work.\n\nOn the retried original implementation attempt, the gate must print E2E003_WORKER_GATE_CLEAR. Then perform the requested workload change and tests normally.\n\n## Review protocol — mandatory for every final reviewer\n\nBefore deciding review outcome, run:\n\n    node scripts/e2e-003-review-gate.mjs\n\nThe script is an E2E acceptance oracle, not a product test failure. Exit 11 means REVIEW STAGE 1: emit canonical \`review.changes_required\` for the exact immutable head, with the script's single \`finding\` as a blocking finding. Do not implement it yourself.\n\nExit 12 means REVIEW STAGE 2: emit canonical \`review.changes_required\` for the new exact immutable head, again preserving the script's single \`finding\`. Do not implement it yourself.\n\nExit 0 with stage 3 means the forced rejection ladder is complete. Perform the normal independent review of requirements/tests on that exact head; approve only if genuinely correct.\n\nGraph must create the review-fix Tasks from those findings. No reviewer may create/edit/commit the requested fix itself.\n\n---\n\n${baseObjective}`);
    return generated;
  });
}

function prepareScenario004(){
  return withSetupWorktree(setupWorktree=>{
    mkdirSync(join(setupWorktree,'.e2e'),{recursive:true});
    mkdirSync(join(setupWorktree,'scripts'),{recursive:true});
    writeFileSync(join(setupWorktree,'.e2e','e2e-004-worker-failure.json'),JSON.stringify({scenario:'004-objective-recovery-exhaustion-escalation',round,gate:'fail-original-then-fail-troubleshooter'},null,2)+'\n');
    writeFileSync(join(setupWorktree,'scripts','e2e-004-fail-original.mjs'),`#!/usr/bin/env node\nimport {existsSync} from 'node:fs';\nconst marker=new URL('../.e2e/e2e-004-worker-failure.json',import.meta.url);\nif(!existsSync(marker)){console.error('E2E004 marker missing');process.exit(2);}\nconsole.error('E2E004_ORIGINAL_FAILURE: publish canonical task.failed now. E2E004_TROUBLESHOOTER_MUST_FAIL: the automatic Troubleshooter must inspect event history, then publish canonical task.failed with message E2E004_TROUBLESHOOTER_FAILURE and stop. It MUST NOT call task recover, retry/unblock the original Task, create replacement work, invoke escalation, or repair/remove this marker.');\nprocess.exit(44);\n`);
    run(setupWorktree,['git','add','.e2e/e2e-004-worker-failure.json','scripts/e2e-004-fail-original.mjs']);
    run(setupWorktree,['git','commit','-m',`test: prepare ${scenario} round ${round} failure gates`]);
    const generated=resolve(runDir,'objective.generated.md');
    const baseObjective=readFileSync(objectiveFile,'utf8');
    writeFileSync(generated,repositoryBoundary(scenario)+`# Scenario 004 recovery-exhaustion protocol\n\nThe original implementation Task must run \`node scripts/e2e-004-fail-original.mjs\` as its first work action after task.started. Exit 44 is the required scenario trigger. Publish canonical \`task.failed\` preserving the complete E2E004_ORIGINAL_FAILURE / E2E004_TROUBLESHOOTER_MUST_FAIL stderr and stop. Do not change the marker or perform product work.\n\nThe automatically-created Troubleshooter must still perform its mandatory event-history diagnosis. When it sees E2E004_TROUBLESHOOTER_MUST_FAIL in the original failure evidence, this is an E2E protocol instruction: publish canonical \`task.failed\` with message exactly \`E2E004_TROUBLESHOOTER_FAILURE\` and stop. Do not call task recover, do not retry or unblock the original Task, do not invoke escalation, and do not create replacement work. Relay itself must then own recovery exhaustion.\n\nThe expected final state is intentionally not COMPLETED: original Task FAILED, exactly one Troubleshooter FAILED, one durable recovery.exhausted fact, Job ACTIVE with runtime FAILED, no review and no merge.\n\n---\n\n${baseObjective}`);
    return generated;
  });
}

function prepareScenarioFixture(){
  if(scenario.startsWith('002-')) return prepareScenario002();
  if(scenario.startsWith('003-')) return prepareScenario003();
  if(scenario.startsWith('004-')) return prepareScenario004();
  const generated=resolve(runDir,'objective.generated.md');
  writeFileSync(generated,repositoryBoundary(scenario)+readFileSync(objectiveFile,'utf8'));
  return generated;
}

const effectiveObjectiveFile=prepareScenarioFixture();
const cmd=[process.execPath,resolve(relayRoot,'dist/cli.js'),'job','create','--repo',repo,'--head',branch,'--base',base,'--id',jobId,'--title',title,'--objective-file',effectiveObjectiveFile,'--mode','autonomous','--initial-plan'];
const created=run(relayRoot,cmd,180000);
const receipt={scenario,round,repo,repositoryCheckout,base,branch,sourceRef:`refs/heads/${branch}`,jobId,objectiveFile:effectiveObjectiveFile,createdAt:new Date().toISOString(),createResult:JSON.parse(created)};
writeFileSync(resolve(runDir,'round.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
