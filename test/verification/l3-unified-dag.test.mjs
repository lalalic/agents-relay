import test from '../test-runtime.js';
import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {createJobEntity,createTaskEntity} from '../../dist/workflow/entity-creation.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {beginInteractiveReview} from '../../dist/interactive-request.js';
import {resumeInteractiveTask} from '../../dist/interactive-resume.js';
import {tryTransitionTaskEvent} from '../../dist/task-transitions.js';
import {managedReconciler} from '../test-runtime.js';
import {ScriptTaskAdapter} from '../../dist/script-task-adapter.js';
import {fixture,until,sleep,graph} from './l3-unified-dag-fixture.mjs';
test('L3-U01: three Script Tasks no review',async t=>{
 const f=await fixture(t);await f.activate();await f.reconciler.reconcile(f.id);
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();if(j.tasks.some(t=>t.state==='FAILED'||t.state==='BLOCKED')){console.log('FAILED_TASKS',JSON.stringify(j.tasks.map(t=>({id:t.id,title:t.title,state:t.state,error:t.error,executionId:t.executionId})),null,2));throw Error('DAG failed');}return j.tasks.find(t=>t.id==='initial')?.state==='SUCCEEDED'?j:null},'DAG complete',5000);
 assert.equal(done.tasks.find(t=>t.id==='initial').title,'Coordinator');
 for(const [node,agent] of [['A','first'],['B','middle'],['C','last']]){
  const task=done.tasks.find(t=>t.id==='dag-initial-'+node);
  assert.equal(task?.title,agent);assert.equal(task?.state,'SUCCEEDED');
 }
 assert.equal(done.tasks.length,4);
});
for(const [label,config,decisions] of [
 ['L3-U02: three Script Tasks all Approve',{reviews:['first','middle','last']},[['A','approved'],['B','approved'],['C','approved']]],
 ['L3-U03: Script B Request Changes and resumes same Task',{reviews:['middle']},[['B','changes_requested'],['B','approved']]],
 ['L3-U04: Model B Request Changes and resumes same Task',{reviews:['middle'],modelB:true},[['B','changes_requested'],['B','approved']]],
])test(label,async t=>{
 const f=await fixture(t,config);await f.activate();await f.reconciler.reconcile(f.id);
 for(const [node,status] of decisions){
  try{
   await until(async()=>{
    await f.reconciler.reconcile(f.id);
    const j=await f.load();const current=j.tasks.find(t=>t.id==='dag-initial-'+node);
    if(current?.state==='FAILED'||current?.state==='BLOCKED')
      throw Error('Review Task failed: '+JSON.stringify({id:current.id,adapter:current.adapter,error:current.error,failureReason:current.failureReason}));
    return current?.state==='AWAITING_DECISION';
   },'review '+node,20000);
  }catch(error){
   const j=await f.load();
   throw Error(String(error)+'; durable='+JSON.stringify(j.tasks.map(t=>({id:t.id,state:t.state,adapter:t.adapter,attempt:t.attempt,error:t.error,review:t.interactiveInvocation?.status})))+'; trace='+(await f.trace()).slice(-1800));
  }
  await f.decide(node,status);
 }
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();
  if(j.tasks.some(t=>t.state==='FAILED'||t.state==='BLOCKED')){console.log('FAILED',j.tasks.map(t=>({id:t.id,state:t.state,error:t.error})));throw Error('Failed DAG');}
  return j.tasks.find(t=>t.id==='initial')?.state==='SUCCEEDED'?j:null;
 },'DAG completed',20000);
 assert.equal(done.tasks.find(t=>t.id==='initial').title,'Coordinator');
 for(const [node,agent] of [['A','first'],['B','middle'],['C','last']]){
  const task=done.tasks.find(t=>t.id==='dag-initial-'+node);
  assert.equal(task?.title,agent);assert.equal(task?.state,'SUCCEEDED');
 }
 assert.equal(done.tasks.length,4,'no revision worker subtask');
 if(label.includes('Script B Request Changes'))assert.equal(f.launches.some(l=>l.id==='dag-initial-B'),true,'same Task executes model revision');
});

// Real production ingress: CLI only activates; the SAME normal Reconciler creates Tasks.
test('L3-U05: CLI starts ordinary no-plan Job; normal Reconciler executes durable DAG children',async t=>{
 const f=await fixture(t,{mode:'normal'});await f.startCLI();
 const started=await f.load();assert.equal(started.state,'ACTIVE');
 assert.equal(started.executionMode,undefined,'Job start must not store executionMode');
 assert.equal(started.tasks.length,1,'CLI must not itself execute graph nodes');
 await f.reconciler.reconcile(f.id);
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();return j.state==='COMPLETED'?j:null},'Shortcut job terminal',6500);
 assert.equal(done.tasks.length,4);
 assert.equal(done.tasks[0].title,'Coordinator');
 assert.deepEqual(done.tasks.filter(t=>t.dagNode).map(t=>t.title),['first','middle','last']);
 assert.ok(done.tasks.filter(t=>t.dagNode).every(t=>t.state==='SUCCEEDED'));
});

test('L3-U06: Normal Graph uses exactly the same Agent Tasks and Reconciler',async t=>{
 const f=await fixture(t,{mode:'normal'});await f.activate();
 await f.reconciler.reconcile(f.id);
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();return j.tasks[0]?.state==='SUCCEEDED'?j:null},'normal DAG',6500);
 assert.equal(done.state,'COMPLETED','Normal and Shortcut content-only Job completion must match');
 assert.equal(done.tasks.length,4);
 assert.equal(done.tasks[0].title,'Coordinator');
 assert.deepEqual(done.tasks.filter(t=>t.dagNode).map(t=>t.title),['first','middle','last']);
 assert.equal(done.tasks.filter(t=>t.dagNode).every(t=>t.state==='SUCCEEDED'),true);
});

test('L3-U07: repeated reconciliation is idempotent after DAG completion',async t=>{
 const f=await fixture(t);await f.activate();
 await until(async()=>{await f.reconciler.reconcile(f.id);return (await f.load()).tasks[0]?.state==='SUCCEEDED'},'DAG complete',6500);
 const before=await f.load();
 for(let i=0;i<5;i++)await f.reconciler.reconcile(f.id);
 const after=await f.load();
 assert.deepEqual(after.tasks.map(t=>[t.id,t.state,t.executionHistory?.length]),before.tasks.map(t=>[t.id,t.state,t.executionHistory?.length]));
 assert.equal((await f.trace()).trim().split('\n').filter(Boolean).length,3,'one physical execution per completed stage');
});

test('L3-U08: fork/join runs independent DAG Tasks concurrently and joins results',async t=>{
 const f=await fixture(t,{parallel:true});await f.activate();
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();return j.tasks[0]?.state==='SUCCEEDED'?j:null},'parallel DAG',8000);
 assert.equal(done.tasks.length,4);
 const trace=(await f.trace()).trim().split('\n');
 const a=trace.indexOf('branch:start:first'),b=trace.indexOf('branch:start:middle');
 const endA=trace.indexOf('branch:end:first'),endB=trace.indexOf('branch:end:middle');
 assert.ok(a>=0 && b>=0 && endA>=0 && endB>=0,JSON.stringify(trace));
 assert.ok(a<endB && b<endA,'both branches must start before either one completes');
 assert.ok(trace.indexOf('script:last:new')>endA && trace.indexOf('script:last:new')>endB,'join waits for both');
});

test('L3-U09: invalid Model result fails only the Agent Task; Coordinator awaits ordinary recovery',async t=>{
 const f=await fixture(t,{modelB:true,badModelOutput:true});await f.activate();
 const failed=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();return j.tasks.some(x=>x.id==='dag-initial-B'&&x.state==='FAILED')?j:null},'invalid-model failure',5000);
 const parent=failed.tasks.find(x=>x.id==='initial'),a=failed.tasks.find(x=>x.id==='dag-initial-A');
 const b=failed.tasks.find(x=>x.id==='dag-initial-B');
 assert.equal(parent.state,'RUNNING');assert.equal(a.state,'SUCCEEDED');
 assert.equal(b.failureReason,'invalid_dag_result');
 assert.equal(failed.tasks.filter(x=>x.id==='dag-initial-B').length,1);
 assert.equal(failed.tasks.some(x=>x.id==='dag-initial-C'),false,'downstream must remain unscheduled');
 await f.reconciler.reconcile(f.id);
 const recovery=await f.load();
 assert.ok(recovery.tasks.some(x=>x.agentName==='troubleshooter'&&x.parentTaskId===b.id),'ordinary Task Troubleshooter owns failure');
});

test('L3-U10: durable Script Task terminal events wake the Reconciler without polling',async t=>{
 const f=await fixture(t);await f.activate();
 await f.reconciler.reconcile(f.id);
 const done=await until(async()=>{const j=await f.load();return j.state==='COMPLETED'?j:null},'automatic Script event wake',7500);
 assert.equal(done.tasks.length,4);
 assert.deepEqual(done.tasks.filter(t=>t.dagNode).map(t=>t.state),['SUCCEEDED','SUCCEEDED','SUCCEEDED']);
});

test('L3-U11: an ordinary single Agent Task can use the Script Adapter without a DAG',async t=>{
 const f=await fixture(t,{mode:'normal'});
 const job=await f.load();
 const task={...job.tasks[0],agentGraph:undefined,agentName:'first',title:'first',adapter:'script',
   capabilities:['script'],state:'RUNNING',leaseOwner:'single-task',executionId:'single-execution-1',attempt:1};
 const events=[];
 const adapter=new ScriptTaskAdapter(async event=>{events.push(event)});
 const execution=adapter.launch(task,new AbortController().signal,{executionContext:{project:{path:f.project}}});
 await execution.promise;
 assert.equal(events.filter(e=>e.type==='task.started').length,1);
 assert.equal(events.filter(e=>e.type==='task.completed').length,1);
 assert.equal(events.filter(e=>e.type==='task.failed').length,0);
 assert.equal(JSON.parse(await readFile(task.output.path,'utf8')).output.stage,'first');
 assert.match(await f.trace(),/script:first:new/);
});

test('L3-U12: job run queues a DRAFT Agent Graph root with no Planner and no mode flag',async t=>{
 const f=await fixture(t,{mode:'normal'});
 await f.store.mutateJob(f.id,j=>{j.tasks[0].state='DRAFT';return j});
 await f.startCLI();
 const started=await f.load();
 assert.equal(started.executionMode,undefined);
 assert.equal(started.state,'ACTIVE');
 assert.equal(started.tasks[0].state,'QUEUED');
 assert.equal(started.plans?.length??0,0);
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();return j.state==='COMPLETED'?j:null},'DRAFT Graph Job terminal',7000);
 assert.equal(done.tasks.length,4);
 assert.deepEqual(done.tasks.filter(t=>t.dagNode).map(t=>t.title),['first','middle','last']);
});

test('L3-U13: a plan-free Graph Job with Final Review/Merge enabled does not bypass those gates',async t=>{
 const f=await fixture(t,{mode:'normal'});
 await f.store.mutateJob(f.id,j=>{j.contentOnly=false;j.autoMerge=true;j.reviewEnabled=true;return j});
 await f.startCLI();
 const done=await until(async()=>{await f.reconciler.reconcile(f.id);const j=await f.load();return j.tasks.find(t=>t.id==='initial')?.state==='SUCCEEDED'?j:null},'non-content DAG',7000);
 assert.equal(done.state,'ACTIVE','Implementation success does not approve final Job review or merge');
 assert.equal(done.reviewEnabled,true);
 assert.equal(done.autoMerge,true);
 assert.equal(done.executionMode,undefined);
});

test('L3-U14: duplicate normal Job start is idempotent and rejects changed trusted roots',async t=>{
 const f=await fixture(t,{mode:'normal'});
 await f.startCLI();
 const job=await f.load();
 assert.equal(job.tasks.length,1,'activation is not a second DAG executor');
 assert.ok(job.graphStartContext?.projectPath);
 const cli=fileURLToPath(new URL('../../dist/cli.js',import.meta.url));
 const result=spawnSync(process.execPath,[cli,'job','run','--id',f.id,'--task-id','initial',
   '--no-github','--store-dir',join(f.root,'stores'),'--project-path',f.project,
   '--workspace-root',f.root,'--shared-root',join(f.root,'other-agents')],
   {encoding:'utf8',timeout:15000,env:{...process.env,AGENTS_RELAY_STORE_DIR:f.root}});
 assert.notEqual(result.status,0);
 assert.match(result.stderr,/Graph start context changed/);
 const after=await f.load();
 assert.equal(after.state,'ACTIVE');
 assert.equal(after.tasks.length,1);
 assert.equal(after.graphStartContext.sharedRoot,undefined);
});
