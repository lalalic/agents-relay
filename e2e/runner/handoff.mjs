#!/usr/bin/env node
// Deliver one E2E repair handoff through Browser Workspace's ChatGPT lifecycle action.
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
const payloadPath=process.argv[2];
if(!payloadPath){console.error('handoff payload path is required');process.exit(64)}
const threadId=process.env.E2E_CHATGPT_THREAD_ID?.trim();
if(!threadId){console.error('E2E_CHATGPT_THREAD_ID is required');process.exit(64)}
const payload=JSON.parse(readFileSync(payloadPath,'utf8'));
const message=payload.kind==='scenario_pass' ? [
 'The E2E controller VERIFIED PASS for '+payload.scenario+' in this ChatGPT thread.',
 'Finished Job: '+payload.jobId+'; external PR: '+payload.prNumber+'; checked terminal state: '+payload.jobState+'; GitHub state: '+(payload.githubState||'not enabled')+'.',
 'Evidence: '+JSON.stringify(payload.evidence||{}),
 'NOW continue the production E2E campaign in this same thread. Update the lifecycle coverage map and start the NEXT unpassed scenario through npm run e2e. Do not stop at this PASS; do not run overlapping scenarios.',
 'Every non-human-blocker scenario must finish with Job COMPLETED and GitHub MERGED if enabled. Continue until scenarios 001–010 all pass.'
].join('\n') : [
 'E2E runner detected a blocking defect; continue repairing NOW in this ChatGPT thread.',
 'The E2E runner is the controller; Agents Relay is the system under test.',
 'Do not manually retry/reconcile/review/unblock/merge the failed Job.',
 'Agents Relay branch: '+(payload.branch||'<unknown>'),
 'Workload repo: '+payload.repo,
 'Job under test: '+payload.jobId,
 'Issue evidence: '+JSON.stringify(payload.issue,null,2),
 'Recent events: '+JSON.stringify(payload.events||[],null,2),
 'Required in this turn: identify root cause, fix Agents Relay production code, run focused tests, deploy/bump E2E runtime when needed, cancel the failed round, then manually trigger the next fresh round with npm run e2e. Do not mutate this failed round into a pass.'
].join('\n');
const dir=mkdtempSync(join(tmpdir(),'agents-relay-e2e-handoff-'));
const config=join(dir,'config.json');
try{
  writeFileSync(config,JSON.stringify({thread_id:threadId,message,reason:'Agents Relay E2E suspect handoff'}));
  const result=spawnSync('npx',['browser-workspace','platform','run','chatgpt','new-turn','--auto-session','--config',config],{encoding:'utf8',timeout:600000,maxBuffer:8e6});
  if(result.error||result.status!==0){console.error(result.error?.message||result.stderr||result.stdout||'browser-workspace handoff failed');process.exit(result.status||1)}
  console.log(JSON.stringify({status:'submitted',thread_id:threadId,transport:'browser-workspace',output:String(result.stdout||'').trim()}));
} finally { rmSync(dir,{recursive:true,force:true}); }
