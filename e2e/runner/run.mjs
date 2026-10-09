#!/usr/bin/env node
// Manual E2E entry point: prepare one fresh round, then monitor it until PASS or a handoff-worthy suspect.
import {spawn, spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const argv=process.argv.slice(2);
const opt=(name,def='')=>{const i=argv.indexOf('--'+name);return i<0?def:argv[i+1]};
const required=name=>{const v=opt(name);if(!v)throw Error(`--${name} is required`);return v};
if(argv.includes('--help')){
  console.log(`Usage:\n  npm run e2e -- --thread THREAD_ID --scenario 001-happy-path --repo OWNER/REPO --checkout /path/to/repo --round N --objective-file /path/objective.md\n\nAliases:\n  --thread-id THREAD_ID   same as --thread\n  --scenario 001          resolves to the canonical 001-* scenario\n\nThis command is manually triggered. It creates exactly one fresh E2E round with job create --initial-plan, then watches it. It never manually retries/reconciles/reviews/unblocks/merges the Job.`);
  process.exit(0);
}
const repo=required('repo'),checkout=resolve(required('checkout'));
const scenarioArg=required('scenario');
const scenarioDir=resolve(root,'e2e/scenarios');
let scenario=scenarioArg;
if(/^\d{3}$/.test(scenarioArg)){
  const {readdirSync}=await import('node:fs');
  const matches=readdirSync(scenarioDir).filter(name=>name.startsWith(scenarioArg+'-')&&name.endsWith('.md'));
  if(matches.length!==1)throw Error(`--scenario ${scenarioArg} did not resolve to exactly one canonical scenario`);
  scenario=matches[0].replace(/\.md$/,'');
}
const scenarioFile=resolve(scenarioDir,scenario+'.md');
if(!existsSync(scenarioFile))throw Error(`unknown scenario: ${scenarioArg}`);
const round=required('round'),objectiveFile=resolve(required('objective-file'));
const threadId=opt('thread',opt('thread-id',''));
if(!threadId)throw Error('--thread is required');
const base=opt('base','main');
const job=opt('job',`${scenario}-r${round}`);
const branch=opt('branch',`e2e/${scenario}-r${round}`);
const title=opt('title',`${scenario} round ${round}`);
const date=new Date().toISOString().slice(0,10);
const runDir=resolve(opt('run-dir',`e2e/runs/${date}/${scenario}/r${round}`));
const prep=[resolve(root,'e2e/runner/prepare-round.mjs'),'--repo',repo,'--checkout',checkout,'--scenario',scenario,'--round',round,'--objective-file',objectiveFile,'--base',base,'--job',job,'--branch',branch,'--title',title,'--run-dir',runDir];
const p=spawnSync(process.execPath,prep,{cwd:root,encoding:'utf8',timeout:240000,maxBuffer:8e6});
if(p.error||p.status!==0)throw Error(p.error?.message||p.stderr||p.stdout||`prepare-round exited ${p.status}`);
const receipt=JSON.parse(p.stdout);
console.log(JSON.stringify({event:'round-prepared',scenario,round:Number(round),jobId:receipt.jobId,branch:receipt.branch,worktree:receipt.worktree},null,2));
const watchArgs=[resolve(root,'e2e/runner/watch.mjs'),'--repo',repo,'--job',receipt.jobId,'--branch',process.env.E2E_RELAY_BRANCH||'test/v2-local-first-e2e-20261009','--thread-id',threadId,'--state',resolve(runDir,'watch-state.json'),'--out',resolve(runDir,'handoff.json')];
const child=spawn(process.execPath,watchArgs,{cwd:root,stdio:'inherit',env:{...process.env,E2E_CHATGPT_THREAD_ID:threadId}});
child.on('exit',(code,signal)=>{if(signal)console.error(`E2E watcher exited via ${signal}`);process.exitCode=code??1});
