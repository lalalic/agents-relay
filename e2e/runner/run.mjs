#!/usr/bin/env node
// Manual E2E entry point: prepare one fresh round, then monitor it until PASS or a handoff-worthy suspect.
import {spawn, spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const argv=process.argv.slice(2);
const opt=(name,def='')=>{const i=argv.indexOf('--'+name);return i<0?def:argv[i+1]};
const required=name=>{const v=opt(name);if(!v)throw Error(`--${name} is required`);return v};
if(argv.includes('--help')){
  console.log(`Usage:\n  npm run e2e -- [--thread THREAD_ID] --scenario 001-happy-path --repo OWNER/REPO --checkout /path/to/repo --round N --objective-file /path/objective.md\n\nThread:\n  --thread THREAD_ID      reuse an existing ChatGPT thread\n  omit --thread           create a dedicated ChatGPT thread using npx browser-workspace\n\nAliases:\n  --thread-id THREAD_ID   same as --thread\n  --scenario 001          resolves to the canonical 001-* scenario\n\nThis command is manually triggered. It creates exactly one fresh E2E round with job create --initial-plan, then watches it. It never manually retries/reconciles/reviews/unblocks/merges the Job.`);
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
let threadId=opt('thread',opt('thread-id',''));
const base=opt('base','main');
const job=opt('job',`${scenario}-r${round}`);
const branch=opt('branch',`e2e/${scenario}-r${round}`);
const title=opt('title',`${scenario} round ${round}`);
const date=new Date().toISOString().slice(0,10);
const runDir=resolve(opt('run-dir',`e2e/runs/${date}/${scenario}/r${round}`));
function e2ePreflight(){
  // Task injection is declared by the E2E objective and consumed by Relay.
  // The controller does not inject or require any external injection command.
  if(!scenario.startsWith('001-')) return;
  const p=spawnSync('curl',['-fsS','http://127.0.0.1:8787/api/status'],{encoding:'utf8',timeout:10000,maxBuffer:1000000});
  if(p.error||p.status!==0)throw Error(p.error?.message||p.stderr||'Agents Relay status preflight unavailable');
  const status=JSON.parse(p.stdout);
  if(status.githubEnabled===true&&status.githubAuthenticated===false){
    const failure={event:'preflight-failed',scenario,round:Number(round),type:'PRECONDITION_GITHUB_AUTH_UNAVAILABLE',message:status.githubAuthError||'GitHub is enabled but authentication is unavailable'};
    mkdirSync(runDir,{recursive:true});
    writeFileSync(resolve(runDir,'preflight.json'),JSON.stringify(failure,null,2)+'\n');
    console.error(JSON.stringify(failure));
    process.exit(2);
  }
}
e2ePreflight();
if(!threadId){
  const dir=mkdtempSync(join(tmpdir(),'agents-relay-e2e-thread-'));
  const config=join(dir,'config.json');
  try{
    const message=[
      'Agents Relay production E2E repair thread.',
      `Scenario: ${scenario}`,
      `Round: ${round}`,
      `Workload repo: ${repo}`,
      'This thread is controlled by the E2E watcher. When a suspect is detected, continue the repair loop here: diagnose Relay, fix production code, test/deploy, cancel the failed round, then manually trigger the next fresh round with npm run e2e. Do not manually retry/reconcile/review/unblock/merge the Job under test.'
    ].join('\n');
    writeFileSync(config,JSON.stringify({message,reason:'Agents Relay E2E dedicated repair thread'}));
    const created=spawnSync('npx',['browser-workspace','platform','run','chatgpt','new-thread','--auto-session','--config',config],{cwd:root,encoding:'utf8',timeout:600000,maxBuffer:8e6});
    if(created.error||created.status!==0)throw Error(created.error?.message||created.stderr||created.stdout||'failed to create E2E ChatGPT thread');
    const envelope=JSON.parse(String(created.stdout||'').trim());
    const raw=envelope?.result?.stdout ?? envelope?.stdout ?? '';
    const receipt=typeof raw==='string' ? JSON.parse(raw.trim()) : raw;
    threadId=String(receipt?.thread_id||'').trim();
    if(!threadId)throw Error('browser-workspace new-thread did not return a durable thread_id');
    console.log(JSON.stringify({event:'thread-created',threadId,transport:'browser-workspace'},null,2));
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
const prep=[resolve(root,'e2e/runner/prepare-round.mjs'),'--repo',repo,'--checkout',checkout,'--scenario',scenario,'--round',round,'--objective-file',objectiveFile,'--base',base,'--job',job,'--branch',branch,'--title',title,'--run-dir',runDir];
const preparationStartedAt=Date.now();
const p=spawnSync(process.execPath,prep,{cwd:root,encoding:'utf8',timeout:240000,maxBuffer:8e6});
let receipt;
if(p.status===0&&!p.error){
  receipt=JSON.parse(p.stdout);
  console.log(JSON.stringify({event:'round-prepared',scenario,round:Number(round),jobId:receipt.jobId,branch:receipt.branch,sourceRef:receipt.sourceRef}));
}else{
  // Initial planning runs synchronously inside job create. It can fail AFTER
  // committing the local Job. Start the watcher for that Job regardless.
  const detail=p.error?.message||p.stderr||p.stdout||`prepare-round exited ${p.status}`;
  const lookup=spawnSync(process.execPath,[resolve(root,'dist/cli.js'),'job','show','--repo',repo,'--id',job],{cwd:root,encoding:'utf8',timeout:30000,maxBuffer:8e6});
  if(lookup.status!==0)throw Error(`Round preparation failed before Job creation: ${detail}`);
  const created=JSON.parse(lookup.stdout);
  if(created.repository!==repo||created.id!==job||Date.parse(created.createdAt)<preparationStartedAt-5000)
    throw Error(`Round preparation failed without a newly created matching Job: ${detail}`);
  receipt={jobId:job,branch,sourceRef:`refs/heads/${branch}`};
  mkdirSync(runDir,{recursive:true});
  writeFileSync(resolve(runDir,'round.json'),JSON.stringify({...receipt,repo,scenario,round:Number(round),preparationFailure:detail,createdAt:created.createdAt},null,2)+'\n');
  console.error(JSON.stringify({event:'round-preparation-partially-failed',jobId:job,message:detail,watcherWillStart:true}));
}
const watchArgs=[resolve(root,'e2e/runner/watch.mjs'),'--repo',repo,'--job',receipt.jobId,'--scenario',scenario,'--branch',process.env.E2E_RELAY_BRANCH||'test/v2-local-first-e2e-20261009','--thread',threadId,'--state',resolve(runDir,'watch-state.json'),'--out',resolve(runDir,'handoff.json'),'--expected-cancel',resolve(runDir,'expected-cancel.json')];
const child=spawn(process.execPath,watchArgs,{cwd:root,stdio:'inherit',env:{...process.env,E2E_CHATGPT_THREAD_ID:threadId}});
child.on('exit',(code,signal)=>{if(signal)console.error(`E2E watcher exited via ${signal}`);process.exitCode=code??1});
