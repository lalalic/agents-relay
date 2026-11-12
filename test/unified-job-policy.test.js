import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureManagedGitHubJob} from '../dist/cli-job-create.js';
import {createWorkspaceControl} from '../dist/relayd-control.js';
import {deriveJobRuntimeStatus} from '../dist/runtime-status.js';

const localJob=(more={})=>({id:'10',repository:'owner/demo',state:'ACTIVE',autoMerge:false,
  contentOnly:true,reviewEnabled:false,prNumber:0,createdAt:'2026-11-11T10:00:00Z',updatedAt:'2026-11-11T10:00:00Z',
  tasks:[],...more});

test('plan-free Coordinator Job retains normal Review and Merge defaults',async()=>{
 const dir=await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR??tmpdir(),'relay-coordinator-policy-'));
 try{
  const {job}=await ensureManagedGitHubJob({},'owner/unified',new Set(),
   {objective:'Plan-free Coordinator',storeDirectory:dir,noGitHub:true});
  assert.equal(job.state,'DRAFT');
  assert.equal(job.executionMode,undefined);
  assert.equal(Object.hasOwn(job,'executionMode'),false);
  assert.equal(job.contentOnly,undefined);
  assert.equal(job.autoMerge,true);
  assert.equal(job.reviewEnabled,true);
  assert.equal(job.plans?.length??0,0);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('ordinary create-only Jobs retain independent review/merge defaults',async()=>{
 const dir=await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR??tmpdir(),'relay-unified-defaults-'));
 try{
  const {job}=await ensureManagedGitHubJob({},'owner/unified',new Set(),
   {objective:'Plan-free but review required',storeDirectory:dir,noGitHub:true});
  assert.equal(job.executionMode,undefined);
  assert.equal(job.autoMerge,true);
  assert.equal(job.reviewEnabled,true);
  assert.equal(job.contentOnly,undefined);
  assert.equal(job.plans?.length??0,0);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('review can be disabled while normal Merge stays enabled',async()=>{
 const dir=await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR??tmpdir(),'relay-independent-review-'));
 try{
  const {job}=await ensureManagedGitHubJob({},'owner/unified',new Set(),
   {objective:'No Final Review, normal Merge',reviewEnabled:false,storeDirectory:dir,noGitHub:true});
  assert.equal(job.reviewEnabled,false);
  assert.equal(job.autoMerge,true);
  assert.equal(job.contentOnly,undefined);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('Merge can be disabled without disabling ordinary Final Review',async()=>{
 const dir=await mkdtemp(join(process.env.AGENTS_RELAY_STORE_DIR??tmpdir(),'relay-independent-merge-'));
 try{
  const {job}=await ensureManagedGitHubJob({},'owner/unified',new Set(),
   {objective:'Review but manual Merge',autoMerge:false,storeDirectory:dir,noGitHub:true});
  assert.equal(job.reviewEnabled,true);
  assert.equal(job.autoMerge,false);
  assert.equal(job.contentOnly,undefined);
 }finally{await rm(dir,{recursive:true,force:true})}
});

test('relayd control forwards independent review and merge flags, not Shortcut/content-only mode',async()=>{
 let received;
 const control=createWorkspaceControl({client:{},trusted:new Set(),noGitHub:true,
  repositories:[],refreshAll:async()=>{},
  ensureManagedGitHubJob:async(_client,repository,_trusted,options)=>{
   received={repository,options};return {job:{id:'42',state:'DRAFT'},pr:{number:0}};
  }});
 const output=await control({command:'job.create',repository:'owner/demo',
  options:{objective:'No Planner',reviewEnabled:false,autoMerge:true}});
 assert.equal(received.repository,'owner/demo');
 assert.equal(received.options.reviewEnabled,false);
 assert.equal(received.options.autoMerge,true);
 assert.equal(received.options.contentOnly,undefined);
 assert.equal(received.options.executionMode,undefined);
 assert.equal(output.job,'42');
 await assert.rejects(()=>control({command:'job.create',repository:'owner/demo',
  options:{objective:'No Planner',contentOnly:true}}),/obsolete/);
});

test('a Coordinator waiting for human review reports WAITING under normal Job policy',()=>{
 const now='2026-11-11T10:01:00Z';
 const base={jobId:'10',dependencies:[],output:{kind:'file',path:'/tmp/unused'},updatedAt:now};
 const job=localJob({tasks:[{...base,id:'root',title:'Coordinator',state:'RUNNING',agentGraph:'flowchart TD\nA[agent:first]',
   result:{data:{dag:{version:1,graphHash:'abc'}}},executionId:null,leaseOwner:null},
   {...base,id:'child',parentTaskId:'root',title:'first',state:'AWAITING_DECISION',executionId:null,leaseOwner:null}]});
 assert.equal(deriveJobRuntimeStatus(job),'WAITING');
});

test('plan-free completed Agent DAG reaches the ordinary Final Review gate',async()=>{
 const {reviewPlanReady,reviewWorkSettled}=await import('../dist/review-replan.js');
 const {decideReviewLifecycle}=await import('../dist/workflow/review-v2.js');
 const job=localJob({contentOnly:undefined,autoMerge:true,reviewEnabled:true,tasks:[
  {id:'root',kind:'work',agentName:'coordinator',state:'SUCCEEDED',agentGraph:'flowchart TD\nA[agent:writer]'},
  {id:'child',kind:'work',agentName:'writer',state:'SUCCEEDED',parentTaskId:'root'}]});
 assert.equal(reviewWorkSettled(job),true);
 assert.equal(reviewPlanReady(job),true);
 const decision=decideReviewLifecycle(undefined,'reconcile',{
  reviewEnabled:true,jobActive:true,reviewWorkSettled:true,headAvailable:true,reviewPlanReady:true,
  noActiveReviewTask:true,noApprovedCurrentReview:true,currentReviewCancelled:false});
 assert.equal(decision.target,'PENDING');
 assert.ok(decision.actions.some(action=>action.id==='review.create'));
});


test('normal Git Merge remains eligible when Final Review is disabled',async()=>{
 const {localMergeFacts}=await import('../dist/local-git-merge.js');
 const task={id:'root',kind:'work',state:'SUCCEEDED',output:{kind:'task_pr'},dependencies:[]};
 const job={...localJob({contentOnly:undefined,autoMerge:true,reviewEnabled:false}),tasks:[task],
   localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',sourceSha:'abc',status:'pending'}};
 const facts=localMergeFacts(job,'abc');
 assert.equal(facts.reviewSatisfied,true);
 assert.equal(facts.autoMergeEnabled,true);
 assert.equal(facts.localMergeRequired,true);
 assert.equal(facts.mergeAttemptReady,true);
 const needReview=localMergeFacts({...job,reviewEnabled:true},'abc');
 assert.equal(needReview.reviewSatisfied,false);
 assert.equal(needReview.autoMergeEnabled,true);
});
