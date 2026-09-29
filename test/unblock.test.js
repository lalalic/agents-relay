import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { unblockTask } from '../dist/unblock.js';
import { registerBlockerDependency, resolveBlockerDependencies } from '../dist/blockers.js';
import { plannerInput } from '../dist/planner.js';
import { pendingTroubleshooterTasks } from '../dist/troubleshooter.js';
import { implementationTasks } from '../dist/runtime-status.js';

const at='2026-09-29T09:00:00.000Z';
const baseTask=(id,state='BLOCKED')=>({jobId:'dependent',id,kind:'work',priority:'P0',storySize:'S',parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:'release 4.4.9',output:{kind:'task_pr'},continuation:null,continuationDeliveredAt:null,state,attempt:1,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:'old release blockers',timeoutMs:300000,createdAt:at,updatedAt:at,blockedBaseline:{blockedAt:at,headSha:'c7bd3d6',reason:'old release blockers'}});
const makeJob=(tasks,mode='autonomous')=>({id:'dependent',title:'release',objective:'publish',priority:'P0',executionMode:mode,autoMerge:false,reviewEnabled:false,prNumber:6,repository:'lalalic/team-mate',state:'ACTIVE',continuation:null,headSha:'7555d05',createdAt:at,updatedAt:at,tasks});

test('explicit unblock transitions to UNBLOCKED and returns Plan trigger facts without retrying the old task', async()=>{
  const blocked=baseTask('public-release-4-4-9');
  const changed={...baseTask('media','SUCCEEDED'),attempt:1,error:null,result:{summary:'fresh 4.4.9 screenshots and demo required'},updatedAt:'2026-09-29T09:50:22.000Z'};
  const store=new InMemoryStore(makeJob([blocked,changed]));
  const job=await store.load('dependent');
  const result=await unblockTask({store,job,task:job.tasks.find(t=>t.id==='public-release-4-4-9'),trigger:{source:'cli',reason:'repo page fixed; Stripe reclassified to owner final test; fresh media required'},now:'2026-09-29T10:00:00.000Z'});
  assert.equal(result.replanning,true);
  const saved=await store.load('dependent');
  const release=saved.tasks.find(t=>t.id==='public-release-4-4-9');
  assert.equal(release.state,'UNBLOCKED');
  assert.equal(release.unblock.source,'cli');
  assert.equal(saved.changeCycle,undefined);
  assert.deepEqual(result.planTrigger.blockedHeadShas,['c7bd3d6']);
  assert.equal(result.planTrigger.currentHeadSha,'7555d05');
  assert.ok(result.planTrigger.facts.some(f=>f.includes('PR head advanced')));
  assert.ok(result.planTrigger.facts.some(f=>f.includes('fresh 4.4.9')));
  const payload=JSON.parse(plannerInput({job:saved,tasks:saved.tasks,objective:saved.objective,previousPlannerTaskId:null,trigger:result.planTrigger}));
  assert.equal(payload.plan_trigger.currentHeadSha,'7555d05');
  assert.equal(payload.tasks.find(t=>t.id==='public-release-4-4-9').unblock.source,'cli');
});

test('maybeCreatePlanner gates on effective BLOCKED but not FAILED work', async()=>{
  const failed={...baseTask('failed','FAILED'),blockedBaseline:undefined,error:'implementation failed'};
  const plan={...baseTask('plan-1','SUCCEEDED'),kind:'planner',agentName:'planner',error:null,plannerResult:{objective_status:'in_progress',assessment:'continue',next_tasks:[]},planningRound:1};
  failed.planningDecisionId='plan-1';
  const store=new InMemoryStore(makeJob([plan,failed]));
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]})}});
  const after=await reconciler.maybeCreatePlanner(await store.load('dependent'));
  assert.ok(after.tasks.some(t=>t.id==='plan-2'));

  const blocked={...baseTask('blocked','BLOCKED'),planningDecisionId:'plan-1'};
  const blockedStore=new InMemoryStore(makeJob([plan,blocked]));
  const blockedReconciler=managedReconciler(blockedStore,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'done',next_tasks:[],unblocks:[]})}});
  const unchanged=await blockedReconciler.maybeCreatePlanner(await blockedStore.load('dependent'));
  assert.equal(unchanged.tasks.some(t=>t.id==='plan-2'),false);
});

test('blocker Job resolution sends autonomous BLOCKED dependents to replanning, while FAILED keeps direct retry', async()=>{
  const blockerJob={id:'blocker',title:'blocker',priority:'P0',executionMode:'fixed',autoMerge:true,reviewEnabled:false,prNumber:10,repository:'org/platform',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
  const blockerStore=new InMemoryStore(blockerJob);
  const blockedStore=new InMemoryStore(makeJob([baseTask('release')]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker',dependentStore:blockedStore,dependentJobId:'dependent',dependentTaskId:'release',resolutionMode:'verified',now:at});
  const resolvedBlocked=await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker',dependentStore:()=>blockedStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  assert.deepEqual(resolvedBlocked.unblocked,[{repository:'lalalic/team-mate',prNumber:6,jobId:'dependent',taskId:'release'}]);
  const blockedResult=await blockedStore.load('dependent');
  assert.equal(blockedResult.tasks[0].state,'UNBLOCKED');
  assert.equal(blockedResult.tasks[0].unblock.source,'blocker_job');
  assert.equal(blockedResult.changeCycle,undefined);

  const blockerStore2=new InMemoryStore({...blockerJob,id:'blocker2'});
  const failed={...baseTask('failed','FAILED'),blockedBaseline:undefined,error:'boom'};
  const failedStore=new InMemoryStore(makeJob([failed]));
  await registerBlockerDependency({blockerStore:blockerStore2,blockerJobId:'blocker2',dependentStore:failedStore,dependentJobId:'dependent',dependentTaskId:'failed',resolutionMode:'verified',now:at});
  await resolveBlockerDependencies({blockerStore:blockerStore2,blockerJobId:'blocker2',dependentStore:()=>failedStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  assert.equal((await failedStore.load('dependent')).tasks[0].state,'QUEUED');
});


test('UNBLOCKED tasks do not spawn a troubleshooter before Planner', async()=>{
  const blocked=baseTask('release');
  const store=new InMemoryStore(makeJob([blocked]));
  const current=await store.load('dependent');
  await unblockTask({store,job:current,task:current.tasks[0],trigger:{source:'cli',reason:'facts changed'},now:'2026-09-29T10:00:00.000Z'});
  const saved=await store.load('dependent');
  assert.equal(saved.tasks[0].state,'UNBLOCKED');
  assert.equal(saved.tasks[0].unblock.source,'cli');
  assert.deepEqual(pendingTroubleshooterTasks(saved),[]);
});


test('UNBLOCKED history no longer blocks implementation completion accounting', async()=>{
  const blocked=baseTask('old-release');
  const replacement={...baseTask('replacement','SUCCEEDED'),error:null,result:{summary:'replacement complete'},blockedBaseline:undefined};
  const store=new InMemoryStore(makeJob([blocked,replacement]));
  const current=await store.load('dependent');
  await unblockTask({store,job:current,task:current.tasks.find(t=>t.id==='old-release'),trigger:{source:'cli',reason:'replan from new facts'},now:'2026-09-29T10:00:00.000Z'});
  const saved=await store.load('dependent');
  assert.deepEqual(implementationTasks(saved).map(t=>t.id),['replacement']);
});

test('autonomous reconcile consumes UNBLOCKED evidence into exactly one durable Plan', async()=>{
  const priorPlan={...baseTask('plan-1','SUCCEEDED'),kind:'planner',agentName:'planner',error:null,plannerResult:{objective_status:'in_progress',assessment:'release still blocked',next_tasks:[]},planningRound:1};
  const blocked={...baseTask('release'),planningDecisionId:'plan-1'};
  const store=new InMemoryStore(makeJob([priorPlan,blocked]));
  const current=await store.load('dependent');
  await unblockTask({store,job:current,task:current.tasks.find(t=>t.id==='release'),trigger:{source:'cli',reason:'release facts changed'},now:'2026-09-29T10:00:00.000Z'});
  const reconciler=managedReconciler(store,{owner:'test',adapters:[],maxConcurrent:0,planner:{plan:async()=>({objective_status:'satisfied',assessment:'replanned',next_tasks:[],unblocks:[]})}});
  await reconciler.reconcile('dependent');
  let saved=await store.load('dependent');
  for(let i=0;i<40 && saved.plans?.find(p=>p.id==='plan-2')?.status==='PLANNING';i++){ await new Promise(r=>setTimeout(r,10)); saved=await store.load('dependent'); }
  assert.ok(saved.tasks.some(t=>t.id==='plan-2'));
  const plan=saved.plans.find(p=>p.id==='plan-2');
  assert.equal(plan.status,'PLANNING');
  assert.equal(plan.trigger.source,'unblock');
  assert.deepEqual(plan.trigger.taskIds,['release']);
  assert.equal(saved.tasks.some(t=>t.agentName==='troubleshooter'),false);
  await reconciler.reconcile('dependent');
  const again=await store.load('dependent');
  assert.equal(again.plans.filter(p=>p.trigger.source==='unblock'&&p.trigger.taskIds?.includes('release')).length,1);
});


test('blocker Job resolution does not unblock unrelated BLOCKED tasks', async()=>{
  const blockerJob={id:'blocker-scope',title:'blocker',priority:'P0',executionMode:'fixed',autoMerge:true,reviewEnabled:false,prNumber:10,repository:'org/platform',state:'ACTIVE',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
  const blockerStore=new InMemoryStore(blockerJob);
  const target=baseTask('target');
  const unrelated=baseTask('unrelated');
  const dependentStore=new InMemoryStore(makeJob([target,unrelated]));
  await registerBlockerDependency({blockerStore,blockerJobId:'blocker-scope',dependentStore,dependentJobId:'dependent',dependentTaskId:'target',resolutionMode:'verified',now:at});
  await resolveBlockerDependencies({blockerStore,blockerJobId:'blocker-scope',dependentStore:()=>dependentStore,resolution:'verified',now:'2026-09-29T10:00:00.000Z'});
  const saved=await dependentStore.load('dependent');
  assert.equal(saved.tasks.find(t=>t.id==='target').unblock.source,'blocker_job');
  assert.equal(saved.tasks.find(t=>t.id==='unrelated').unblock,undefined);
});
