/** Four existing three-Agent L3 scenarios, now through the ordinary plan-free
 * Coordinator Job ingress. Only the Job start changes: the Script/Model,
 * human Review, Request Changes, and Approve behavior remains identical.
 * Real CLI, Git fixture, SQLite, production Reconciler and Task adapters;
 * synthetic model inference only. No private owner data or live notifications.
 */
import test from '../test-runtime.js';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,until} from './l3-unified-dag-fixture.mjs';

async function start(f){
 const receipt=await f.startCLI();
 assert.equal(receipt.graphRuntime,'tasks');
 const job=await f.load();
 assert.equal(job.state,'ACTIVE');
 assert.equal(job.executionMode,undefined);
 assert.equal(job.contentOnly,undefined);
 assert.equal(job.plans.length,0,'Coordinator does not require an initial Plan');
 assert.equal(job.autoMerge,true,'Coordinator uses normal Merge policy');
 assert.equal(job.reviewEnabled,false,'This L3 isolates Agent Review without a Final Job Reviewer');
 assert.equal(job.tasks.length,1,'CLI only activates: Scheduler materializes children');
}
async function waiting(f,node){
 const id='dag-initial-'+node;
 return until(async()=>{
  await f.reconciler.reconcile(f.id);
  const job=await f.load(),task=job.tasks.find(t=>t.id===id);
  if(task?.state==='FAILED'||task?.state==='BLOCKED')
   throw Error('Unexpected Task failure: '+JSON.stringify({id,state:task.state,error:task.error}));
  return task?.state==='AWAITING_DECISION'?task:null;
 },'normal Agent Review '+node,20000);
}
async function completed(f){
 const job=await until(async()=>{
  await f.reconciler.reconcile(f.id);
  const current=await f.load();
  if(current.tasks.some(task=>['FAILED','BLOCKED'].includes(task.state)))
   throw Error('Agent Task failed: '+JSON.stringify(current.tasks.map(t=>({id:t.id,state:t.state,error:t.error}))));
  return current.tasks[0]?.state==='SUCCEEDED'?current:null;
 },'three-Agent Coordinator completion',20000);
 assert.equal(job.tasks.length,4,'one Coordinator + three durable Agent Tasks; no reviewer/revision subtask');
 assert.equal(job.tasks[0].title,'Coordinator');
 assert.equal(job.tasks[0].state,'SUCCEEDED');
 assert.deepEqual(job.tasks.filter(t=>t.dagNode).map(t=>t.title),['first','middle','last']);
 assert.ok(job.tasks.filter(t=>t.dagNode).every(t=>t.state==='SUCCEEDED'));
 assert.equal(job.executionMode,undefined);
 assert.equal(job.contentOnly,undefined);
 assert.equal(job.autoMerge,true);
 return job;
}

test('L3-S01: three-node Script happy path without Review',async t=>{
 const f=await fixture(t,{normalJob:true,mode:'normal'});
 await start(f);
 await completed(f);
 assert.deepEqual((await f.trace()).trim().split('\n'),
  ['script:first:new','script:middle:new','script:last:new']);
});

test('L3-S02: three-node Review / Approve / normal Scheduler wake to next node',async t=>{
 const f=await fixture(t,{normalJob:true,mode:'normal',reviews:['first','middle','last']});
 await start(f);
 for(const node of ['A','B','C']){
  const task=await waiting(f,node),inv=task.interactiveInvocation;
  assert.equal(inv.revision,inv.executionId);
  assert.equal(inv.status,'awaiting_decision');
  assert.equal(task.id,'dag-initial-'+node,'Review attaches to Agent, not Coordinator');
  await f.decide(node,'approved');
 }
 await completed(f);
 const trace=await f.trace();
 assert.equal(trace.split('\n').filter(x=>x.startsWith('preview:dag-initial-')).length,3);
 for(const agent of ['first','middle','last'])
  assert.equal(trace.split('\n').filter(x=>x==='script:'+agent+':new').length,1);
});

test('L3-S03: Script B Request Changes uses the SAME durable Agent Task, then re-review and Approve',async t=>{
 const f=await fixture(t,{normalJob:true,mode:'normal',reviews:['middle']});
 await start(f);
 const initial=await waiting(f,'B');
 const firstRevision=initial.interactiveInvocation.revision;
 await f.decide('B','changes_requested');
 const revised=await waiting(f,'B');
 assert.notEqual(revised.interactiveInvocation.revision,firstRevision,'re-review needs a new execution');
 assert.equal(revised.id,initial.id,'Request Changes does not create a revision Worker Task');
 assert.notEqual(revised.interactiveInvocation.invocationId,initial.interactiveInvocation.invocationId);
 const correction=JSON.parse(await readFile(join(f.project,'middle-correction.json'),'utf8'));
 assert.equal(correction.corrected,true);
 assert.equal(correction.feedback,'change the hook');
 assert.equal((await readFile(join(f.project,'middle-correction.meta'),'utf8')),'dag-initial-B');
 assert.ok(f.launches.some(l=>l.id==='dag-initial-B' && l.review==='changes_requested'),
  'Model corrects source artifacts within the same Agent Task');
 await f.decide('B','approved');
 await completed(f);
 const trace=(await f.trace()).trim().split('\n');
 assert.equal(trace.filter(x=>x==='script:first:new').length,1,'approved upstream cannot run twice');
 assert.equal(trace.filter(x=>x==='script:last:new').length,1,'downstream runs after approval');
});

test('L3-S04: model-only B Request Changes resumes SAME Model Task and re-reviews before C',async t=>{
 const f=await fixture(t,{normalJob:true,mode:'normal',reviews:['middle'],modelB:true});
 await start(f);
 const first=await waiting(f,'B'),revision1=first.interactiveInvocation.revision;
 await f.decide('B','changes_requested');
 const second=await waiting(f,'B');
 assert.notEqual(second.interactiveInvocation.revision,revision1);
 assert.equal(second.id,first.id);
 assert.notEqual(second.interactiveInvocation.invocationId,first.interactiveInvocation.invocationId);
 const correction=JSON.parse(await readFile(join(f.project,'middle-correction.json'),'utf8'));
 assert.equal(correction.corrected,true);
 assert.equal(correction.feedback,'change the hook');
 await f.decide('B','approved');
 await completed(f);
 assert.deepEqual(f.launches.filter(l=>l.id==='dag-initial-B').map(l=>l.review),
  [undefined,'changes_requested','approved'],'every revision stays on the same durable Model Agent Task');
 assert.deepEqual((await f.trace()).trim().split('\n').filter(x=>x.startsWith('script:')),
  ['script:first:new','script:last:new'],'model-only B never runs Script');
});
