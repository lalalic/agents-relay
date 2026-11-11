import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { dirname, isAbsolute } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import type { Task, EventRecord } from './types.js';
import type { Execution, WorkerAdapter, LaunchContext } from './adapters.js';
import { eventFor } from './events.js';
import { executionEventSource } from './execution-event-identity.js';
import { discoverShortcut } from './agent-shortcut.js';
import { spawnOwnedProcess } from './owned-process.js';

const valid=(value:unknown):value is {status:'COMPLETED';output:Record<string,unknown>;artifacts:unknown}=>{
 if(!value||typeof value!=='object'||Array.isArray(value))return false;
 const r=value as Record<string,unknown>;
 return r.status==='COMPLETED' && !!r.output && typeof r.output==='object' && !Array.isArray(r.output)
   && (!!r.artifacts&&typeof r.artifacts==='object');
};
async function runCommand(args:string[],cwd:string,signal:AbortSignal):Promise<{stdout:string;stderr:string;code:number}>{
 if(!args.length||args.some(a=>typeof a!=='string'||!a))throw Error('Script command requires an argv vector');
 const child=spawnOwnedProcess(args[0],args.slice(1),{invocation:'dag.script-command',signal,spawn:{cwd,stdio:['ignore','pipe','pipe']}});
 let stdout='',stderr='';child.stdout?.on('data',c=>{stdout+=String(c)});child.stderr?.on('data',c=>{stderr+=String(c)});
 const [code]=await once(child,'close') as [number|null,NodeJS.Signals|null];
 return {stdout,stderr,code:code??-1};
}
/** Script is just another Task Worker Adapter. It publishes exactly the same
 * execution-scoped Task lifecycle events as a Model Worker. */
export class ScriptTaskAdapter implements WorkerAdapter {
 readonly name='script' as const;
 readonly id='script';
 readonly capabilities=['script'] as const;
 constructor(private readonly onEvent:(event:EventRecord)=>Promise<unknown>,
   private readonly roots:{sharedRoot?:string|null;workspaceRoot?:string|null;globalRoot?:string|null}={}){}
 launch(task:Task,signal:AbortSignal,context:LaunchContext={}):Execution{
   const dag=task.dagNode;
   if((dag&&dag.executor!=='script')||!task.executionId||!task.jobId||!task.agentName)
     throw Error('Script Adapter requires a leased Agent Task');
   if(task.output?.kind!=='file'||!isAbsolute(task.output.path))throw Error('Script Task requires absolute file output');
   const outputPath=task.output.path;
   const executionId=task.executionId;
   const executionAbort=new AbortController();
   const forwardAbort=()=>executionAbort.abort(signal.reason ?? new Error('Script Task cancelled'));
   if(signal.aborted)forwardAbort();else signal.addEventListener('abort',forwardAbort,{once:true});
   const source={id:executionEventSource(task.jobId,task.id,executionId),agent:task.agentName,component:'agents-relay'};
   const send=async(type:string,status: 'running'|'succeeded'|'failed',message:string,data:Record<string,unknown>={})=>{
     await this.onEvent(eventFor(task.jobId!,task.id,task.parentTaskId,type,status,message,'orchestrator',data,source));
   };
   const promise=(async()=>{
     let stage:'running'|'waiting'|'completed'='running';
     try{
       let input: Record<string,unknown>;
       if(dag){
         input=JSON.parse(task.input) as Record<string,unknown>;
         if(input.source!=='relay-dag-task'||input.nodeId!==dag.nodeId||input.taskId&&input.taskId!==task.id)
           throw Error('Script Task is not bound to its declared DAG node');
       }else{
         let parsed:unknown;try{parsed=JSON.parse(task.input)}catch{}
         input=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed as Record<string,unknown>:{taskInput:task.input};
         input={...input,source:'relay-agent-task',taskId:task.id,outputPath};
       }
       const projectPath=context.executionContext?.project.path ?? input.projectPath;
       if(typeof projectPath!=='string'||!isAbsolute(projectPath))throw Error('No trusted Script Project context');
       const script=await discoverShortcut(task.agentName!,projectPath,this.roots.sharedRoot??undefined,this.roots.workspaceRoot??undefined,this.roots.globalRoot??undefined);
       if(!script)throw Error(`Declared Agent Shortcut is unavailable: ${task.agentName}`);
       await send('task.started','running','Script Worker started');
       const module=await import(pathToFileURL(script).href) as {run(ctx:{input:Record<string,unknown>;signal:AbortSignal;runCommand:(args:string[],cwd:string)=>Promise<{stdout:string;stderr:string;code:number}>}):Promise<unknown>};
       if(typeof module.run!=='function')throw Error('Agent Shortcut must export run(context)');
       const invocation=task.interactiveInvocation;
       const review=invocation?.decidedAt && ['approved','changes_requested'].includes(invocation.status)
         ? {status:invocation.status,revision:invocation.revision,invocationId:invocation.invocationId,feedback:invocation.feedback,comments:invocation.comments}:undefined;
       if(executionAbort.signal.aborted)throw executionAbort.signal.reason;
       const result=await Promise.race([module.run({input:{...input,jobId:task.jobId,taskId:task.id,executionId,
         ...(review?{reviewDecision:review}:{})},signal,
         runCommand:(args,cwd)=>runCommand(args,cwd,executionAbort.signal)}),new Promise<never>((_resolve,reject)=>{
           if(executionAbort.signal.aborted)reject(executionAbort.signal.reason);
           else executionAbort.signal.addEventListener('abort',()=>reject(executionAbort.signal.reason),{once:true});
         })]);
       if(result&&typeof result==='object'&&(result as {status?:string}).status==='WAITING_REVIEW'){
         stage='waiting';return {summary:'Script Task waiting for authorized human review'};
       }
       if(!valid(result))throw Error('Script Worker did not return a completed artifact contract');
       await mkdir(dirname(outputPath),{recursive:true,mode:0o700});
       await writeFile(outputPath,JSON.stringify(result,null,2)+'\n');
       await send('task.completed','succeeded','Script Worker completed',{status:'COMPLETED',output:result.output,artifacts:result.artifacts});
       stage='completed';return {summary:'Script Task completed'};
     }catch(error){
       if(!executionAbort.signal.aborted && stage==='running')await send('task.failed','failed',error instanceof Error?error.message:String(error),{reason:'script_execution_failed'});
       throw error;
     }
   })().finally(()=>signal.removeEventListener('abort',forwardAbort));
   return {id:randomUUID(),promise,cancel:()=>executionAbort.abort(new Error('Script Task cancelled'))};
 }
}
