import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {mkdtemp,realpath,mkdir,writeFile,readFile,rm,access} from 'node:fs/promises';
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
import {allocateEntityId} from '../../dist/job-task-id-sequence.js';
import {relayStoreDirectory} from '../../dist/relay-store.js';
export const graph='flowchart TD\nA[agent:first] --> B[agent:middle]\nB --> C[agent:last]';
export const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
export async function until(fn,label,ms=10000){const start=Date.now();while(Date.now()-start<ms){const value=await fn();if(value)return value;await sleep(25)}throw Error('Timed out waiting for '+label)}
export async function fixture(t,{reviews=[],modelB=false,mode='normal',parallel=false,badModelOutput=false,normalJob=true}={}) {
 const root=await realpath(await mkdtemp(join(tmpdir(),'relay-unified-l3-')));
 t.after(async()=>{
  await rm(root,{recursive:true,force:true});
  await assert.rejects(access(root),{code:'ENOENT'},'temporary local Git and SQLite test directory must be removed');
 });
 const project=join(root,'project');await mkdir(join(project,'agents','.shortcut'),{recursive:true});
 execFileSync('git',['init','-q',project]);await writeFile(join(project,'README.md'),'fixture\n');
 execFileSync('git',['-C',project,'add','README.md']);execFileSync('git',['-C',project,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','init']);
 const id='19002',now=new Date().toISOString(),out=join(project,'result.json'),dbPath=join(root,'relay.sqlite');
 const dag=parallel?'flowchart TD\nA[agent:first] --> C[agent:last]\nB[agent:middle] --> C':graph;
 const job=createJobEntity({id,title:'Unified runtime L3',objective:'Three nodes',projectPath:'.',projectRoot:project,
  prNumber:0,repository:'project',continuation:null,autoMerge:normalJob,reviewEnabled:false,
  createdAt:now,updatedAt:now,tasks:[]});
 const coordinatorId=allocateEntityId(relayStoreDirectory(),'project','task');
 job.tasks.push(createTaskEntity(job,{jobId:id,id:coordinatorId,parentTaskId:null,agentGraph:dag,kind:'work',
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
     if(task.interactiveInvocation?.status==='changes_requested') {
       assert.match(task.interactiveInvocation.feedback||'',/change the hook/);
       assert.equal(task.interactiveInvocation.comments?.[0]?.text,'change the hook');
       await writeFile(join(project,task.agentName+'-correction.json'),JSON.stringify({corrected:true,executionId:task.executionId,feedback:task.interactiveInvocation.feedback}));
       await writeFile(join(project,task.agentName+'-correction.meta'),task.id);
     }
     if(reviews.includes(task.agentName)&&(!task.interactiveInvocation?.decidedAt||task.interactiveInvocation.status==='changes_requested')){
       const inv=await beginInteractiveReview(store,id,task.id,task.executionId);
       await store.mutateJob(id,j=>{const current=j.tasks.find(t=>t.id===task.id);
         if(current.interactiveInvocation?.executionId!==inv.executionId)throw Error('Review lost');
         const step=tryTransitionTaskEvent(current,'task.interactive_waiting',{awaitingInteractiveDecision:true});
         if(!step.accepted)throw Error('Wait denied');
         current.leaseOwner=null;current.leaseExpiresAt=null;current.executionId=null;return j;});
       return {summary:'Model awaiting review'};
     }
     const result=badModelOutput ? {status:'COMPLETED',output:null,artifacts:[]} : {status:'COMPLETED',output:{stage:task.agentName,review:task.interactiveInvocation?.status??null},artifacts:[]};
     await writeFile(task.output.path,JSON.stringify(result));
     await publish('task.completed','succeeded','Model done',result);
     return {summary:'Model completed'};
   })();return {id:'fixture-model',promise:work,cancel:()=>{}};
 }};
 const reconciler=managedReconciler(store,{owner:'dag-l3',maxConcurrent:3,adapters:[model],eventBus:bus,noGitHub:true,
   projectPathForJob:async()=>project,executionContextRoots:{workspaceRoot:root}});
 const stop=await reconciler.watch(id);t.after(stop);
 async function activate(){await store.mutateJob(id,j=>{j.state='ACTIVE';return j});}
 async function startCLI(){
  const cli=fileURLToPath(new URL('../../dist/cli.js',import.meta.url));
  await mkdir(join(root,'stores'),{recursive:true});
  const result=spawnSync(process.execPath,[cli,'job','run','--id',id,'--task-id',coordinatorId,
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
   const task=(await load()).tasks.find(t=>t.dagNode?.parentTaskId===coordinatorId&&t.dagNode.nodeId===node);
   const key=task?.id;
   assert.equal(task?.state,'AWAITING_DECISION',key);
   const invocation=task.interactiveInvocation;
   await store.mutateJob(id,j=>{const current=j.tasks.find(t=>t.id===key);current.interactiveInvocation.status=status;
     current.interactiveInvocation.decidedAt=new Date().toISOString();current.interactiveInvocation.feedback='change the hook';
     current.interactiveInvocation.comments=[{text:'change the hook'}];return j});
   assert.equal(await resumeInteractiveTask(store,id,key,invocation.invocationId,invocation.revision,status),true);
   await reconciler.reconcile(id);
 }
 return {root,project,store,reconciler,id,coordinatorId,load,activate,startCLI,decide,trace:async()=>{try{return await readFile(join(root,'trace.log'),'utf8')}catch{return ''}},launches};
}
