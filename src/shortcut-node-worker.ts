import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createTaskEntity } from './workflow/entity-creation.js';
import type { DurableStore } from './store.js';
import type { Reconciler } from './reconciler.js';
import type { Job, Task } from './types.js';
import { taskOverallTimeoutMs } from './types.js';

/** A model node stays within its original Shortcut Job. Its durable child Task
 * uses the existing Relay Worker adapter, lifecycle Graph and Troubleshooter.
 * The parent Shortcut Graph, not the Worker Reconciler, selects DAG readiness. */
export async function runShortcutModelNode(options: {
  store: DurableStore; reconciler: Reconciler; jobId: string; parentTaskId: string;
  node: { id: string; agent: string; predecessorOutputs: Record<string,unknown>; executionId: string; signal: AbortSignal; reviewDecision?: {status:'changes_requested';revision:string;invocationId:string;feedback?:string;comments?:readonly unknown[]} };
}): Promise<unknown> {
  const {store,reconciler,jobId,parentTaskId,node}=options;
  if(!store.mutateJob) throw new Error('Model nodes require the durable Relay SQLite store');
  if(!/^[A-Za-z_][\w.-]*$/.test(node.id)) throw new Error('Invalid shortcut model node ID');
  const review=node.reviewDecision;
  if(review && (review.revision!==review.invocationId))
    throw new Error('Invalid semantic Revision identity');
  const taskId=`shortcut-${parentTaskId}-${node.id}${review?'-revision-'+review.invocationId:''}`;
  const initial=await store.load(jobId);
  const parent=initial.tasks.find(t=>t.id===parentTaskId);
  if(!parent || parent.state!=='RUNNING' || parent.executionId!==node.executionId || !parent.leaseOwner)
    throw new Error('Model node parent execution is not leased by Shortcut Runner');
  if(parent.output?.kind!=='file' || !isAbsolute(parent.output.path)) throw new Error('Model nodes require a canonical absolute Task output directory');
  if(review){
    const recorded=parent.interactiveInvocation;
    if(!recorded?.decidedAt||recorded.status!=='changes_requested'||
       recorded.invocationId!==review.invocationId||recorded.revision!==review.revision)
      throw new Error('Revision Worker requires the actual accepted Relay review');
  }
  const runRoot=dirname(parent.output.path);
  const declaredRun=parent.input.match(/^- Canonical run:\s*(\/[^\r\n]+)$/m)?.[1]?.trim();
  if(declaredRun && resolve(declaredRun)!==resolve(runRoot))
    throw new Error('Shortcut Worker declared canonical run does not match the bound parent Task output directory');
  const sourceRef=parent.input.match(/^- Private input evidence:\s*(\/[^\r\n]+)$/m)?.[1]?.trim();
  if(sourceRef && (!declaredRun || dirname(resolve(sourceRef))!==resolve(runRoot)))
    throw new Error('Shortcut Worker source evidence is not confined to the declared canonical run');
  const outputPath=join(runRoot,'.shortcut-node-results',`${taskId}.json`);
  // No wall-clock cutoff. Child Workers use their standard progress-renewed
  // inactivity watchdog; the foreground Shortcut parent keeps its lease live.
  const started=initial.shortcutExecutionStartedAt && Date.parse(initial.shortcutExecutionStartedAt);
  if(!started||!Number.isFinite(started)) throw new Error('Model node has no Shortcut start record');
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
    const workerKey=review ? `${node.id}:revision:${review.invocationId}` : node.id;
    if(state.workerNodes[workerKey] && state.workerNodes[workerKey]!==taskId) throw new Error('Conflicting durable Worker node mapping');
    state.workerNodes[workerKey]=taskId;
    const existing=current.tasks.find(t=>t.id===taskId);
    if(existing){
      if(existing.parentTaskId!==parentTaskId || existing.agentName!==node.agent || existing.output?.kind!=='file' || existing.output.path!==outputPath)
        throw new Error('Durable Worker node identity mismatch');
    } else {
      const now=new Date().toISOString();
      const body=JSON.stringify({
        source:'shortcut-graph-node',jobId,parentTaskId,nodeId:node.id,agent:node.agent,
        predecessorOutputs:node.predecessorOutputs,
        ...(review ? {reviewDecision:review,revisionOf:{nodeId:node.id,commitSha:review.revision}} : {}),
        originalInput:active.input,
        ...(declaredRun ? {canonicalRunPath:declaredRun} : {}),
        ...(sourceRef ? {sourceEvidencePath:sourceRef} : {}),
        requiredResult:{status:'COMPLETED',output:{},artifacts:[]},
        outputPath,
        instruction:review ? 'Revise only the existing Stage Artifact according to the human feedback within the Agent role, preserving source provenance; never invent evidence, approve, or publish. The parent Shortcut re-verifies and re-previews.' : 'Execute only this Agent role for this DAG node. The ONLY structured DAG predecessor values are predecessorOutputs; never infer an undeclared sibling dependency. If canonicalRunPath is declared, read the authorized original source manifest and prior stage artifact files there as required by the project Agent/Stage contract; inspect and validate their real contents, source provenance, hashes and use rights. These files are allowed canonical run evidence, not an alternative DAG predecessor result and not proof of human approval. Do not claim they are absent merely because they are not repeated in predecessorOutputs. Write {status:"COMPLETED",output:{...},artifacts:[]} to outputPath only after meeting stage acceptance and send a correlated task.completed event. If a real prerequisite is unavailable, report the specific verified blocker and task.failed; do not fabricate, publish, approve or infer new permissions.'
      });
      current.tasks.push(createTaskEntity(current,{
        jobId,id:taskId,title:`Shortcut model node ${node.id}`,kind:'work',parentTaskId,
        agentName:node.agent,dependencies:[],capabilities:['model'],workerRequirements:{capabilities:['model']},
        adapter:'codex',input:body,output:{kind:'file',path:outputPath},
        attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,
        result:null,error:null,timeoutMs:taskOverallTimeoutMs('L'),createdAt:now,updatedAt:now,
      }));
    }
    return current;
  });
  while(true){
    if(node.signal.aborted) throw node.signal.reason ?? new Error('Shortcut Worker node interrupted');
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
      // Some Workers report {path,kind:"human-readable description"}.
      // Only the checked on-disk path is an artifact identity; `kind` is not
      // a declared filesystem type or authorization claim.
      // Convert ONLY exact file records to the Shortcut contract's path list;
      // the Graph executor still verifies realpath containment and SHA-256.
      if(Array.isArray(record.artifacts)) {
        const files=record.artifacts.map((item:unknown)=>{
          if(typeof item==='string'&&item.trim()) return item;
          if(item && typeof item==='object' && !Array.isArray(item)) {
            const ref=item as Record<string,unknown>;
            const fields=Object.keys(ref);
            // A Worker may naturally produce a path-only file record. Accept
            // EXACTLY {path} (no unrecognized metadata), then let the Graph
            // executor verify realpath confinement and SHA-256 as usual.
            if(fields.length===1 && fields[0]==='path'
              && typeof ref.path==='string' && ref.path.trim()) return ref.path;
            if(fields.length===2 && fields.includes('path')
              && ((fields.includes('type') && ref.type==='file') ||
                  (fields.includes('kind') && typeof ref.kind==='string' && ref.kind.trim()))
              && typeof ref.path==='string' && ref.path.trim()) return ref.path;
          }
          throw new Error('Worker node returned unsupported artifact entry; expected a file path, {path}, {type:"file",path} or {kind:"description",path}');
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
