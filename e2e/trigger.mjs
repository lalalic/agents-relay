#!/usr/bin/env node
// Explicit E2E workload trigger. Only the test Job uses Relay; fixes remain outside it.
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'..'), argv=process.argv.slice(2);
const option=(name,def)=>{const n=argv.indexOf('--'+name);return n<0?def:argv[n+1]};
const repo=option('repo','lalalic/agents-relay-e2e'),pr=option('pr','2');
const id=option('job','e2e-autonomy-smoke-20261008'),mode=option('mode','retry');
const bin=resolve(root,'dist/cli.js');
const cmd=(args)=>{const p=spawnSync(process.execPath,[bin,...args],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8e6});if(p.status!==0)throw Error(p.stderr||p.stdout||`exit ${p.status}`);return p.stdout};
if(!['plan','retry','unblock'].includes(mode))throw Error('mode must be plan, retry, or unblock');
const target=['--repo',repo,'--pr',pr,'--id',id];
let action;
if(mode==='plan')action=['plan',...target];
else{
 const j=JSON.parse(cmd(['job','show',...target]));
 const taskId=option('task-id',null);
 if(!taskId)throw Error(`${mode} requires explicit --task-id to prevent unrelated Task changes`);
 const task=j.tasks?.find(t=>t.id===taskId);
 const requiredState=mode==='retry'?'FAILED':'BLOCKED';
 if(!task||task.state!==requiredState)throw Error(`Task ${taskId} must be ${requiredState}; observed ${task?.state||'missing'}`);
 action=['task',mode,...target,'--task-id',taskId];
}
console.log(JSON.stringify({mode,repo,pr,jobId:id,argv:action,dryRun:argv.includes('--dry-run')}));
if(!argv.includes('--dry-run'))process.stdout.write(cmd(action));
