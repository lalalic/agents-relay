import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {drainPlannerUnblocks} from '../dist/planner-runtime.js';

const intent=(id)=>({repository:'owner/repo',prNumber:0,jobId:id,taskId:'task',resolutionMode:'merge'});
function harness(start){
 let job={id:'blocker',plans:[{id:'plan-1',status:'SUCCEEDED',pendingUnblocks:start}]};
 const copy=()=>structuredClone(job);
 const store={load:async()=>copy(),mutateJob:async(_id,fn)=>{job=fn(copy());return copy();}};
 return {store,get:copy,append:(x)=>{job.plans[0].pendingUnblocks.push(x);}};
}

test('overlapping unblock drains do not resurrect acknowledged entries',async()=>{
 const h=harness([intent('a'),intent('b')]);
 let release;const gate=new Promise(r=>release=r);
 let registered=0;
 h.store.registerBlockerDependent=async(_job,item)=>{registered++;if(item.jobId==='a'&&registered===1)await gate;};
 const ports={store:h.store};
 const first=drainPlannerUnblocks(ports,'blocker','plan-1');
 await Promise.resolve();
 await drainPlannerUnblocks(ports,'blocker','plan-1');
 release();await first;
 assert.equal(h.get().plans[0].pendingUnblocks,undefined);
});

test('new unblock intent inserted during registration survives stale acknowledgment',async()=>{
 const h=harness([intent('a')]);
 let release;const gate=new Promise(r=>release=r);
 h.store.registerBlockerDependent=async()=>{await gate;};
 const run=drainPlannerUnblocks({store:h.store},'blocker','plan-1');
 await Promise.resolve();
 h.append(intent('new'));
 release();await run;
 assert.deepEqual(h.get().plans[0].pendingUnblocks,[intent('new')]);
});

test('registered unblock survives failure before SQLite acknowledgment and is retried',async()=>{
 const h=harness([intent('a')]);let calls=0;
 h.store.registerBlockerDependent=async()=>{calls++;};
 const normal=h.store.mutateJob;
 h.store.mutateJob=async()=>{throw new Error('transaction interrupted');};
 await assert.rejects(drainPlannerUnblocks({store:h.store},'blocker','plan-1'),/transaction interrupted/);
 assert.deepEqual(h.get().plans[0].pendingUnblocks,[intent('a')]);
 h.store.mutateJob=normal;
 await drainPlannerUnblocks({store:h.store},'blocker','plan-1');
 assert.equal(calls,2);
 assert.equal(h.get().plans[0].pendingUnblocks,undefined);
});

import {reviewGenerationMatches} from '../dist/review-generation-fence.js';
test('competing newer review generation rejects older result in SQLite mutation',async()=>{
 const sha='a'.repeat(40), newer='b'.repeat(40);
 const task={id:'review-old',agentName:'reviewer',state:'RUNNING',reviewHeadSha:sha,executionId:'execution-old'};
 const original={id:'job',state:'ACTIVE',tasks:[task],review:{taskId:task.id,headSha:sha,outcome:'pending'}};
 const newerTask={...task,id:'review-new',reviewHeadSha:newer,executionId:'execution-new'};
 const raced={...structuredClone(original),headSha:newer,tasks:[task,newerTask],review:{taskId:newerTask.id,headSha:newer,outcome:'pending'}};
 assert.equal(reviewGenerationMatches(original,original,task,sha),true);
 assert.equal(reviewGenerationMatches(raced,original,task,sha),false);
 const sameHeadCompeting={...raced,headSha:sha,review:{taskId:newerTask.id,headSha:sha,outcome:'pending'}};
 assert.equal(reviewGenerationMatches(sameHeadCompeting,original,task,sha),false);
 const staleExecution={...original,tasks:[{...task,executionId:'execution-retry'}]};
 assert.equal(reviewGenerationMatches(staleExecution,original,task,sha),false);
 const advancedVerdict={...original,review:{...original.review,outcome:'approved'}};
 assert.equal(reviewGenerationMatches(advancedVerdict,original,task,sha),false);
});
