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


test('plan-free Coordinator/DAG Job uses ordinary Job runtime status',()=>{
  const coordinator={...task('coordinator','RUNNING'),agentGraph:'flowchart TD\nA[agent:first] --> B[agent:second]'};
  const child=task('dag-coordinator-A','RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([coordinator,child])),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([coordinator,{...child,state:'QUEUED'}])),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([task('coordinator','SUCCEEDED'),task('dag-coordinator-A','SUCCEEDED')])),'MERGE_PENDING');
  assert.equal(deriveJobRuntimeStatus(job([coordinator,child],{state:'DRAFT'})),'IDLE');
  assert.equal(deriveJobRuntimeStatus(job([coordinator,child],{state:'COMPLETED'})),'COMPLETED');
});

test('Agent interactive review waits without counting Coordinator as leased Worker',()=>{
  const root={...task('coordinator','RUNNING'),agentGraph:'flowchart TD\nA[agent:first]'};
  const waiting={...task('dag-coordinator-A','AWAITING_DECISION'),parentTaskId:'coordinator'};
  assert.equal(deriveJobRuntimeStatus(job([root,waiting])),'WAITING');
  const active={...task('dag-coordinator-B','RUNNING'),parentTaskId:'coordinator',executionId:'exec-b',leaseOwner:'relay'};
  assert.equal(deriveJobRuntimeStatus(job([root,waiting,active])),'RUNNING');
  assert.equal(deriveJobRuntimeStatus(job([root,{...waiting,state:'FAILED'}])),'RUNNING');
});

test('retired Shortcut metadata never creates a separate runtime status path',()=>{
  for(const state of ['QUEUED','RUNNING','AWAITING_DECISION','SUCCEEDED','FAILED','BLOCKED']){
    const normal=job([task('entry',state)]);
    const obsolete={...normal,executionMode:'shortcut',contentOnly:true};
    assert.equal(deriveJobRuntimeStatus(obsolete),deriveJobRuntimeStatus(normal));
  }
});
