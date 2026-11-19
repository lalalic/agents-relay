// Both original Node src/execution-recovery.ts public operations versus Rust.
// Missing OS process store means generation-reclaim is injectable and no PID
// signals or external process groups are touched.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve} from 'node:path';
import {recoverExpiredExecutions,recoverStartupOrphans} from '../../dist/execution-recovery.js';
const root=resolve(import.meta.dirname,'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const NOW=1795000000000;
const lease=type=>({past:'2026-01-01T00:00:00.000Z',future:'2038-01-01T00:00:00.000Z',missing:null,invalid:'not-a-date'})[type];
function task(i){const adapter=['script','codex','chatgpt','z'][i%4],state=['RUNNING','QUEUED','FAILED','DRAFT','SUCCEEDED'][i%5];
 return {id:String(i+2),jobId:'17',agentName:'worker',adapter,kind:i%17===0?'planner':'work',state,
   attempt:1,maxAttempts:i%3?2:1,
   executionId:i%8===0?'':i%9===0?null:'execution-'+i,
   leaseOwner:i%11===0?'new-owner':i%13===0?'':'old-owner',
   leaseExpiresAt:lease(['past','future','missing','invalid'][i%4]),
   dependencies:[],createdAt:'2026-11-18T00:00:00.000Z',updatedAt:'2026-11-18T00:00:00.000Z'};
}
const cases=[];
for(let i=0;i<170;i++){
 const job={id:'17',repository:'fixture',state:'ACTIVE',tasks:Array.from({length:1+i%5},(_,j)=>task(i*5+j)),plans:[]};
 const latest=structuredClone(job);
 if(i%7===0)latest.tasks[0].executionId='stale-other-generation';
 if(i%11===0)latest.tasks[0].leaseOwner='new-owner';
 if(i%13===0)latest.tasks[0].state='SUCCEEDED';
 cases.push({op:'certExecutionRecovery',mode:i%2?'startup':'expired',job,latestJob:latest,owner:'new-owner',nowMs:NOW,allowReclaim:true});
}
function rust(){const p=spawnSync(bin,[],{cwd:root,input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:30000,maxBuffer:8e6});assert.equal(p.status,0,p.stderr);return p.stdout.trim().split('\n').map(JSON.parse);}
async function original(c){const recovered=[],job=structuredClone(c.job),latest=structuredClone(c.latestJob);
 const store={load:async()=>structuredClone(latest),saveTask:async()=>{}};
 const event=c.mode==='startup'?'execution.orphaned':'lease.expired';
 const reason=c.mode==='startup'?'startup_orphaned':'lease_expired';
 const ports={store,owner:c.owner,
  cancelGeneration:task=>recovered.push({id:task.id,executionId:task.executionId,event,reason}),
  cancelPlanner:()=>{},emitFailed:async()=>{}};
 try{if(c.mode==='startup')await recoverStartupOrphans(job,ports);
  else await recoverExpiredExecutions(job,c.nowMs,ports);
  return {ok:true,value:{recovered}};
 }catch(e){return {ok:false,error:e.message};}
}
test('170 source Node/Rust leased execution recover and startup orphan generation fences',async()=>{
 const expected=[];for(const c of cases)expected.push(await original(c));
 const actual=rust();assert.equal(actual.length,expected.length);
 for(let i=0;i<cases.length;i++)assert.deepEqual(actual[i],expected[i],`Recovery scenario ${i}`);
 console.log('170 exact Node/Rust generation-recovery observations');
});
