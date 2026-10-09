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

function prepareScenarioFixture(){
  if(!scenario.startsWith('002-')) return objectiveFile;
  const setupWorktree=resolve(runDir,'setup-worktree');
  if(existsSync(setupWorktree)){
    spawnSync('git',['worktree','remove','--force',setupWorktree],{cwd:repositoryCheckout,encoding:'utf8'});
    rmSync(setupWorktree,{recursive:true,force:true});
  }
  run(repositoryCheckout,['git','worktree','add',setupWorktree,branch]);
  try{
    mkdirSync(join(setupWorktree,'.e2e'),{recursive:true});
    mkdirSync(join(setupWorktree,'scripts'),{recursive:true});
    writeFileSync(join(setupWorktree,'.e2e','worker-blocker.json'),JSON.stringify({scenario:'002-worker-blocker-troubleshooter-recovery',round,blocker:'present'},null,2)+'\n');
    writeFileSync(join(setupWorktree,'scripts','e2e-002-check-blocker.mjs'),`#!/usr/bin/env node\nimport {existsSync} from 'node:fs';\nconst marker=new URL('../.e2e/worker-blocker.json',import.meta.url);\nif(existsSync(marker)){\n  console.error('E2E_RECOVERABLE_BLOCKER: .e2e/worker-blocker.json is present. Do not remove it from the implementation worker. Publish task.failed with this exact blocker evidence. Troubleshooter recovery must run: node scripts/e2e-002-clear-blocker.mjs, then retry the exact original task.');\n  process.exit(42);\n}\nconsole.log('E2E blocker cleared');\n`);
    writeFileSync(join(setupWorktree,'scripts','e2e-002-clear-blocker.mjs'),`#!/usr/bin/env node\nimport {existsSync,unlinkSync} from 'node:fs';\nconst marker=new URL('../.e2e/worker-blocker.json',import.meta.url);\nif(existsSync(marker))unlinkSync(marker);\nconsole.log('E2E recoverable blocker cleared');\n`);
    run(setupWorktree,['git','add','.e2e/worker-blocker.json','scripts/e2e-002-check-blocker.mjs','scripts/e2e-002-clear-blocker.mjs']);
    run(setupWorktree,['git','commit','-m',`test: prepare ${scenario} round ${round} blocker`]);
    const generated=resolve(runDir,'objective.generated.md');
    const baseObjective=readFileSync(objectiveFile,'utf8');
    writeFileSync(generated,`# E2E Scenario 002 recovery protocol\n\nThis Job intentionally begins with one recoverable implementation blocker.\n\nFor the FIRST implementation attempt, before making any requested product change, run:\n\n    node scripts/e2e-002-check-blocker.mjs\n\nIf it exits 42, the implementation worker MUST NOT remove or modify the blocker. It MUST publish canonical task.failed for the current execution, preserving the exact E2E_RECOVERABLE_BLOCKER evidence from stderr, then stop. This first failure is required scenario trigger evidence.\n\nOnly the automatic Troubleshooter recovery is authorized to remove the blocker. The Troubleshooter must inspect the original Task event history, diagnose the marker as the blocker, run:\n\n    node scripts/e2e-002-clear-blocker.mjs\n\ncommit that recovery change if required by the managed source branch, then reactivate/retry the EXACT original implementation Task and verify progress. Do not create a replacement implementation business Task.\n\nOn the retried implementation attempt, run the guard again. It must print E2E blocker cleared before normal implementation continues.\n\n---\n\n${baseObjective}`);
    return generated;
  } finally {
    run(repositoryCheckout,['git','worktree','remove','--force',setupWorktree]);
  }
}

const effectiveObjectiveFile=prepareScenarioFixture();
const cmd=[process.execPath,resolve(relayRoot,'dist/cli.js'),'job','create','--repo',repo,'--head',branch,'--base',base,'--id',jobId,'--title',title,'--objective-file',effectiveObjectiveFile,'--mode','autonomous','--initial-plan'];
const created=run(relayRoot,cmd,180000);
const receipt={scenario,round,repo,repositoryCheckout,base,branch,sourceRef:`refs/heads/${branch}`,jobId,objectiveFile:effectiveObjectiveFile,createdAt:new Date().toISOString(),createResult:JSON.parse(created)};
writeFileSync(resolve(runDir,'round.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
