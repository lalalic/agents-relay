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
const graph='flowchart TD\nA[agent:first] --> B[agent:middle]\nB --> C[agent:last]';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,label,ms=10000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await sleep(25)}throw Error('Timed out waiting for '+label)}
async function fixture(t,{reviews=[],modelB=false,mode='shortcut',parallel=false,badModelOutput=false}={}) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'relay-unified-l3-')));
 t.after(()=>rm(root,{recursive:true,force:true}));
 const project=join(root,'project');await mkdir(join(project,'agents','.shortcut'),{recursive:true});
 execFileSync('git',['init','-q',project]);await writeFile(join(project,'README.md'),'fixture\n');
 execFileSync('git',['-C',project,'add','README.md']);execFileSync('git',['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','init']);
 const id='19002',now=new Date().toISOString(),out=join(project,'result.json'),dbPath=join(root,'relay.sqlite');
 const dag=parallel?'flowchart TD\nA[agent:first] --> C[agent:last]\nB[agent:middle] --> C':graph;
 const job=createJobEntity({id,title:'Unified runtime L3',objective:'Three nodes',projectPath:'.',
  prNumber:0,repository:'local/unified',continuation:null,autoMerge:false,reviewEnabled:false,contentOnly:true,
  executionMode:mode,createdAt:now,updatedAt:now,tasks:[]});
 job.tasks.push(createTaskEntity(job,{jobId:id,id:'initial',parentTaskId:null,agentGraph:dag,kind:'work',
  input:'fixture original input',adapter:'codex',dependencies:[],capabilities:[],output:{kind:'file',path:out},
  attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,
  timeoutMs:300000,createdAt:now,updatedAt:now}));
 const raw=new SQLiteRelayStore(dbPath,id);await raw.createJobIfAbsent(job);
 const store=new Proxy(raw,{get(target,key){
  if(key==='load')return target.loadJob.bind(target);
  if(key==='listAgents')return async()=>[];
  if(key==='saveTask')return task=>target.mutateJob(id,j=>{const i=j.tasks.findIndex(x=>x.id===task.id);if(i<0)throw Error('Missing task');j.tasks[i]=structuredClone(task);return j});
  if(key==='appendTask')return task=>target.mutateJob(id,j=>{if(j.tasks.some(t=>t.id===task.id))throw Error('Duplicate task');j.tasks.push(structuredClone(task));return j});
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 t.after(()=>raw.close());
 const helper=join(root,'ask-review.mjs');
 await writeFile(helper,`import {SQLiteRelayStore} from ${JSON.stringify(new URL('../../dist/relay-store.js',import.meta.url).href)};
import {beginInteractiveReview} from ${JSON.stringify(new URL('../../dist/interactive-request.js',import.meta.url).href)};
import {tryTransitionTaskEvent} from ${JSON.stringify(new URL('../../dist/task-transitions.js',import.meta.url).href)};
import {appendFile} from 'node:fs/promises';
const db=new SQLiteRelayStore(${JSON.stringify(dbPath)},${JSON.stringify(id)});
try{
const taskId=process.argv[2],job=await db.loadJob(${JSON.stringify(id)}),task=job.tasks.find(t=>t.id===taskId);
const inv=await beginInteractiveReview(db,job.id,task.id,task.executionId);
await db.mutateJob(job.id,j=>{const current=j.tasks.find(t=>t.id===taskId);
if(current.interactiveInvocation?.executionId!==inv.executionId)throw Error('Wrong Review execution');
const decision=tryTransitionTaskEvent(current,'task.interactive_waiting',{awaitingInteractiveDecision:true});
if(!decision.accepted)throw Error('Review Task graph rejected wait');
current.leaseOwner=null;current.leaseExpiresAt=null;current.executionId=null;return j;});
await appendFile(${JSON.stringify(join(root,'trace.log'))},'preview:'+taskId+'\\n');
}finally{db.close()}`);
 for(const name of ['first','middle','last']){
  await writeFile(join(project,'agents',name+'.agent.md'),`---\nname: ${name}\n---\n# ${name}\n`);
  if(modelB&&name==='middle')continue;
  await writeFile(join(project,'agents','.shortcut',name+'.agent.mjs'),`import {appendFile} from 'node:fs/promises';
export async function run({input,runCommand}){
 await appendFile(${JSON.stringify(join(root,'trace.log'))},'script:${name}:'+String(input.reviewDecision?.status??'new')+'\\n');
 if(${name==='middle'&&!parallel}&&input.predecessorOutputs.A?.stage!=='first')throw Error('Predecessor A missing');
 if(${name==='last'}&&input.predecessorOutputs.B?.stage!=='middle')throw Error('Predecessor B missing');
 if(${name==='last'&&parallel}&&input.predecessorOutputs.A?.stage!=='first')throw Error('Fork predecessor A missing');
 if(${parallel&&name!=='last'}){
  await appendFile(${JSON.stringify(join(root,'trace.log'))},'branch:start:${name}\\n');
  await new Promise(r=>setTimeout(r,120));
  await appendFile(${JSON.stringify(join(root,'trace.log'))},'branch:end:${name}\\n');
 }
 const review=${reviews.includes(name)};
 if(review&&(!input.reviewDecision||input.reviewDecision.status==='changes_requested')){
  const response=await runCommand([process.execPath,${JSON.stringify(helper)},input.taskId],input.projectPath);
  if(response.code!==0)throw Error('Review request failed '+response.stderr);
  return {status:'WAITING_REVIEW'};
 }
 return {status:'COMPLETED',output:{stage:'${name}',review:input.reviewDecision?.status||null},artifacts:[]};
}`);
 }
 const bus=new MemoryEventBus(),launches=[];
 const model={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
   launches.push({id:task.id,executionId:task.executionId,review:task.interactiveInvocation?.status});
   const work=(async()=>{
     const source={id:`job/${id}/task/${task.id}/execution/${task.executionId}`};
     const publish=async(type,status,message,data={})=>bus.publish(eventFor(id,task.id,task.parentTaskId,type,status,message,'orchestrator',data,source));
     await publish('task.started','running','Model task started');
     if(reviews.includes('middle')&&(!task.interactiveInvocation?.decidedAt||task.interactiveInvocation.status==='changes_requested')){
       const inv=await beginInteractiveReview(store,id,task.id,task.executionId);
       await store.mutateJob(id,j=>{const current=j.tasks.find(t=>t.id===task.id);
         if(current.interactiveInvocation?.executionId!==inv.executionId)throw Error('Review lost');
         const step=tryTransitionTaskEvent(current,'task.interactive_waiting',{awaitingInteractiveDecision:true});
         if(!step.accepted)throw Error('Wait denied');
         current.leaseOwner=null;current.leaseExpiresAt=null;current.executionId=null;return j;});
       return {summary:'Model awaiting review'};
     }
     const result=badModelOutput ? {status:'COMPLETED',output:null,artifacts:[]} : {status:'COMPLETED',output:{stage:'middle',review:task.interactiveInvocation?.status??null},artifacts:[]};
     await writeFile(task.output.path,JSON.stringify(result));
     await publish('task.completed','succeeded','Model done',result);
     return {summary:'Model completed'};
   })();return {id:'fixture-model',promise:work,cancel:()=>{}};
 }};
 const reconciler=managedReconciler(store,{owner:'dag-l3',maxConcurrent:3,adapters:[model],eventBus:bus,noGitHub:true,
   projectPathForJob:async()=>project,executionContextRoots:{workspaceRoot:root}});
 const stop=await reconciler.watch(id);t.after(stop);
 async function activate(){await store.mutateJob(id,j=>{j.state='ACTIVE';if(mode==='shortcut')j.tasks[0].result={summary:'DAG ready',data:{dag:{version:1,graphHash:createHash('sha256').update(dag).digest('hex')}}};return j});}
 async function startCLI(){
  const cli=fileURLToPath(new URL('../../dist/cli.js',import.meta.url));
  await mkdir(join(root,'stores'),{recursive:true});
  const result=spawnSync(process.execPath,[cli,'job','run','--mode','shortcut','--id',id,'--task-id','initial',
   '--no-github','--store-dir',join(root,'stores'),'--project-path',project,'--workspace-root',root],
   {encoding:'utf8',timeout:15000,env:{...process.env,AGENTS_RELAY_STORE_DIR:root}});
  assert.equal(result.status,0,result.stderr);
  const receipt=JSON.parse(result.stdout);
  assert.equal(receipt.scheduled,true);
  assert.equal(receipt.graphRuntime,'tasks');
  return receipt;
 }
 async function load(){return store.loadJob(id)}
 async function decide(node,status='approved'){
   const key='dag-initial-'+node;
   const task=(await load()).tasks.find(t=>t.id===key);
   assert.equal(task?.state,'AWAITING_DECISION',key);
   const invocation=task.interactiveInvocation;
   await store.mutateJob(id,j=>{const current=j.tasks.find(t=>t.id===key);current.interactiveInvocation.status=status;
     current.interactiveInvocation.decidedAt=new Date().toISOString();current.interactiveInvocation.feedback='change the hook';return j});
   assert.equal(await resumeInteractiveTask(store,id,key,invocation.invocationId,invocation.revision,status),true);
   await reconciler.reconcile(id);
 }
 return {root,project,store,reconciler,id,load,activate,startCLI,decide,trace:async()=>{try{return await readFile(join(root,'trace.log'),'utf8')}catch{return ''}},launches};
}
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
test('L3-U05: Shortcut CLI only starts the Job; Reconciler executes durable DAG children',async t=>{
 const f=await fixture(t);await f.startCLI();
 const started=await f.load();assert.equal(started.state,'ACTIVE');
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
