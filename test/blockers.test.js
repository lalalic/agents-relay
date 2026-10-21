import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { registerBlockerDependency, resolveBlockerDependencies } from '../dist/blockers.js';

const now='2026-09-25T18:00:00.000Z';
function task(id,state='FAILED',attempt=1){return {jobId:'dependent',id,kind:'work',priority:'P1',storySize:'S',parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:id,output:{kind:'task_pr'},continuation:null,continuationDeliveredAt:null,state,attempt,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:'boom',timeoutMs:300000,createdAt:now,updatedAt:now};}
function job(id,repository,prNumber,tasks=[]){return {id,title:id,priority:'P1',executionMode:'fixed',autoMerge:true,reviewEnabled:false,prNumber,repository,state:'ACTIVE',continuation:null,createdAt:now,updatedAt:now,tasks};}

test('blocker registration is reverse, cross-job, and idempotent', async()=>{
  const blockerStore=new InMemoryStore(job('blocker','org/platform',10));
  const dependentStore=new InMemoryStore(job('dependent','org/app',20,[task('failed')]));
  const options={blockerStore,blockerJobId:'blocker',dependentStore,dependentJobId:'dependent',dependentTaskId:'failed',resolutionMode:'merge',now};
  const first=await registerBlockerDependency(options);
  const second=await registerBlockerDependency(options);
  assert.deepEqual(second,first);
  const blocker=await blockerStore.load('blocker');
  assert.equal(blocker.unblocks.length,1);
  assert.equal(blocker.unblocks[0].repository,'org/app');
  assert.equal(blocker.unblocks[0].blockedAttempt,1);
  const dependent=await dependentStore.load('dependent');
  assert.deepEqual(dependent.tasks[0].blockedBy,{repository:'org/platform',prNumber:10,jobId:'blocker',blockedAttempt:1,registeredAt:now});
});

test('merge resolution requeues matching dependents once and marks stale generations obsolete', async()=>{
  const blockerStore=new InMemoryStore(job('blocker','org/platform',10));
  const aStore=new InMemoryStore(job('dependent-a','org/a',21,[{...task('a','DRAFT',0),jobId:'dependent-a',error:null}]));
  const bStore=new InMemoryStore(job('dependent-b','org/b',22,[{...task('b'),jobId:'dependent-b'}]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore:aStore,dependentJobId:'dependent-a',dependentTaskId:'a',resolutionMode:'merge',now});
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore:bStore,dependentJobId:'dependent-b',dependentTaskId:'b',resolutionMode:'merge',now});
  const b=await bStore.load('dependent-b'); b.tasks[0].attempt=2; await bStore.saveTask(b.tasks[0]);
  const stores=new Map([['org/a#21',aStore],['org/b#22',bStore]]);
  const factory=(repo,pr)=>stores.get(`${repo}#${pr}`);
  const first=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:factory,resolution:'merge',now:'2026-09-25T19:00:00.000Z'});
  assert.deepEqual(first,{resumed:1,obsolete:1,waiting:0,unblocked:[{repository:'org/a',prNumber:21,jobId:'dependent-a',taskId:'a'}]});
  assert.equal((await blockerStore.load('blocker')).unblocks, undefined);
  assert.equal((await aStore.load('dependent-a')).tasks[0].state,'QUEUED');
  assert.equal((await bStore.load('dependent-b')).tasks[0].state,'FAILED');
  const second=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:factory,resolution:'merge',now:'2026-09-25T20:00:00.000Z'});
  assert.deepEqual(second,{resumed:0,obsolete:0,waiting:0,unblocked:[]});
});

test('consuming blocker relations is write-free on a second resolution pass', async()=>{
  class CountingStore extends InMemoryStore {
    writes=0;
    async saveJob(value){ this.writes += 1; await super.saveJob(value); }
  }
  const blockerStore=new CountingStore(job('blocker','org/platform',10));
  const dependentStore=new InMemoryStore(job('dependent','org/app',20,[task('draft','DRAFT',0)]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore,dependentJobId:'dependent',dependentTaskId:'draft',resolutionMode:'merge',now});
  blockerStore.writes=0;
  const factory=()=>dependentStore;
  await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:factory,resolution:'merge',now});
  assert.equal(blockerStore.writes,1);
  await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:factory,resolution:'merge',now});
  assert.equal(blockerStore.writes,1);
});

test('verified blocker does not wake on merge but wakes after explicit verification', async()=>{
  const blockerStore=new InMemoryStore(job('blocker','org/platform',10));
  const dependentStore=new InMemoryStore(job('dependent','org/app',20,[task('draft','DRAFT',0)]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore,dependentJobId:'dependent',dependentTaskId:'draft',resolutionMode:'verified',now});
  const factory=()=>dependentStore;
  assert.deepEqual(await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:factory,resolution:'merge'}),{resumed:0,obsolete:0,waiting:1,unblocked:[]});
  assert.equal((await dependentStore.load('dependent')).tasks[0].state,'DRAFT');
  const verified=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:factory,resolution:'verified'});
  assert.deepEqual(verified,{resumed:1,obsolete:0,waiting:0,unblocked:[{repository:'org/app',prNumber:20,jobId:'dependent',taskId:'draft'}]});
  assert.equal((await dependentStore.load('dependent')).tasks[0].state,'QUEUED');
});


test('draft dependent is durably registered and released from blocker-side authority without blockedBy', async()=>{
  const blockerStore=new InMemoryStore(job('blocker','org/platform',10));
  const draft={...task('draft','DRAFT',0),error:null};
  const dependentStore=new InMemoryStore(job('dependent','org/app',20,[draft]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore,dependentJobId:'dependent',dependentTaskId:'draft',resolutionMode:'merge',now});
  const blocker=await blockerStore.load('blocker');
  assert.equal(blocker.unblocks.length,1);
  assert.equal(blocker.unblocks[0].blockedAttempt,0);
  const dependent=await dependentStore.load('dependent');
  delete dependent.tasks[0].blockedBy;
  await dependentStore.saveTask(dependent.tasks[0]);
  const resolved=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:()=>dependentStore,resolution:'merge',now:'2026-09-25T19:00:00.000Z'});
  assert.deepEqual(resolved,{resumed:1,obsolete:0,waiting:0,unblocked:[{repository:'org/app',prNumber:20,jobId:'dependent',taskId:'draft'}]});
  const released=(await dependentStore.load('dependent')).tasks[0];
  assert.equal(released.state,'QUEUED');
  assert.equal(released.attempt,0);
});

test('concurrent atomic blocker registrations retain both dependent relations',async()=>{
 const blockerStore=new InMemoryStore(job('blocker','org/platform',10));
 let tail=Promise.resolve();
 blockerStore.mutateJob=(id,mutation)=>{
   const pending=tail.then(async()=>{
     const fresh=await blockerStore.load(id);
     const changed=mutation(fresh);
     await blockerStore.saveJob(changed);
     return changed;
   });
   tail=pending.then(()=>{},()=>{});
   return pending;
 };
 const a=new InMemoryStore(job('dependent-a','org/a',21,[{...task('a'),jobId:'dependent-a'}]));
 const b=new InMemoryStore(job('dependent-b','org/b',22,[{...task('b'),jobId:'dependent-b'}]));
 await Promise.all([
   registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore:a,dependentJobId:'dependent-a',dependentTaskId:'a',now}),
   registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore:b,dependentJobId:'dependent-b',dependentTaskId:'b',now}),
 ]);
 const blocker=await blockerStore.load('blocker');
 assert.deepEqual(new Set(blocker.unblocks.map(x=>x.taskId)),new Set(['a','b']));
});
