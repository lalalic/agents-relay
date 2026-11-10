import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { deriveJobRuntimeStatus, implementationComplete, implementationTasks } from '../dist/runtime-status.js';

const now=()=>new Date().toISOString();
const task=(id,state='QUEUED',agentName)=>({jobId:'j',id,kind:'work',agentName,parentTaskId:null,dependencies:[],capabilities:[],adapter:'orchestrator',input:'x',state,attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:0,createdAt:now(),updatedAt:now(),continuation:null,continuationDeliveredAt:null});
const job=(tasks=[],overrides={})=>({id:'j',title:'x',reviewEnabled:false,prNumber:1,repository:'owner/repo',state:'ACTIVE',continuation:null,createdAt:now(),updatedAt:now(),tasks,...overrides});

test('job runtime status is derived independently from lifecycle state',()=>{
  assert.equal(deriveJobRuntimeStatus(job([],{state:'DRAFT'})),'IDLE');
  assert.equal(deriveJobRuntimeStatus(job([task('blocked','BLOCKED'),task('failed','FAILED'),task('running','RUNNING')])),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([task('blocked','BLOCKED'),task('failed','FAILED'),task('queued','QUEUED')])),'QUEUED');
  assert.equal(deriveJobRuntimeStatus(job([task('blocked','BLOCKED')])),'BLOCKED');
  assert.equal(deriveJobRuntimeStatus(job([task('failed','FAILED')])),'FAILED');
  assert.equal(deriveJobRuntimeStatus(job([task('held','DRAFT')])),'WAITING');
  assert.equal(deriveJobRuntimeStatus(job([task('done','SUCCEEDED')],{autoMerge:false,reviewEnabled:false})),'MERGE_PENDING');
});



test('draft reviewer does not mask running or queued implementation',()=>{
  const review=task('review','DRAFT','reviewer');
  assert.equal(deriveJobRuntimeStatus(job([task('implement','RUNNING','implementation'),review],{reviewEnabled:true})),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([task('implement','QUEUED','implementation'),review],{reviewEnabled:true})),'QUEUED');
  assert.equal(deriveJobRuntimeStatus(job([task('implement','SUCCEEDED','implementation'),review],{reviewEnabled:true})),'WAITING');
  assert.equal(deriveJobRuntimeStatus(job([task('implement','SUCCEEDED','implementation'),task('review','RUNNING','reviewer')],{reviewEnabled:true})),'REVIEWING');
});

test('REVIEWING requires a running reviewer even when review metadata says started',()=>{
  const base={reviewEnabled:true,review:{taskId:'review',headSha:'abc',outcome:'started',updatedAt:now()}};
  assert.equal(deriveJobRuntimeStatus(job([task('implement','SUCCEEDED','implementation'),task('review','QUEUED','reviewer')],base)),'QUEUED');
  assert.equal(deriveJobRuntimeStatus(job([task('implement','SUCCEEDED','implementation'),task('review','DRAFT','reviewer')],base)),'WAITING');
  assert.equal(deriveJobRuntimeStatus(job([task('implement','SUCCEEDED','implementation'),task('review','RUNNING','reviewer')],base)),'REVIEWING');
});

test('planner failure without tasks is FAILED, planning is RUNNING rather than IDLE',()=>{
  const plan={id:'plan-1',status:'FAILED'};
  assert.equal(deriveJobRuntimeStatus(job([],{plans:[plan]})),'FAILED');
  assert.equal(deriveJobRuntimeStatus(job([],{plans:[{...plan,status:'PLANNING'}]})),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([task('worker','RUNNING')],{plans:[plan]})),'RUNNING');
});

test('stale targeted revision children are preserved but do not block implementation completion',()=>{
  const owner=task('owner','SUCCEEDED','implementation');
  const child={...task('revision','CANCELLED','implementation'),revision:{kind:'targeted',originalTaskId:'owner',reviewTaskId:'review',basedOnHeadSha:'old',requestIds:['request']}};
  const target=job([owner,child],{reviewRevisionRequests:[{requestId:'request',reviewTaskId:'review',reviewExecutionId:'old-exec',reviewHeadSha:'old',originalTaskId:'owner',findings:[],createdAt:now(),status:'stale',revisionTaskId:'revision',feedbackOrigin:'final-review'}]});
  assert.deepEqual(implementationTasks(target).map(item=>item.id),['owner']);
  assert.equal(implementationComplete(target),true);
  target.reviewRevisionRequests[0].status='queued';
  assert.equal(implementationComplete(target),false);
  target.reviewRevisionRequests[0].status='stale';
  target.tasks[1].state='FAILED';
  target.tasks[1].error='Historical failure from the old review head';
  assert.equal(implementationComplete(target),true);
  assert.notEqual(deriveJobRuntimeStatus(target),'FAILED','stale historical revision failure does not fail the current Job');
  assert.equal(target.tasks[1].error,'Historical failure from the old review head');
});


test('Shortcut Job runtime distinguishes external trigger from Relay queue and merge',()=>{
 const base={executionMode:'shortcut',contentOnly:true,prNumber:0,autoMerge:false,reviewEnabled:false};
 assert.equal(deriveJobRuntimeStatus(job([task('entry','QUEUED')],base)),'WAITING');
 const active={...task('entry','RUNNING'),executionId:'exec-1',leaseOwner:'shortcut-owner',leaseExpiresAt:new Date(Date.now()+60_000).toISOString()};
 assert.equal(deriveJobRuntimeStatus(job([active],base)),'RUNNING');
 assert.equal(deriveJobRuntimeStatus(job([task('entry','SUCCEEDED')],base)),'WAITING');
 assert.equal(deriveJobRuntimeStatus(job([task('entry','QUEUED')],{...base,state:'DRAFT'})),'IDLE');
 assert.equal(deriveJobRuntimeStatus(job([task('entry','SUCCEEDED')],{...base,state:'COMPLETED'})),'COMPLETED');
 const parent=active;const child={...task('shortcut-entry-director','BLOCKED'),parentTaskId:'entry'};
 assert.equal(deriveJobRuntimeStatus(job([parent,child],base)),'BLOCKED');
 assert.equal(deriveJobRuntimeStatus(job([parent,{...child,state:'RUNNING',executionId:'child-exec',leaseOwner:'child-owner',leaseExpiresAt:new Date(Date.now()+60_000).toISOString()}],base)),'RUNNING');
});

test('Shortcut runtime requires a live durable execution lease to display RUNNING',()=>{
 const base={executionMode:'shortcut',contentOnly:true,prNumber:0,reviewEnabled:false};
 const active={...task('entry','RUNNING'),executionId:'exec-1',leaseOwner:'shortcut-owner',leaseExpiresAt:new Date(Date.now()+60_000).toISOString()};
 const cases=[
   {...active,leaseExpiresAt:new Date(Date.now()-60_000).toISOString()},
   {...active,leaseExpiresAt:'not-a-date'},
   {...active,leaseExpiresAt:null},
   {...active,leaseOwner:null},
   {...active,executionId:null},
   task('entry','RUNNING'),
 ];
 for(const stale of cases)assert.equal(deriveJobRuntimeStatus(job([stale],base)),'BLOCKED');
 assert.equal(deriveJobRuntimeStatus(job([active],base)),'RUNNING');
 assert.equal(deriveJobRuntimeStatus(job([active],{...base,pause:{generation:1,requestedAt:now()}})),'WAITING');
 assert.equal(deriveJobRuntimeStatus(job([task('entry','RUNNING')],{state:'ACTIVE'})),'RUNNING','normal jobs retain their original status mapping');
});

test('Shortcut event wait is WAITING without an active runner, but not on stale receipts',()=>{
 const base={executionMode:'shortcut',contentOnly:true,prNumber:0,reviewEnabled:false};
 const wait={...task('entry','RUNNING'),executionId:'exec-1',result:{summary:'waiting',data:{shortcut:{waits:{visioner:{executionId:'exec-1'}}}}}};
 assert.equal(deriveJobRuntimeStatus(job([wait],base)),'WAITING');
 assert.equal(deriveJobRuntimeStatus(job([{...wait,leaseExpiresAt:new Date(Date.now()-60_000).toISOString()}],base)),'WAITING');
 assert.equal(deriveJobRuntimeStatus(job([{...wait,result:{summary:'old',data:{shortcut:{waits:{visioner:{executionId:'exec-old'}}}}}}],base)),'BLOCKED');
 assert.equal(deriveJobRuntimeStatus(job([{...wait,state:'AWAITING_DECISION'}],base)),'WAITING');
 assert.equal(deriveJobRuntimeStatus(job([{...wait,state:'FAILED'}],base)),'FAILED');
});
