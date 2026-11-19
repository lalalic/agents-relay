import { parseAgentGraph } from './agent-graph.js';
import { tryTransitionTaskEvent } from './task-transitions.js';
import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import { noGitHubMode } from './no-github.js';
import { resolveJobProjectRoot,resolveWorkspaceRoot } from './workspace.js';
import { arg,hasArg,publishWake,storeFor,textOption,withEventBus } from './cli-support.js';
import type { DurableStore } from './store.js';

/** Starts an ordinary DRAFT Job. DAG execution, review and recovery are
 * owned by the same Reconciler and global capacity pool as every other Job. */
export async function runCoordinatorJobCommand(args:string[],id:string, foreground?: (store:DurableStore,jobId:string,taskId:string)=>Promise<void>):Promise<void>{
 if(hasArg(args,'--shortcut-local')||hasArg(args,'--legacy-shortcut-runtime')||hasArg(args,'--event-json')||hasArg(args,'--mode'))
   throw Error('Legacy Shortcut runners and execution modes are removed');
 if(hasArg(args,'--foreground')&&!foreground)throw Error('Foreground runner not configured');
 const loaded=await storeFor(args,false,true);
 if(loaded.localFile!==null||!loaded.store.mutateJob)throw Error('Job start requires authoritative SQLite');
 const job=loaded.job,taskId=arg(args,'--task-id');
 if(!taskId)throw Error('job run requires --task-id');
 const task=job.tasks.find(t=>t.id===taskId);
 if(!task)throw Error(`Task ${taskId} not found`);
 const override=hasArg(args,'--agent-graph-file')?await textOption(args,'--agent-graph','--agent-graph-file'):undefined;
 if(override)parseAgentGraph(override);
 const graph=task.agentGraph??override;
 if(!graph)throw Error('job run requires a durable Agent Graph Task');
 parseAgentGraph(graph);
 const workspaceRoot=await resolveWorkspaceRoot(arg(args,'--workspace-root')||undefined);
 const projectRoot=await resolveJobProjectRoot(job);
 if(hasArg(args,'--project-path')) throw Error('Job --project-path is removed; use the independent Git repository root');
 if(hasArg(args,'--foreground')&&['COMPLETED','CANCELLED'].includes(job.state)){
   await foreground!(loaded.store,id,taskId);
   return;
 }
 const globalRoot=arg(args,'--global-root')||process.env.AGENTS_HOME||undefined;
 await loaded.store.mutateJob(id,current=>{
   const root=current.tasks.find(t=>t.id===taskId);
   if(!root)throw Error('Coordinator Task disappeared');
   if(root.agentGraph&&root.agentGraph!==graph)throw Error('Coordinator Graph changed after creation');
   if(!['DRAFT','QUEUED','RUNNING'].includes(root.state) && !(hasArg(args,'--foreground')&&current.state==='ACTIVE'&&root.agentGraph))
     throw Error('Coordinator Task is not startable');
   if(!root.agentGraph){if(root.state!=='DRAFT'&&root.state!=='QUEUED')throw Error('Graph cannot change after execution started');root.agentGraph=graph;}
   if(root.state==='DRAFT'){
     if(root.dependencies.length)throw Error('Coordinator has unmet dependencies');
     const transition=tryTransitionTaskEvent(root,'queue',{dependenciesSatisfied:true});
     if(!transition.accepted||transition.target!=='QUEUED')throw Error('Coordinator Task queue denied');
   }
   const ctx={projectRoot,workspaceRoot,...(globalRoot?{globalRoot}:{}),noGitHub:noGitHubMode(args)};
   const existing=current.graphStartContext;
   if(existing&&(['projectRoot','workspaceRoot','globalRoot','noGitHub'] as const).some(k=>existing[k]!==ctx[k]))
     throw Error('Coordinator start context differs from original binding');
   if(!existing)current.graphStartContext=ctx;
   if(current.state==='DRAFT'){
     const activation=dispatchJobLifecycleSync(current,'activate');
     if(!activation.accepted||activation.target!=='ACTIVE')throw Error('Job Lifecycle rejected activation');
   }else if(current.state!=='ACTIVE')throw Error('Job is not runnable: '+current.state);
   return current;
 });
 const scheduled=await loaded.store.load(id);
 if(hasArg(args,'--foreground')){
   // Foreground runs the ordinary Reconciler directly: no scheduler wake or second DAG engine.
   await foreground!(loaded.store,id,taskId);
   return;
 }
 await withEventBus(args,bus=>publishWake(bus,scheduled,taskId,'Coordinator Job activated'));
 console.log(JSON.stringify({jobId:id,taskId,scheduled:true,state:scheduled.state,graphRuntime:'tasks'},null,2));
}
