// Original Node public Unblock helper contracts, with full Task unblock
// mutation parity separately in head_to_head_atomic_public_apis.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import * as source from '../../dist/unblock.js';
const root=resolve(import.meta.dirname,'../..');const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const cases=[];const at='2026-11-18T00:00:00.000Z';
for(let i=0;i<120;i++){
 const task={id:'2',jobId:'17',kind:i%13?'work':'planner',agentName:i%5?'implementation':'troubleshooter',state:['BLOCKED','DRAFT','QUEUED','FAILED','SUCCEEDED'][i%5],updatedAt:at};
 if(i%3===0){task.unblock={reason:'fixture',source:'cli',baseline:{blockedAt:at,headSha:'old'},facts:['unblock: fixture'],currentHeadSha:'new'};}
 const job={id:'17',state:'ACTIVE',tasks:[task],plans:[]};
 if(i%4===0)job.plans.push({id:'plan-1',status:'SUCCEEDED',trigger:{source:'unblock',taskIds:['2']}});
 if(i%4===1)job.plans.push({id:'plan-1',status:'FAILED',trigger:{source:'unblock',taskIds:['2']}});
 if(i%7===0)job.changeCycle={taskIds:['2'],reason:'historical',facts:['history'],baselineHeadShas:['old'],source:'cli',currentHeadSha:'new'};
 if(i%14===0)job.changeCycle.consumedByPlannerTaskId='plan-1';
 cases.push({op:'certUnblockFacts',job,task});
}
function node(q){try{return {ok:true,value:JSON.parse(JSON.stringify({blocked:source.isEffectivelyBlocked(q.task),trigger:source.unconsumedUnblockTrigger(q.job)??null,newPlan:source.unblockNeedsNewPlan(q.job)}))};}catch(e){return{ok:false,error:e.message}}}
test('120 exact original Node/Rust unblock eligibility, trigger consumption and no-spin Plan facts',()=>{
 const expected=cases.map(node);
 const result=spawnSync(binary,[],{cwd:root,input:cases.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',timeout:50000,maxBuffer:8e6});
 assert.equal(result.status,0,result.stderr);
 const actual=result.stdout.trim().split('\n').map(JSON.parse);assert.equal(actual.length,cases.length);
 for(let i=0;i<cases.length;i++) assert.deepEqual(actual[i],expected[i],`Case ${i}: ${JSON.stringify({actual:actual[i],expected:expected[i]})}`);
 console.log('120 direct original Node/Rust Unblock helper fixtures passed');
});
