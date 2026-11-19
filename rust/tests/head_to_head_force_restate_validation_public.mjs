// All 6 original Node src/force-restate-validation.ts public runtime functions
// compared directly with native Rust facts and History Cleanup. No live Jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as original from '../../dist/force-restate-validation.js';
const repo=resolve(import.meta.dirname,'../..');
const bin=resolve(repo,'rust/target/debug/relay-rust2-parity');
const now='2026-11-18T20:00:00.000Z';
const base=(i)=>({id:'17',state:['ACTIVE','COMPLETED','PAUSED'][i%3],repository:'fixture',
 plans:[{id:'plan-1',status:i%5?'SUCCEEDED':'FAILED',objectiveStatus:i%4?'satisfied':'in_progress'}],
 tasks:[{id:'2',jobId:'17',agentName:'implementation',kind:'work',adapter:'codex',
   state:['SUCCEEDED','FAILED','QUEUED','DRAFT','RUNNING','BLOCKED'][i%6],
   dependencies:[],capabilities:['model'],workerRequirements:{capabilities:['model']},
   routing:{provider:'codex'},attempt:1,maxAttempts:3},
   {id:'3',jobId:'17',agentName:'job-acceptance-reviewer',kind:'work',
   state:['SUCCEEDED','FAILED','DRAFT'][i%3],dependencies:[],attempt:1,maxAttempts:3}]});
const candidates=[{adapter:'codex',workerId:'codex',runtime:'codex',availability:'available',
 capabilities:['model','coding'],resourceHealthy:true}];
const fixtures=[];
for(let i=0;i<75;i++){
 const job=base(i);
 if(i%7===0)job.tasks[0].dependencies=['3'];
 if(i%8===0)job.tasks[0].executionId='e-1';
 if(i%9===0)job.tasks[0].leaseOwner='host';
 if(i%11===0)job.tasks[0].resolutionClassification={kind:'superseded',targetTaskId:'3'};
 if(i%13===0)job.tasks[0].error='worker_process_failed';
 if(i%17===0){job.tasks[0].agentName='troubleshooter';job.tasks[0].recoveryPlanId='plan-1';job.tasks[0].result={data:{evidence:'proof',unblock_conditions:'yes'}};}
 const cleanup=[],expected=[];
 if(i%4===0){expected.push('2');cleanup.push({taskId:'2',outcome:'unresolved',reason:'uncertain'});}
 if(i%5===0){expected.push('missing');}
 if(i%6===0){cleanup.push({taskId:'3',outcome:'unresolved',reason:'out of scope'});}
 fixtures.push({op:'certForceRestateValidation',job,candidates:i%3?candidates:[],expected,cleanup,planId:'plan-1',now});
}
function node(input){
 const job=structuredClone(input.job);
 try {
 const facts={
   runnable:original.forceRestateRunnable(job,input.candidates),
   waiting:original.forceRestateDependencyWaiting(job,input.candidates),
   blocked:original.forceRestateBlocked(job,input.planId),
   converged:original.forceRestateConverged(job,input.planId,input.candidates),
   review:original.objectiveSatisfiedForReview(job),
 };
 const cleanup=original.applyPlannerHistoryCleanup(job,input.expected,input.cleanup,input.now);
 return {ok:true,value:{facts,cleanup,job}};
 }catch(e){return {ok:false,error:e.message}}
}
test('75 direct original Node/Rust public Force Restate validation and history mutations',()=>{
 const expected=fixtures.map(node);
 const proc=spawnSync(bin,[],{cwd:repo,input:fixtures.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:50000,maxBuffer:5e6});
 assert.equal(proc.status,0,proc.stderr);
 const actual=proc.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,expected.length);
 for(let i=0;i<actual.length;i++)assert.deepEqual(actual[i],expected[i],`Original API fixture ${i}`);
 console.log('75 x 6 original Node/Rust Force Restate API observations match exactly');
});
