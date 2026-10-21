import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { unblockTask } from '../dist/unblock.js';
import { registerBlockerDependency, resolveBlockerDependencies } from '../dist/blockers.js';
import { pendingTroubleshooterTasks } from '../dist/troubleshooter.js';
import { implementationTasks } from '../dist/runtime-status.js';

const at='2026-09-29T09:00:00.000Z';
const baseTask=(id,state='BLOCKED',agentName)=>({jobId:'dependent',id,kind:'work',priority:'P0',storySize:'S',parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',agentName,input:'release 4.4.9',output:{kind:'task_pr'},continuation:null,continuationDeliveredAt:null,state,attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:'old release blockers',timeoutMs:300000,createdAt:at,updatedAt:at,blockedBaseline:{blockedAt:at,headSha:'c7bd3d6',reason:'old release blockers'}});
const makeJob=(tasks,mode='autonomous')=>({id:'dependent',title:'release',objective:'publish',priority:'P0',executionMode:mode,autoMerge:false,reviewEnabled:false,prNumber:6,repository:'lalalic/team-mate',state:'ACTIVE',continuation:null,headSha:'7555d05',createdAt:at,updatedAt:at,tasks});

test('authoritative unblock queues the same Troubleshooter in every Job mode', async()=>{
  const blocked=baseTask('public-release-4-4-9','BLOCKED','troubleshooter');
  const changed={...baseTask('media','SUCCEEDED'),attempt:1,error:null,result:{summary:'fresh 4.4.9 screenshots and demo required'},updatedAt:'2026-09-29T09:50:22.000Z'};
  const store=new InMemoryStore(makeJob([blocked,changed]));
  const job=await store.load('dependent');
  const result=await unblockTask({store,job,task:job.tasks.find(t=>t.id==='public-release-4-4-9'),trigger:{source:'cli',reason:'repo page fixed; Stripe reclassified to owner final test; fresh media required'},now:'2026-09-29T10:00:00.000Z'});
  assert.equal(result.replanning,false);
  const saved=await store.load('dependent');
  const release=saved.tasks.find(t=>t.id==='public-release-4-4-9');
  assert.equal(release.state,'QUEUED');
  assert.equal(release.unblock.event,'task.unblocked');
  assert.equal(release.unblock.source,'cli');
  assert.equal(saved.changeCycle,undefined);
  assert.equal(result.planTrigger,undefined);
  assert.equal(release.agentName,'troubleshooter');
  assert.equal(release.executionId,null);
});

test('maybeCreatePlanner gates on a BLOCKED Troubleshooter but not FAILED ordinary work', async()=>{
  const failed={...baseTask('failed','FAILED'),blockedBaseline:undefined,error:'implementation failed'};
  const plan={...baseTask('plan-1','SUCCEEDED'),kind:'planner',agentName:'planner',error:null,plannerResult:{objective_status:'in_progress',assessment:'continue',next_tasks:[]},planningRound:1};
  failed.planningDecisionId='plan-1';
  const store=new InMemoryStore(makeJob([plan,failed]));
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]})}});
  const after=await reconciler.maybeCreatePlanner(await store.load('dependent'));
  assert.ok(after.plans?.some(p=>p.id==='plan-2'));
  assert.equal(after.tasks.some(t=>t.id==='plan-2'),false);

  const blocked={...baseTask('blocked','BLOCKED','troubleshooter'),planningDecisionId:'plan-1'};
  const blockedStore=new InMemoryStore(makeJob([plan,blocked]));
  const blockedReconciler=managedReconciler(blockedStore,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]})}});
  const unchanged=await blockedReconciler.maybeCreatePlanner(await blockedStore.load('dependent'));
  assert.equal(unchanged.plans?.some(p=>p.id==='plan-2') ?? false,false);
});

test('blocker Job resolution releases dependency waits and leaves FAILED work for Troubleshooter recovery', async()=>{
  const blockerJob={id:'blocker',title:'blocker',priority:'P0',executionMode:'fixed',autoMerge:true,reviewEnabled:false,prNumber:10,repository:'org/platform',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
  const blockerStore=new InMemoryStore(blockerJob);
  const blockedStore=new InMemoryStore(makeJob([baseTask('release','DRAFT')]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore:blockedStore,dependentJobId:'dependent',dependentTaskId:'release',resolutionMode:'verified',now:at});
  const resolvedBlocked=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:()=>blockedStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  assert.deepEqual(resolvedBlocked.unblocked,[{repository:'lalalic/team-mate',prNumber:6,jobId:'dependent',taskId:'release'}]);
  const blockedResult=await blockedStore.load('dependent');
  assert.equal(blockedResult.tasks[0].state,'QUEUED');
  assert.equal(blockedResult.tasks[0].unblock,undefined);
  assert.equal(blockedResult.changeCycle,undefined);

  const blockerStore2=new InMemoryStore({...blockerJob,id:'blocker2'});
  const failed={...baseTask('failed','FAILED'),blockedBaseline:undefined,error:'boom'};
  const failedStore=new InMemoryStore(makeJob([failed]));
  await registerBlockerDependency({blockerStore:blockerStore2,blockerJobId:'blocker2',dependentStore:failedStore,dependentJobId:'dependent',dependentTaskId:'failed',resolutionMode:'verified',now:at});
  await resolveBlockerDependencies({blockerStore:blockerStore2,blockerJobId:'blocker2',dependentStore:()=>failedStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  const failedResult=(await failedStore.load('dependent')).tasks[0];
  assert.equal(failedResult.state,'FAILED');
  assert.equal(failedResult.maxAttempts,3);
});


test('blocker resolution resumes a fixed Job interrupted after durable unblock', async()=>{
  const blockerJob={id:'blocker-interrupted',title:'blocker',priority:'P0',executionMode:'fixed',autoMerge:true,reviewEnabled:false,prNumber:10,repository:'org/platform',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
  const blockerStore=new InMemoryStore(blockerJob);
  const blocked={...baseTask('interrupted','DRAFT'),attempt:2,maxAttempts:3};
  const dependentStore=new InMemoryStore(makeJob([blocked],'fixed'));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker-interrupted',dependentStore,dependentJobId:'dependent',dependentTaskId:'interrupted',resolutionMode:'verified',now:at});

  const durable=(await dependentStore.load('dependent')).tasks[0];
  durable.state='QUEUED';
  durable.unblock={event:'task.unblocked',at:'2026-09-29T09:59:00.000Z',source:'blocker_job',reason:'blocker cleared',baseline:{blockedAt:at},currentHeadSha:'abc'};
  await dependentStore.saveTask(durable);

  const resolved=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker-interrupted',dependentStore:()=>dependentStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  assert.equal(resolved.resumed,0);
  const saved=(await dependentStore.load('dependent')).tasks[0];
  assert.equal(saved.state,'QUEUED');
  assert.equal(saved.maxAttempts,3);
  assert.equal(saved.error,'old release blockers');
});

test('fixed authoritative unblock queues the same Troubleshooter with a reset retry budget', async()=>{
  const blocked={...baseTask('fixed-release','BLOCKED','troubleshooter'),attempt:3,maxAttempts:3};
  const store=new InMemoryStore(makeJob([blocked],'fixed'));
  const current=await store.load('dependent');
  const result=await unblockTask({store,job:current,task:current.tasks[0],trigger:{source:'cli',reason:'external blocker cleared'},now:'2026-09-29T10:00:00.000Z'});
  assert.equal(result.replanning,false);
  const saved=(await store.load('dependent')).tasks[0];
  assert.equal(saved.state,'QUEUED');
  assert.equal(saved.maxAttempts,3);
  assert.equal(saved.unblock.source,'cli');
  assert.equal(saved.error,null);
});

test('ordinary DRAFT dependency waits remain unblocked and do not spawn a Troubleshooter', async()=>{
  const blocked=baseTask('release','DRAFT');
  const store=new InMemoryStore(makeJob([blocked]));
  const saved=await store.load('dependent');
  assert.equal(saved.tasks[0].state,'DRAFT');
  assert.deepEqual(pendingTroubleshooterTasks(saved),[]);
});


test('unblock history no longer blocks implementation completion accounting', async()=>{
  const blocked=baseTask('old-release','BLOCKED','troubleshooter');
  const replacement={...baseTask('replacement','SUCCEEDED'),error:null,result:{summary:'replacement complete'},blockedBaseline:undefined};
  const store=new InMemoryStore(makeJob([blocked,replacement]));
  const current=await store.load('dependent');
  await unblockTask({store,job:current,task:current.tasks.find(t=>t.id==='old-release'),trigger:{source:'cli',reason:'replan from new facts'},now:'2026-09-29T10:00:00.000Z'});
  const saved=await store.load('dependent');
  assert.deepEqual(implementationTasks(saved).map(t=>t.id),['replacement']);
});

test('Troubleshooter unblock reruns the same Task without creating a Planner Plan', async()=>{
  const priorPlan={...baseTask('plan-1','SUCCEEDED'),kind:'planner',agentName:'planner',error:null,plannerResult:{objective_status:'in_progress',assessment:'release still blocked',next_tasks:[]},planningRound:1};
  const blocked={...baseTask('troubleshooter','BLOCKED','troubleshooter'),planningDecisionId:'plan-1'};
  const store=new InMemoryStore(makeJob([priorPlan,blocked]));
  const current=await store.load('dependent');
  await unblockTask({store,job:current,task:current.tasks.find(t=>t.id==='troubleshooter'),trigger:{source:'cli',reason:'human response received'},now:'2026-09-29T10:00:00.000Z'});
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'replanned',next_tasks:[],unblocks:[]})}});
  await reconciler.reconcile('dependent');
  const saved=await store.load('dependent');
  assert.equal(saved.tasks.find(t=>t.id==='troubleshooter').state,'QUEUED');
  assert.equal(saved.plans?.length,1);
});


test('blocker Job resolution does not unblock unrelated BLOCKED tasks', async()=>{
  const blockerJob={id:'blocker-scope',title:'blocker',priority:'P0',executionMode:'fixed',autoMerge:true,reviewEnabled:false,prNumber:10,repository:'org/platform',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
  const blockerStore=new InMemoryStore(blockerJob);
  const target=baseTask('target','DRAFT');
  const unrelated=baseTask('unrelated','BLOCKED','troubleshooter');
  const dependentStore=new InMemoryStore(makeJob([target,unrelated]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker-scope',dependentStore,dependentJobId:'dependent',dependentTaskId:'target',resolutionMode:'verified',now:at});
  await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker-scope',dependentStore:()=>dependentStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  const saved=await dependentStore.load('dependent');
  assert.equal(saved.tasks.find(t=>t.id==='target').state,'QUEUED');
  assert.equal(saved.tasks.find(t=>t.id==='unrelated').unblock,undefined);
});
