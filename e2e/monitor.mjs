#!/usr/bin/env node
// Read-only production-path E2E monitor. Does not bypass Relay's workflow.
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
const args=process.argv.slice(2);
const opt=(name,def)=>{const i=args.indexOf(name);return i<0?def:args[i+1]};
const repo=opt('--repo','lalalic/agents-relay-e2e');
const pr=Number(opt('--pr','2'));
const id=opt('--job','e2e-autonomy-smoke-20261008');
const report=resolve(opt('--output',`e2e/reports/pr-${pr}.json`));
const bin=resolve('dist/cli.js');
function command(exe,argv) {
 const x=spawnSync(exe,argv,{encoding:'utf8',timeout:30000,maxBuffer:8*1024*1024});
 if(x.error||x.status!==0)throw Error(`${exe} exited ${x.status}: ${x.error?.message||x.stderr?.slice(-400)||''}`);
 return x.stdout;
}
const job=JSON.parse(command(process.execPath,[bin,'job','show','--repo',repo,'--pr',String(pr),'--id',id]));
const gh=JSON.parse(command('gh',['pr','view',String(pr),'-R',repo,'--json','state,mergedAt,headRefOid,url']));
const task=job.tasks||[], plans=job.plans||[];
const issues=[];
if(plans.some(x=>x.status==='FAILED'))issues.push({code:'PLANNER_FAILED',items:plans.filter(x=>x.status==='FAILED').map(x=>({id:x.id,error:x.error}))});
if(task.some(x=>x.state==='FAILED'))issues.push({code:'TASK_FAILED',items:task.filter(x=>x.state==='FAILED').map(x=>({id:x.id,error:x.error}))});
if(job.state==='COMPLETED'&&gh.state!=='MERGED')issues.push({code:'DURABLE_GITHUB_MISMATCH'});
if(gh.state==='MERGED'&&job.state!=='COMPLETED')issues.push({code:'MERGED_BUT_JOB_NOT_COMPLETED'});
if(job.state==='COMPLETED'&&task.some(x=>x.state==='FAILED'))issues.push({code:'COMPLETED_WITH_FAILED_TASKS'});
if(job.state==='ACTIVE'&&!task.some(x=>['QUEUED','RUNNING'].includes(x.state))&&plans.length&&plans.every(x=>x.status==='FAILED'))issues.push({code:'NO_EXECUTABLE_WORK'});
const snapshot={observedAt:new Date().toISOString(),repo,pr,jobId:id,jobState:job.state,prState:gh.state,headSha:gh.headRefOid,plans:plans.map(x=>({id:x.id,status:x.status,error:x.error??null})),tasks:task.map(x=>({id:x.id,state:x.state,attempt:x.attempt,error:x.error??null,executionId:x.executionId??null})),issues,pass:job.state==='COMPLETED'&&gh.state==='MERGED'&&issues.length===0};
mkdirSync(dirname(report),{recursive:true});writeFileSync(report,JSON.stringify(snapshot,null,2)+'\n');
console.log(JSON.stringify(snapshot,null,2));
if(!snapshot.pass)process.exitCode=1;
