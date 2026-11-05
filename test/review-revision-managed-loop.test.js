import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../dist/store.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';
import { executionEventSource } from '../dist/reconciler.js';
import { submitTargetedRevisionRequest } from '../dist/review-revision-model.js';

const sha='abcdef0123456789abcdef0123456789abcdef01';
const now=()=>new Date().toISOString();
const base=(id,agentName,state)=>({jobId:'managed-review',id,title:id,kind:'work',priority:'P1',storySize:'M',agentName,parentTaskId:null,
 dependencies:[],capabilities:[],adapter:'codex',input:'deliver '+id,output:{kind:'task_pr'},state,attempt:1,maxAttempts:3,
 leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:state==='SUCCEEDED'?{summary:'original complete'}:null,
 error:null,timeoutMs:900000,createdAt:now(),updatedAt:now()});

function setup() {
 const owner=base('implementation','implementation','SUCCEEDED');
 const reviewer={...base('review-1','job-acceptance-reviewer','RUNNING'),adapter:'chatgpt',reviewHeadSha:sha,
   dependencies:['implementation'],leaseOwner:'worker',executionId:'review-exec',result:null,
   executionHistory:[{id:'review-exec',attempt:1,startedAt:now()}]};
 const job={id:'managed-review',title:'managed-review',repository:'isolated/review',prNumber:0,
   state:'ACTIVE',reviewEnabled:true,autoMerge:false,headSha:sha,createdAt:now(),updatedAt:now(),continuation:null,
   plans:[{jobId:'managed-review',id:'plan-1',round:1,status:'SUCCEEDED',objectiveStatus:'satisfied',generatedTaskIds:['implementation'],trigger:{source:'initial'}}],
   review:{outcome:'started',headSha:sha,taskId:'review-1',evidence:null,updatedAt:now()},tasks:[owner,reviewer]};
 const store=new InMemoryStore(job);
 // Emulate atomic SQLite mutation in this isolated Graph lifecycle test. Exact
 // SQLite rollback/restart tests are separately exercised in revision-model.
 store.mutateJob=async(id,fn)=>{
   const latest=await store.load(id);const modified=fn(latest);
   await store.saveJob(modified);
   for(const t of modified.tasks) await store.saveTask(t);
   return store.load(id);
 };
 return store;
}

const event=(id,execution,verdict,findings=[])=>eventFor('managed-review',id,null,'task.completed','succeeded','review evidence','worker',
 {verdict,head_sha:sha,findings},{id:executionEventSource('managed-review',id,execution)});

test('managed Job review -> targeted fix -> exact SHA independent re-review -> approval, no original rewrite',async()=>{
 const store=setup();
 const bus=new MemoryEventBus();
 const runtime=managedReconciler(store,{owner:'review-loop-test',maxConcurrent:0,adapters:[],eventBus:bus,
    headShaProvider:()=>sha,reviewer:{adapter:'chatgpt',routing:{provider:'chatgpt',model:'account-defaults',decidedBy:'test',decidedAt:now()}}});
 const incoming={requestId:'immutable-request',reviewTaskId:'review-1',reviewExecutionId:'review-exec',headSha:sha,
    originalTaskId:'implementation',findings:[{id:'F1',summary:'Fix old bug'}]};
 const submitted=await submitTargetedRevisionRequest(store,'managed-review',incoming);
 assert.equal(submitted.created,true);
 assert.ok(submitted.request.revisionTaskId);
 const duplicate=await submitTargetedRevisionRequest(store,'managed-review',incoming);
 assert.equal(duplicate.created,false);
 assert.equal((await store.load('managed-review')).tasks.length,3);
 await runtime.handleEvent(event('review-1','review-exec','changes-required',[{id:'F1',summary:'Fix old bug'}]));
 await runtime.idle();
 let saved=await store.load('managed-review');
 assert.equal(saved.review.outcome,'changes_required');
 assert.equal(saved.review.revisionDisposition,'targeted');
 assert.equal(saved.tasks[0].result.summary,'original complete');
 await runtime.reconcile('managed-review');
 saved=await store.load('managed-review');
 let fix=saved.tasks.find(t=>t.id===submitted.request.revisionTaskId);
 assert.equal(fix.state,'QUEUED');
 assert.equal(saved.reviewRevisionRequests[0].status,'queued');
 const badTerminal=eventFor('managed-review',fix.id,'implementation','task.completed','succeeded','stale fake','worker',{},
    {id:executionEventSource('managed-review',fix.id,'wrong-execution')});
 await runtime.handleEvent(badTerminal);
 assert.equal((await store.load('managed-review')).tasks.find(t=>t.id===fix.id).state,'QUEUED');
 fix={...fix,state:'RUNNING',executionId:'fix-exec',leaseOwner:'worker',attempt:1,
   executionHistory:[{id:'fix-exec',attempt:1,startedAt:now()}]};
 await store.saveTask(fix);
 await runtime.handleEvent(eventFor('managed-review',fix.id,'implementation','task.completed','succeeded','fix tested','worker',
    {tests:'passed'}, {id:executionEventSource('managed-review',fix.id,'fix-exec')}));
 await runtime.idle();
 await runtime.reconcile('managed-review');
 saved=await store.load('managed-review');
 assert.equal(saved.tasks.find(t=>t.id===fix.id).state,'SUCCEEDED');
 assert.equal(saved.reviewRevisionRequests[0].status,'verified');
 assert.equal(saved.tasks[0].result.summary,'original complete');
 const fresh=saved.tasks.filter(t=>t.agentName==='job-acceptance-reviewer');
 assert.equal(fresh.length,2,'Graph creates independent new reviewer for same source SHA');
 const next=fresh.find(t=>t.id!=='review-1');
 assert.equal(next.reviewHeadSha,sha);
 assert.equal(saved.review.outcome,'pending');
 assert.equal(saved.review.taskId,next.id);
 assert.equal(saved.reviewRevisionRounds.length,1);
 // A synthetic accepted reviewer generation exercises the same immutable-head
 // terminal normalization; automatic worker dispatch is intentionally disabled.
 await store.mutateJob('managed-review',job=>{
   const review=job.tasks.find(t=>t.id===next.id);
   review.state='RUNNING';review.executionId='review-exec-2';review.leaseOwner='worker';review.attempt=1;
   review.executionHistory=[{id:'review-exec-2',attempt:1,startedAt:now()}];
   job.review.outcome='started';
   return job;
 });
 await runtime.handleEvent(event(next.id,'review-exec-2','approved'));
 saved=await store.load('managed-review');
 assert.equal(saved.review.outcome,'approved');
 assert.equal(saved.review.headSha,sha);
 assert.equal(saved.reviewRevisionRounds.length,2);
 assert.equal(saved.reviewRevisionRounds.at(-1).status,'approved');
 assert.deepEqual(saved.tasks[0].result,{summary:'original complete'});
});
