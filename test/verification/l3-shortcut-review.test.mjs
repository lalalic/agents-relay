/** L3: three-node Shortcut DAG, real CLI/Git/SQLite/interactive review Graph,
 * deterministic synthetic Worker adapter, no providers or owner data. */
import test from '../test-runtime.js';
import assert from 'node:assert/strict';
import {spawnSync, execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile,appendFile,rm,realpath} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {createJobEntity,createTaskEntity} from '../../dist/workflow/entity-creation.js';
import {applyJobActivateAction} from '../../dist/job-actions.js';
import {beginInteractiveReview,interactiveWaitingEvent} from '../../dist/interactive-request.js';
import {resumeInteractiveTask} from '../../dist/interactive-resume.js';
import {tryTransitionTaskEvent} from '../../dist/task-transitions.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {createShortcutReviewWake} from '../../dist/shortcut-review-wake.js';
import {RepositoryWorkerPool} from '../../dist/pool.js';
import {runAgentShortcut} from '../../dist/agent-shortcut.js';
import {runShortcutModelNode} from '../../dist/shortcut-node-worker.js';
import {managedReconciler} from '../test-runtime.js';

const repo=fileURLToPath(new URL('../../',import.meta.url));
const graph='flowchart TD\nA[agent:first] --> B[agent:middle]\nB --> C[agent:last]';
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,label,ms=9000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await pause(25)}throw Error(`L3 timed out waiting for ${label}`);}

async function fixture(t,{reviews=[],missingScript=false}={}){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'relay-l3-three-shortcut-')));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const project=join(dir,'project'),shared=join(dir,'shared'),storeDir=join(dir,'stores'),result=join(dir,'result.json');
 await Promise.all([mkdir(join(project,'agents','.shortcut'),{recursive:true}),mkdir(join(project,'artifacts'),{recursive:true}),mkdir(join(shared,'agents','.shortcut'),{recursive:true}),mkdir(storeDir)]);
 git(project,'init','-q');await writeFile(join(project,'README.md'),'L3 offline fixture\n');
 git(project,'add','README.md');git(project,'-c','user.name=Relay L3','-c','user.email=relay-l3@example.invalid','commit','-qm','seed');
 const id='97001',now=new Date().toISOString(),dbPath=join(dir,'relay.sqlite');
 const job=createJobEntity({id,title:'Three agent L3',objective:'real 3-node DAG, review and recovery',projectPath:undefined,prNumber:0,
  repository:'local/shortcut-l3',continuation:null,autoMerge:false,reviewEnabled:false,contentOnly:true,executionMode:'shortcut',createdAt:now,updatedAt:now,tasks:[]});
 await applyJobActivateAction(job);
 job.tasks.push(createTaskEntity(job,{jobId:id,id:'initial',title:'Three agent DAG',kind:'work',agentGraph:graph,
  parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:'offline three agent fixture',
  output:{kind:'file',path:result},attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,
  threadId:null,result:null,error:null,timeoutMs:300000,createdAt:now,updatedAt:now}));
 const db=new SQLiteRelayStore(dbPath,id);try{await db.createJobIfAbsent(job);}finally{db.close()}
 const helper=join(dir,'review-helper.mjs');
 await writeFile(helper,`import {writeFile,readFile,appendFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {SQLiteRelayStore} from ${JSON.stringify(new URL('../../dist/relay-store.js',import.meta.url).href)};
import {beginInteractiveReview} from ${JSON.stringify(new URL('../../dist/interactive-request.js',import.meta.url).href)};
import {tryTransitionTaskEvent} from ${JSON.stringify(new URL('../../dist/task-transitions.js',import.meta.url).href)};
const stage=process.argv[2],dir=${JSON.stringify(dir)},project=${JSON.stringify(project)};
const db=new SQLiteRelayStore(join(dir,'relay.sqlite'),${JSON.stringify(id)});
try{const job=await db.loadJob(${JSON.stringify(id)}),task=job.tasks[0];
 const receipt=await beginInteractiveReview(db,job.id,task.id,task.executionId);
 const p=join(project,'artifacts',stage+'.json');
 let data;try{data=JSON.parse(await readFile(p,'utf8'));}catch{data={version:0};}
 data.preview=(data.preview??0)+1;await writeFile(p,JSON.stringify(data));
 const sha=task.executionId;
 await db.mutateJob(job.id,j=>{const t=j.tasks[0];
  if(t.interactiveInvocation?.executionId!==receipt.executionId)throw Error('Lost execution identity');
  const d=tryTransitionTaskEvent(t,'task.interactive_waiting',{awaitingInteractiveDecision:true});
  if(!d.accepted)throw Error('Review waiting Graph rejected');
  t.leaseOwner=null;t.leaseExpiresAt=null;t.executionId=null;return j;});
 await appendFile(join(dir,'trace.log'),'preview:'+stage+':'+sha+'\\n');
 process.stdout.write(JSON.stringify({stage,executionId:sha}));
}finally{db.close()}`);
 for(const name of ['first','middle','last']){
  await writeFile(join(project,'agents',name+'.agent.md'),`---\nname: ${name}\n---\n# ${name}\n`);
  if(missingScript&&name==='middle')continue;
  const reviewing=reviews.includes(name);
  await writeFile(join(project,'agents','.shortcut',name+'.agent.mjs'),`import {appendFile} from 'node:fs/promises';
 export async function run({input,runCommand}){
  await appendFile(${JSON.stringify(join(dir,'trace.log'))},'script:${name}:'+String(input.reviewDecision?.status??'new')+'\\n');
  if(${name==='middle'} && input.predecessorOutputs.A?.stage!=='first')throw Error('Wrong predecessor from A');
  if(${name==='last'} && input.predecessorOutputs.B?.stage!=='middle')throw Error('Wrong predecessor from B');
  if(!${reviewing})return {status:'COMPLETED',output:{stage:'${name}'},artifacts:[]};
  if(input.reviewDecision?.status==='approved')return {status:'COMPLETED',output:{stage:'${name}',approved:input.reviewDecision.revision},artifacts:[]};
  if(input.reviewDecision?.status==='changes_requested' && (!input.reviewRevision||input.reviewRevision.status!=='COMPLETED'||input.reviewRevision.output?.corrected!==true))throw Error('Revision Worker never corrected the artifact');
  const r=await runCommand([process.execPath,${JSON.stringify(helper)},'${name}'],${JSON.stringify(project)});
  if(r.code!==0)throw Error('Host preview failed: '+r.stderr);
  return {status:'WAITING_REVIEW'};
 }`);
 }
 const load=async()=>{const db=new SQLiteRelayStore(dbPath,id);try{return await db.loadJob(id)}finally{db.close()}};
 const mutate=async fn=>{const db=new SQLiteRelayStore(dbPath,id);try{return await db.mutateJob(id,fn)}finally{db.close()}};
 const trace=async()=>existsSync(join(dir,'trace.log'))?(await readFile(join(dir,'trace.log'),'utf8')).trim().split('\n'):[];
 const args=['job','run','--mode','shortcut','--id',id,'--repo','local/shortcut-l3','--no-github',
  '--store-dir',storeDir,'--task-id','initial','--project-path',project,'--shared-root',shared,'--workspace-root',dir];
 const cli=()=>spawnSync(process.execPath,[join(repo,'dist','cli.js'),...args],{encoding:'utf8',timeout:20000,
  env:{...process.env,AGENTS_RELAY_STORE_DIR:storeDir,AGENTS_RELAY_NO_GITHUB:'1'}});
 const decision=async(taskId,status,feedback='')=>{
  const j=await load(),task=j.tasks.find(t=>t.id===taskId);
  assert.equal(task?.state,'AWAITING_DECISION',`Expected ${taskId} awaiting, got ${task?.state}`);
  const inv=task.interactiveInvocation;
  assert.equal(inv.revision,inv.executionId);
  assert.equal(inv.status,'awaiting_decision');
  await mutate(fresh=>{const t=fresh.tasks.find(x=>x.id===taskId);t.interactiveInvocation.status=status;
   t.interactiveInvocation.feedback=feedback;t.interactiveInvocation.comments=feedback?[{text:feedback}]:[];
   t.interactiveInvocation.decidedAt=new Date().toISOString();return fresh;});
  const db=new SQLiteRelayStore(dbPath,id);
  try{assert.equal(await resumeInteractiveTask(db,id,taskId,inv.invocationId,inv.revision,status),true)}finally{db.close()}
  return {taskId,invocationId:inv.invocationId,revision:inv.revision,status};
 };
 return {dir,project,shared,storeDir,id,result,dbPath,cli,load,mutate,trace,decision};
}

async function watcher(f){
 const bus=new MemoryEventBus(),results=[];
 const wake=createShortcutReviewWake(async()=>f.load(),async()=>{
  const r=f.cli();results.push(r);
  assert.ok([0,3].includes(r.status),JSON.stringify(r));
 });
 const pool=new RepositoryWorkerPool(2,()=>({applyEvent:async()=>({applied:false,reconcile:false,reason:'task.interactive_decision.duplicate'}),reconcile:async()=>null}),
  async()=>[{job:await f.load()}],async()=>({job:await f.load(),store:{}}),wake);
 const stop=await pool.watch(bus);
 return {results,send:async decision=>{
   const length=results.length;
   await bus.publish(eventFor(f.id,decision.taskId,null,'task.interactive_decision','running','host decision accepted'));
   await until(async()=>results.length>length, 'review wake runner');
   // A RUNNING or WAITING transition is fully persisted before CLI returns.
   await pause(15);
  },stop};
}

function assertFinished(job,expected=3){
 assert.equal(job.state,'COMPLETED','Job must be terminal, never only Task success');
 assert.equal(job.tasks.find(t=>t.id==='initial').state,'SUCCEEDED');
 const nodes=job.tasks.find(t=>t.id==='initial').result?.data?.shortcut?.nodes;
 assert.deepEqual(Object.keys(nodes).sort(),['A','B','C']);
 assert.equal(Object.keys(nodes).length,expected);
 assert.ok(!job.localMerge,'Shortcut must never manufacture a localMerge from Worker review');
 assert.equal(job.tasks.every(t=>t.state==='SUCCEEDED'),true);
}

test('L3-S01: three-node Script happy path without Review',async t=>{
 const f=await fixture(t);const r=f.cli();assert.equal(r.status,0,r.stderr);
 assertFinished(await f.load());
 const trace=await f.trace();assert.deepEqual(trace,['script:first:new','script:middle:new','script:last:new']);
});

test('L3-S02: three-node Review / Approve / automatic event wake to next node',async t=>{
 const f=await fixture(t,{reviews:['first','middle','last']});
 assert.equal(f.cli().status,3);
 const w=await watcher(f);
 try{
  for(const stage of ['first','middle','last']){
   const pending=await f.load(),task=pending.tasks[0];assert.equal(task.state,'AWAITING_DECISION');
   assert.equal(task.interactiveInvocation.revision,task.interactiveInvocation.executionId);
   const d=await f.decision('initial','approved');
   await w.send(d);
   assert.equal(w.results.at(-1).status,stage==='last'?0:3,w.results.at(-1).stderr);
  }
  assertFinished(await f.load());
  const log=await f.trace();
  for(const stage of ['first','middle','last'])assert.equal(log.filter(x=>x==='script:'+stage+':new').length,1);
  assert.equal(log.filter(x=>x.startsWith('preview:')).length,3);
 }finally{await w.stop()}
});

/** Real reconciler and durable child Tasks; only model inference is substituted. */
async function workerFixture(f,{mode}){
 const raw=new SQLiteRelayStore(f.dbPath,f.id);
 const store=new Proxy(raw,{get(target,key){
  if(key==='listAgents')return async()=>[];
  if(key==='load')return target.loadJob.bind(target);
  if(key==='saveTask')return task=>target.mutateJob(f.id,j=>{const i=j.tasks.findIndex(t=>t.id===task.id);
   if(i<0)throw Error('durable Worker Task missing');j.tasks[i]=structuredClone(task);return j;});
  if(key==='appendTask')return task=>target.mutateJob(f.id,j=>{if(j.tasks.some(t=>t.id===task.id))throw Error('duplicate Worker Task');j.tasks.push(structuredClone(task));return j;});
  const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
 }});
 const bus=new MemoryEventBus(),launched=[],errors=[];
 const adapter={name:'codex',id:'codex',capabilities:['model','codex'],launch(task){
  launched.push({id:task.id,executionId:task.executionId,status:task.interactiveInvocation?.status});
  const source={id:`job/${f.id}/task/${task.id}/execution/${task.executionId}`};
  const work=(async()=>{
   await bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.started','running','L3 worker started','user',undefined,source));
   if(mode==='script-revision'){
    const durable=(await store.load(f.id)).tasks.find(t=>t.id===task.id);
    const input=JSON.parse(durable.input);
    assert.equal(input.nodeId,'B');assert.equal(input.reviewDecision.status,'changes_requested');
    assert.match(input.reviewDecision.feedback,/shorten opening/);
    assert.equal(input.reviewDecision.comments[0].text,'shorten opening');
    const path=join(f.project,'artifacts','middle.json');
    const data=JSON.parse(await readFile(path,'utf8'));
    data.version=2;data.revisedBy='model-worker';await writeFile(path,JSON.stringify(data));
    const value={status:'COMPLETED',output:{corrected:true,stage:'middle'},artifacts:[]};
    await mkdir(dirname(task.output.path),{recursive:true});await writeFile(task.output.path,JSON.stringify(value));
    await bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','L3 script revision completed','orchestrator',{},source));
    return;
   }
   if(mode!=='model-review')throw Error('Unknown L3 synthetic Worker');
   const decision=task.interactiveInvocation?.status;
   if(decision==='approved'){
    assert.ok(task.interactiveInvocation?.decidedAt,'Worker did not receive accepted decision');
    const value={status:'COMPLETED',output:{stage:'middle',approved:task.interactiveInvocation.revision},artifacts:[]};
    await mkdir(dirname(task.output.path),{recursive:true});await writeFile(task.output.path,JSON.stringify(value));
    await bus.publish(eventFor(f.id,task.id,task.parentTaskId,'task.completed','succeeded','L3 model approved','orchestrator',{},source));
    return;
   }
   if(decision==='changes_requested'){
    assert.match(JSON.stringify(task.comments),/shorten opening/,'Reviewer feedback missing from durable Worker Task');
   }else assert.equal(decision,undefined,'Initial model Worker must not see an old review');
   const p=join(f.project,'artifacts','middle.json');
   let data;try{data=JSON.parse(await readFile(p,'utf8'))}catch{data={version:0}}
   data.version=(data.version??0)+1;data.revisedBy='model-worker';
   await writeFile(p,JSON.stringify(data));
   const sha=task.executionId;
   await beginInteractiveReview(store,f.id,task.id,task.executionId);
   // Real worker lifecycle: publish the correlated waiting event. The
   // Reconciler clears the old live execution slot and lease atomically.
   await bus.publish(interactiveWaitingEvent(f.id,task.id,task.parentTaskId,task.executionId));
   await until(async()=>{const current=(await f.load()).tasks.find(t=>t.id===task.id);return current?.state==='AWAITING_DECISION'},'worker interactive_waiting Graph transition');
   const bound=(await store.load(f.id)).tasks.find(t=>t.id===task.id).interactiveInvocation;
   assert.equal(bound.revision,sha);
   await appendFile(join(f.dir,'trace.log'),`worker-review:middle:${sha}\n`);
  })().catch(error=>{errors.push(error?.stack??String(error));});
  return {id:'l3-worker-'+task.id,launched:Promise.resolve(),promise:work.then(()=>({summary:'L3 adapter settled'})),cancel(){}};
 }};
 const reconciler=managedReconciler(store,{shortcutRunnerOwner:true,owner:'l3-three-node',noGitHub:true,maxConcurrent:1,
  adapters:[adapter],eventBus:bus,projectPathForJob:()=>f.project,headShaProvider:()=>null});
 const stop=await reconciler.watch(f.id);
 return {store,reconciler,launched,errors,runModelNode:node=>runShortcutModelNode({store,reconciler,jobId:f.id,parentTaskId:'initial',node}),
  close:async()=>{await stop();await reconciler.close();raw.close();}};
}

test('L3-S03: three nodes, Script B Request Changes uses durable Worker then re-review and Approve',async t=>{
 const f=await fixture(t,{reviews:['middle']});
 assert.equal(f.cli().status,3);
 const first=await f.load();assert.deepEqual(Object.keys(first.tasks[0].result.data.shortcut.nodes),['A']);
 const initialSha=first.tasks[0].interactiveInvocation.revision;
 await f.decision('initial','changes_requested','shorten opening');
 const worker=await workerFixture(f,{mode:'script-revision'});
 try{
  const before=await worker.store.load(f.id);
  const result=await runAgentShortcut({store:worker.store,job:before,task:before.tasks[0],projectPath:f.project,sharedRoot:f.shared,
   signal:AbortSignal.timeout(4500),runModelNode:worker.runModelNode});
  assert.equal(result.outcome.status,'WAITING_REVIEW',JSON.stringify({result,errors:worker.errors}));
  assert.deepEqual(worker.errors,[]);
  const current=await f.load(),child=current.tasks.find(t=>t.id.startsWith('shortcut-initial-B-revision-'));
  assert.equal(child?.state,'SUCCEEDED','semantic correction must be durable Worker Task');
  assert.equal(current.tasks[0].state,'AWAITING_DECISION');
  const newSha=current.tasks[0].interactiveInvocation.revision;
  assert.notEqual(newSha,initialSha);assert.equal(newSha,current.tasks[0].interactiveInvocation.executionId);
  assert.equal(JSON.parse(await readFile(join(f.project,'artifacts','middle.json'),'utf8')).version,2);
  assert.equal((await f.trace()).filter(x=>x==='script:first:new').length,1);
  await f.decision('initial','approved');
  const final=f.cli();assert.equal(final.status,0,JSON.stringify(final));
  assertFinished(await f.load());
  assert.equal(worker.launched.length,1);
  assert.equal((await f.trace()).filter(x=>x==='script:last:new').length,1);
 }finally{await worker.close()}
});

test('L3-S04: three nodes, model-only B Request Changes resumes same Worker and re-reviews before C',async t=>{
 const f=await fixture(t,{missingScript:true});
 const worker=await workerFixture(f,{mode:'model-review'});
 const controller=new AbortController();
 const timer=setTimeout(()=>controller.abort(Error('L3-S04 wall time exceeded')),13000);
 let pending=Promise.resolve();
 try{
  const before=await worker.store.load(f.id);
  pending=runAgentShortcut({store:worker.store,job:before,task:before.tasks[0],projectPath:f.project,sharedRoot:f.shared,
   signal:controller.signal,runModelNode:worker.runModelNode});
  const taskId='shortcut-initial-B';
  const original=await until(async()=>{
   const j=await f.load(),t=j.tasks.find(x=>x.id===taskId);
   return t?.state==='AWAITING_DECISION'&&t.interactiveInvocation?.revision===t.interactiveInvocation?.executionId?t:null;
  },'model-only Stage B first human review');
  assert.equal((await f.load()).tasks.find(t=>t.id==='initial').state,'RUNNING');
  const sha1=original.interactiveInvocation.revision;
  await f.decision(taskId,'changes_requested','shorten opening');
  await worker.reconciler.reconcile(f.id);
  const revised=await until(async()=>{
   const t=(await f.load()).tasks.find(x=>x.id===taskId);
   return t?.state==='AWAITING_DECISION'&&t.interactiveInvocation.revision!==sha1?t:null;
  },'model-only Stage B new review after comments',4500);
  const sha2=revised.interactiveInvocation.revision;
  assert.notEqual(sha1,sha2);assert.equal(sha2,revised.interactiveInvocation.executionId);
  assert.notEqual(revised.interactiveInvocation.invocationId,original.interactiveInvocation.invocationId);
  assert.equal(JSON.parse(await readFile(join(f.project,'artifacts','middle.json'),'utf8')).version,2);
  await f.decision(taskId,'approved');
  const completed=await pending;
  assert.equal(completed.outcome.status,'COMPLETED',JSON.stringify({outcome:completed.outcome,errors:worker.errors}));
  assertFinished(await f.load());
  assert.deepEqual(worker.errors,[]);
  assert.deepEqual(worker.launched.map(x=>x.status),[undefined,'changes_requested','approved']);
  assert.deepEqual((await f.trace()).filter(x=>x.startsWith('script:')),['script:first:new','script:last:new']);
 }finally{clearTimeout(timer);controller.abort();await pending.catch(()=>{});await worker.close()}
});
