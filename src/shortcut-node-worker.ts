import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createTaskEntity } from './workflow/entity-creation.js';
import type { DurableStore } from './store.js';
import type { Reconciler } from './reconciler.js';
import type { Job, Task } from './types.js';

/** A model node stays within its original Shortcut Job. Its durable child Task
 * uses the existing Relay Worker adapter, lifecycle Graph and Troubleshooter.
 * The parent Shortcut Graph, not the Worker Reconciler, selects DAG readiness. */
export async function runShortcutModelNode(options: {
  store: DurableStore; reconciler: Reconciler; jobId: string; parentTaskId: string;
  node: { id: string; agent: string; predecessorOutputs: Record<string,unknown>; executionId: string; signal: AbortSignal };
}): Promise<unknown> {
  const {store,reconciler,jobId,parentTaskId,node}=options;
  if(!store.mutateJob) throw new Error('Model nodes require the durable Relay SQLite store');
  if(!/^[A-Za-z_][\w.-]*$/.test(node.id)) throw new Error('Invalid shortcut model node ID');
  const taskId=`shortcut-${parentTaskId}-${node.id}`;
  const initial=await store.load(jobId);
  const parent=initial.tasks.find(t=>t.id===parentTaskId);
  if(!parent || parent.state!=='RUNNING' || parent.executionId!==node.executionId || !parent.leaseOwner)
    throw new Error('Model node parent execution is not leased by Shortcut Runner');
  if(parent.output?.kind!=='file' || !isAbsolute(parent.output.path)) throw new Error('Model nodes require a canonical absolute Task output directory');
  const outputPath=join(dirname(parent.output.path),'.shortcut-node-results',`${taskId}.json`);
  const started=initial.shortcutExecutionStartedAt && Date.parse(initial.shortcutExecutionStartedAt);
  if(!started||!Number.isFinite(started)) throw new Error('Model node has no immutable Shortcut deadline origin');
  const deadline=started+20*60_000;
  if(initial.shortcutExecutionDeadlineAt && Date.parse(initial.shortcutExecutionDeadlineAt)!==deadline)
    throw new Error('Model node deadline differs from the original execution budget');
  if(Date.now()>=deadline) throw new Error('Shortcut execution budget exceeded before model node dispatch');
  await mkdir(dirname(outputPath),{recursive:true,mode:0o700});
  await store.mutateJob(jobId,current=>{
    const active=current.tasks.find(t=>t.id===parentTaskId);
    if(current.state!=='ACTIVE' || current.executionMode!=='shortcut' || current.contentOnly!==true || current.pause ||
      !active || active.executionId!==node.executionId || active.state!=='RUNNING' || !active.leaseOwner)
      throw new Error('Shortcut model worker claim invalidated by Job lifecycle');
    const cp=active.result?.data?.shortcut;
    if(!cp || typeof cp!=='object') throw new Error('Shortcut model worker requires a persisted Graph checkpoint');
    const state=cp as {workerNodes?:Record<string,string>;nodes?:Record<string,unknown>;inFlight?:Record<string,string>};
    if(state.nodes?.[node.id] || state.inFlight?.[node.id]!==node.executionId) throw new Error('Model node is no longer pending in the current Graph execution');
    state.workerNodes ??={};
    if(state.workerNodes[node.id] && state.workerNodes[node.id]!==taskId) throw new Error('Conflicting durable Worker node mapping');
    state.workerNodes[node.id]=taskId;
    const existing=current.tasks.find(t=>t.id===taskId);
    if(existing){
      if(existing.parentTaskId!==parentTaskId || existing.agentName!==node.agent || existing.output?.kind!=='file' || existing.output.path!==outputPath)
        throw new Error('Durable Worker node identity mismatch');
    } else {
      const now=new Date().toISOString();
      const body=JSON.stringify({
        source:'shortcut-graph-node',jobId,parentTaskId,nodeId:node.id,agent:node.agent,
        predecessorOutputs:node.predecessorOutputs,
        originalInput:active.input,
        requiredResult:{status:'COMPLETED',output:{},artifacts:[]},
        outputPath,
        instruction:'Execute only this Agent role for this DAG node. Use only originalInput and the declared predecessorOutputs as source context. Write a JSON object matching {status:"COMPLETED",output:{...},artifacts:[]} to outputPath, then publish the correlated task.completed event. Do not publish, approve or invent outside permissions.'
      });
      current.tasks.push(createTaskEntity(current,{
        jobId,id:taskId,title:`Shortcut model node ${node.id}`,kind:'work',parentTaskId,
        agentName:node.agent,dependencies:[],capabilities:['model'],workerRequirements:{capabilities:['model']},
        adapter:'codex',input:body,output:{kind:'file',path:outputPath},
        attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
        result:null,error:null,timeoutMs:Math.max(1,deadline-Date.now()),createdAt:now,updatedAt:now,
      }));
    }
    return current;
  });
  while(true){
    if(node.signal.aborted) throw node.signal.reason ?? new Error('Shortcut Worker node interrupted');
    if(Date.now()>=deadline) throw new Error('Shortcut execution budget exceeded while waiting for model node');
    const current=await store.load(jobId);
    if(current.state!=='ACTIVE'||current.pause) throw new Error('Shortcut Job cancelled/paused while Worker node was pending');
    const task=current.tasks.find(t=>t.id===taskId);
    if(!task) throw new Error('Worker node disappeared from the durable Job');
    if(task.state==='SUCCEEDED'){
      const buffer=await readFile(outputPath);
      const value:unknown=JSON.parse(buffer.toString('utf8'));
      if(!value || typeof value!=='object'||Array.isArray(value))
        throw new Error('Worker Task reported success without contract-valid node output');
      const record=value as Record<string,unknown>;
      if(record.status!=='COMPLETED'||!record.output||typeof record.output!=='object'||Array.isArray(record.output))
        throw new Error('Worker Task reported success without contract-valid node output');
      // Some existing Worker roles report artifact records as {path,type}.
      // Convert ONLY exact file records to the Shortcut contract's path list;
      // the Graph executor still verifies realpath containment and SHA-256.
      if(Array.isArray(record.artifacts)) {
        const files=record.artifacts.map((item:unknown)=>{
          if(typeof item==='string'&&item.trim()) return item;
          if(item && typeof item==='object' && !Array.isArray(item)) {
            const ref=item as Record<string,unknown>;
            const fields=Object.keys(ref);
            if(fields.length===2 && fields.includes('path')
              && ((fields.includes('type') && ref.type==='file') || (fields.includes('kind') && ref.kind==='file'))
              && typeof ref.path==='string' && ref.path.trim()) return ref.path;
          }
          throw new Error('Worker node returned unsupported artifact entry; expected a file path, {type:"file",path} or {kind:"file",path}');
        });
        return {...record,artifacts:files};
      }
      if(!record.artifacts || typeof record.artifacts!=='object')
        throw new Error('Worker Task reported success without contract-valid artifact output');
      return record;
    }
    if(task.state==='CANCELLED') throw new Error('Worker node cancelled');
    if(task.state==='BLOCKED') throw new Error(`Worker node requires escalation: ${task.failureReason??task.error??task.id}`);
    await reconciler.reconcile(jobId);
    await new Promise<void>(resolve=>setTimeout(resolve,100));
  }
}
