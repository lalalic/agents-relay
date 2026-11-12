/** Four existing three-Agent L3 scenarios, now through the ordinary plan-free
 * Coordinator Job ingress. Only the Job start changes: the Script/Model,
 * human Review, Request Changes, and Approve behavior remains identical.
 * Real CLI, Git fixture, SQLite, production Reconciler and Task adapters;
 * synthetic model inference only. No private owner data or live notifications.
 */
import test from '../test-runtime.js';
import assert from 'node:assert/strict';
import {readFile,access,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
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
 // One ingress tick starts the Coordinator; later Agent transitions must wake
 // the Reconciler through the real event bus, not a test polling scheduler.
 await f.reconciler.reconcile(f.id);
}
async function waiting(f,node){
 const id='dag-initial-'+node;
 return until(async()=>{
  const job=await f.load(),task=job.tasks.find(t=>t.id===id);
  if(task?.state==='FAILED'||task?.state==='BLOCKED')
   throw Error('Unexpected Task failure: '+JSON.stringify({id,state:task.state,error:task.error,executionId:task.executionId,attempt:task.attempt,history:task.executionHistory})+'; trace='+(await f.trace()).slice(-800));
  return task?.state==='AWAITING_DECISION'?task:null;
 },'normal Agent Review '+node,20000);
}
async function completed(f){
 const job=await until(async()=>{
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

test('L3-C01: mixed three-node DAG A/C Shortcut + B Model completes without Agent Review',async t=>{
 const f=await fixture(t,{normalJob:true,mode:'normal',modelB:true});
 assert.ok(f.root.startsWith(await realpath(tmpdir())),'fixture must be under temporary system directory');
 assert.equal(execFileSync('git',['-C',f.project,'rev-parse','--show-toplevel'],{encoding:'utf8'}).trim(),f.project);
 const initial=await f.load();
 assert.equal(initial.projectRoot,f.project);
 assert.equal(initial.repository,'project');
 assert.equal(initial.reviewEnabled,false);
 await start(f);
 const done=await completed(f);
 assert.deepEqual(done.tasks.filter(task=>task.dagNode).map(task=>task.dagNode.executor),['script','model','script']);
 assert.deepEqual((await f.trace()).trim().split('\n'),['script:first:new','script:last:new']);
 assert.deepEqual(f.launches.filter(item=>item.id==='dag-initial-B').map(item=>item.review),[undefined]);
 assert.equal(done.review,undefined,'no Job Review is pending');
 assert.ok(done.tasks.every(task=>!task.interactiveInvocation),'no Agent requested interactive review');
 await access(join(f.root,'relay.sqlite')); // Confirm durable SQLite exists within the disposable fixture.
});

test('L3-C02: three-node Review / Approve / direct event continuation to the next Agent',async t=>{
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

test('L3-C03: Script B Request Changes uses the SAME durable Agent Task, then re-review and Approve',async t=>{
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

test('L3-C04: model-only B Request Changes resumes SAME Model Task and re-reviews before C',async t=>{
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

// One real local Coordinator Job proves both review paths can coexist on the
// same three-node Graph: a Shortcut requests changes at A, a Model at B,
// and C must not be materialized until both approvals have been persisted.
test('L3-C05: mixed Shortcut A and Model B each Request Changes -> re-review -> Approve; C remains gated',async t=>{
 const f=await fixture(t,{normalJob:true,mode:'normal',modelB:true,reviews:['first','middle']});
 await start(f);
 const first=await waiting(f,'A');
 assert.equal(first.dagNode.executor,'script');
 let current=await f.load();
 assert.equal(current.tasks.some(task=>task.id==='dag-initial-B'||task.id==='dag-initial-C'),false);
 await f.decide('A','changes_requested');
 const revisedA=await waiting(f,'A');
 assert.equal(revisedA.id,first.id);
 assert.notEqual(revisedA.interactiveInvocation.invocationId,first.interactiveInvocation.invocationId);
 assert.notEqual(revisedA.interactiveInvocation.revision,first.interactiveInvocation.revision);
 assert.equal((await f.load()).tasks.some(task=>task.id==='dag-initial-B'),false,'B cannot run before Shortcut A approval');
 assert.equal(JSON.parse(await readFile(join(f.project,'first-correction.json'),'utf8')).feedback,'change the hook');
 await f.decide('A','approved');
 const second=await waiting(f,'B');
 assert.equal(second.dagNode.executor,'model');
 current=await f.load();
 assert.equal(current.tasks.some(task=>task.id==='dag-initial-C'),false,'C cannot run before Model B approval');
 await f.decide('B','changes_requested');
 const revisedB=await waiting(f,'B');
 assert.equal(revisedB.id,second.id);
 assert.notEqual(revisedB.interactiveInvocation.invocationId,second.interactiveInvocation.invocationId);
 assert.notEqual(revisedB.interactiveInvocation.revision,second.interactiveInvocation.revision);
 assert.equal((await f.load()).tasks.some(task=>task.id==='dag-initial-C'),false);
 assert.equal(JSON.parse(await readFile(join(f.project,'middle-correction.json'),'utf8')).feedback,'change the hook');
 await f.decide('B','approved');
 const finished=await completed(f);
 assert.deepEqual(finished.tasks.filter(task=>task.dagNode).map(task=>task.dagNode.executor),['script','model','script']);
 assert.deepEqual(f.launches.filter(task=>task.id==='dag-initial-A').map(task=>task.review),['changes_requested'],
  'Shortcut A reuses its declared Script executor after Approve; its changes-requested revision used Model');
 assert.deepEqual(f.launches.filter(task=>task.id==='dag-initial-B').map(task=>task.review),[undefined,'changes_requested','approved']);
 assert.deepEqual((await f.trace()).trim().split('\n').filter(item=>item.startsWith('script:')),
  ['script:first:new','script:first:approved','script:last:new']);
 assert.equal(finished.tasks.length,4,'reviews must resume the original Task, not spawn separate revision Tasks');
 for(const node of ['A','B']){
  const task=finished.tasks.find(task=>task.id==='dag-initial-'+node);
  assert.equal(task.state,'SUCCEEDED');
  assert.ok(task.executionHistory?.length>=2,'review must retain execution generations');
 }
});
