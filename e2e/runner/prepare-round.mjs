#!/usr/bin/env node
// Prepare one fresh E2E round against any local Git repository without changing its current checkout.
// Relay owns the managed execution worktree. This runner only creates the source ref and bootstraps the Job.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
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
const cmd=[process.execPath,resolve(relayRoot,'dist/cli.js'),'job','create','--repo',repo,'--head',branch,'--base',base,'--id',jobId,'--title',title,'--objective-file',objectiveFile,'--mode','autonomous','--initial-plan'];
const created=run(relayRoot,cmd,180000);
const receipt={scenario,round,repo,repositoryCheckout,base,branch,sourceRef:`refs/heads/${branch}`,jobId,objectiveFile,createdAt:new Date().toISOString(),createResult:JSON.parse(created)};
writeFileSync(resolve(runDir,'round.json'),JSON.stringify(receipt,null,2)+'\n');
console.log(JSON.stringify(receipt,null,2));
