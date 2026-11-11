import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import type { DurableStore } from './store.js';
import type { Job, Task } from './types.js';
import { taskOverallTimeoutMs } from './types.js';
import { parseAgentGraph } from './agent-graph.js';
import { discoverShortcut } from './agent-shortcut.js';
import { createTaskEntity } from './workflow/entity-creation.js';
import { tryTransitionTaskEvent } from './task-transitions.js';
import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';

export type DAGChild = { parentTaskId: string; nodeId: string; graphHash: string; executor: 'script'|'model' };
export type DAGCheckpoint = { version:1; graphHash:string };
export function dagChildId(parentTaskId:string,nodeId:string):string {return `dag-${parentTaskId}-${nodeId}`;}
export function unifiedDAG(job:Job,task:Task):boolean {
  if(!task.agentGraph)return false;
  if(job.executionMode!=='shortcut')return true;
  return (task.result?.data?.dag as DAGCheckpoint|undefined)?.version===1;
}
export function dagCoordinator(task:Task):boolean {return Boolean(task.agentGraph && (task.result?.data?.dag as DAGCheckpoint|undefined)?.version===1);}
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const out=(task:Task):string =>{
  if(task.output?.kind!=='file'||!isAbsolute(task.output.path))throw Error('Graph Task requires a canonical absolute file output');
  return dirname(task.output.path);
};
async function graphNodeOutput(task:Task):Promise<Record<string,unknown>|null> {
  if(task.state!=='SUCCEEDED')return null;
  const data=task.result?.data;
  if(data?.status==='COMPLETED' && data.output && typeof data.output==='object' && !Array.isArray(data.output))return data.output as Record<string,unknown>;
  if(task.output?.kind==='file'){
    let value:unknown;try{value=JSON.parse(await readFile(task.output.path,'utf8'))}catch{return null}
    const record=value as {status?:string;output?:unknown}|null;
    if(record?.status==='COMPLETED'&&record.output&&typeof record.output==='object'&&!Array.isArray(record.output))return record.output as Record<string,unknown>;
  }
  return null;
}

/** One durable Task is one DAG node. No independent node lease, retry, review or recovery.
 * This is a reconciliation projection, not an execution scheduler: the normal
 * Task graph owns dispatch and dependencies for every materialized child. */
export async function reconcileDAGTasks(options:{store:DurableStore;jobId:string;
  projectPathForTask:(job:Job,task:Task)=>Promise<string>;
  roots?:{sharedRoot?:string|null;workspaceRoot?:string|null;globalRoot?:string|null};
}):Promise<void>{
 const {store,jobId}=options;
 if(!store.mutateJob)throw Error('DAG Tasks require an atomic SQLite store');
 const snapshot=await store.load(jobId);
 for(const parent of snapshot.tasks.filter(t=>unifiedDAG(snapshot,t))){
   if(parent.state==='SUCCEEDED'||parent.state==='CANCELLED'||parent.state==='FAILED'||parent.state==='BLOCKED')continue;
   const graph=parseAgentGraph(parent.agentGraph!);
   const graphHash=sha(parent.agentGraph!);
   const projectPath=await options.projectPathForTask(snapshot,parent);
   const root=parent.output?.kind==='file' && isAbsolute(parent.output.path) ? out(parent) : join(projectPath,'.relay-dag-results',jobId,parent.id);
   if(parent.state==='QUEUED'){
     await store.mutateJob(jobId,job=>{
       const current=job.tasks.find(t=>t.id===parent.id);
       if(job.state!=='ACTIVE'||job.pause||!current||current.state!=='QUEUED'||!unifiedDAG(job,current))return job;
       const step=tryTransitionTaskEvent(current,'task.started');
       if(!step.accepted||step.target!=='RUNNING')throw Error('Task lifecycle rejected DAG coordinator start');
       current.title='Coordinator';
       current.result={summary:'DAG coordinator',data:{dag:{version:1,graphHash}}};
       current.updatedAt=new Date().toISOString();return job;
     });
   }
   const currentJob=await store.load(jobId);
   const currentParent=currentJob.tasks.find(t=>t.id===parent.id)!;
   if(currentParent.state!=='RUNNING'||!dagCoordinator(currentParent))continue;
   if((currentParent.result?.data?.dag as DAGCheckpoint).graphHash!==graphHash)throw Error('DAG changed after execution began');
   for(const wave of graph.waves){
     for(const nodeId of wave){
       const childId=dagChildId(parent.id,nodeId);
       if(currentJob.tasks.some(t=>t.id===childId))continue;
       const parents=graph.edges.filter(e=>e.to===nodeId).map(e=>e.from);
       const incoming=parents.map(id=>currentJob.tasks.find(t=>t.id===dagChildId(parent.id,id)));
       if(incoming.some(t=>!t||t.state!=='SUCCEEDED'))continue;
       const predecessorOutputs:Record<string,unknown>={};
       for(let i=0;i<parents.length;i++){
         const value=await graphNodeOutput(incoming[i]!);
         if(!value)throw Error(`Completed DAG dependency ${parents[i]} has no structured result`);
         predecessorOutputs[parents[i]]=value;
       }
       const node=graph.nodes.find(n=>n.id===nodeId)!;
       const script=await discoverShortcut(node.agent,projectPath,options.roots?.sharedRoot??undefined,options.roots?.workspaceRoot??undefined,options.roots?.globalRoot??undefined);
       const childOut=join(root,'.dag-node-results',childId+'.json');
       let supplied:Record<string,unknown>={taskInput:parent.input};
       try {const parsed:unknown=JSON.parse(parent.input);if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)) supplied=parsed as Record<string,unknown>;}
       catch {/* Plain Task Markdown remains taskInput. */}
       const {reviewDecision:_ignored,interactiveInvocation:_ignored2,jobId:_job,taskId:_task,projectPath:_project, ...projectInput}=supplied;
       const input=JSON.stringify({...projectInput,source:'relay-dag-task',jobId,parentTaskId:parent.id,nodeId,taskId:childId,
         agent:node.agent,projectPath,predecessorOutputs,taskInput:parent.input,outputPath:childOut,
         requiredResult:{status:'COMPLETED',output:{},artifacts:[]},
         instruction:'Execute this Agent DAG role using only declared predecessorOutputs and authorized project inputs. Write the structured result to outputPath. Do not invent source evidence, review decisions or publishing authorization.'});
       await mkdir(dirname(childOut),{recursive:true,mode:0o700});
       await store.mutateJob(jobId,job=>{
         const current=job.tasks.find(t=>t.id===parent.id);
         if(job.state!=='ACTIVE'||job.pause||current?.state!=='RUNNING'||!dagCoordinator(current)||job.tasks.some(t=>t.id===childId))return job;
         if(!parents.every(id=>job.tasks.some(t=>t.id===dagChildId(parent.id,id)&&t.state==='SUCCEEDED')))return job;
         const now=new Date().toISOString();
         const dagNode:DAGChild={parentTaskId:parent.id,nodeId,graphHash,executor:script?'script':'model'};
         job.tasks.push(createTaskEntity(job,{jobId,id:childId,parentTaskId:parent.id,
           dagNode,title:node.agent,kind:'work',agentName:node.agent,
           dependencies:parents.map(id=>dagChildId(parent.id,id)),capabilities:script?['script']:['model'],
           adapter:script?'script':'codex',workerRequirements:script?undefined:{capabilities:['model']},
           input,output:{kind:'file',path:childOut},attempt:0,maxAttempts:3,
           leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,
           timeoutMs:taskOverallTimeoutMs('L'),createdAt:now,updatedAt:now}));
         return job;
       });
     }
   }
   const latest=await store.load(jobId);
   const done=graph.nodes.map(n=>latest.tasks.find(t=>t.id===dagChildId(parent.id,n.id)));
   if(done.length && done.every(t=>t?.state==='SUCCEEDED')){
     await store.mutateJob(jobId,job=>{
       const current=job.tasks.find(t=>t.id===parent.id);
       if(!current||current.state!=='RUNNING'||!dagCoordinator(current))return job;
       if(!graph.nodes.every(n=>job.tasks.some(t=>t.id===dagChildId(parent.id,n.id)&&t.state==='SUCCEEDED')))return job;
       const changed=tryTransitionTaskEvent(current,'task.completed');
       if(!changed.accepted||changed.target!=='SUCCEEDED')throw Error('Task Lifecycle rejected DAG completion');
       current.result={summary:'DAG completed',data:{dag:{version:1,graphHash},
         nodes:Object.fromEntries(graph.nodes.map(n=>[n.id,dagChildId(parent.id,n.id)]))}};
       current.updatedAt=new Date().toISOString();return job;
     });
   }
 }
 await completeContentJobIfEligible(store,jobId);

}

/** Human Request Changes on a scripted Agent goes to its model Worker within
 * the SAME durable Task. Approval goes back to the Script for stage validation.
 * This is routing, not a second revision Task or recovery state machine. */
export async function selectDAGReviewExecutors(store:DurableStore,jobId:string):Promise<void>{
 if(!store.mutateJob)return;
 await store.mutateJob(jobId,job=>{
  if(job.state!=='ACTIVE'||job.pause)return job;
  for(const task of job.tasks){
   if(task.dagNode?.executor!=='script'||task.state!=='QUEUED'||task.executionId!==null)continue;
   const status=task.interactiveInvocation?.status;
   const desired=status==='changes_requested'?'codex':'script';
   if(task.adapter===desired)continue;
   task.adapter=desired;
   task.capabilities=desired==='codex'?['model']:['script'];
   task.workerRequirements=desired==='codex'?{capabilities:['model']}:undefined;
   task.routing=undefined;
   task.workerSelection=undefined;
   if(status==='changes_requested'){
     const input=JSON.parse(task.input) as Record<string,unknown>;
     input.reviewRevision={status,feedback:task.interactiveInvocation?.feedback??'',
       comments:task.interactiveInvocation?.comments??[],
       instruction:'Revise the current Stage Artifact from the human feedback. Verify it, then use agents-relay review interactive --path to submit a NEW review for this same Task Execution. Do not publish or emit task.completed until the new review is approved.'};
     task.input=JSON.stringify(input);
   }
   task.updatedAt=new Date().toISOString();
  }
  return job;
 });
}

/** Run the DAG projection at the ordinary Reconciler scheduling boundary. */
export async function reconcileDAGSchedule(options:{store:DurableStore;jobId:string;job:Job;
  projectPathForTask:(job:Job,task:Task)=>Promise<string>;
  roots?:{sharedRoot?:string|null;workspaceRoot?:string|null;globalRoot?:string|null};
}):Promise<Job>{
 if(!options.job.tasks.some(t=>unifiedDAG(options.job,t))){
   await completeContentJobIfEligible(options.store,options.jobId);return options.store.load(options.jobId);
 }
 await reconcileDAGTasks(options);
 await selectDAGReviewExecutors(options.store,options.jobId);
 return options.store.load(options.jobId);
}

/** Content completion is independent of the Job activation source. Its legal
 * ACTIVE -> COMPLETED transition belongs to the canonical Job graph. */
export async function completeContentJobIfEligible(store:DurableStore,jobId:string):Promise<void>{
 if(!store.mutateJob)return;
 const eligible=(job:Job):boolean=>job.state==='ACTIVE' && job.contentOnly===true && job.prNumber===0 &&
   !job.localMerge && job.autoMerge===false && job.reviewEnabled===false && !job.review && !(job.plans?.length) &&
   job.tasks.length>0 && job.tasks.every(t=>t.state==='SUCCEEDED');
 const snapshot=await store.load(jobId);
 if(!eligible(snapshot))return;
 await store.mutateJob(jobId,job=>{
  if(!eligible(job))return job;
  const decision=dispatchJobLifecycleSync(job,'content.completed',{contentCompletionAllowed:true});
  if(!decision.accepted||decision.target!=='COMPLETED')throw Error('Content Job completion rejected by canonical Job lifecycle');
  return job;
 });
}
