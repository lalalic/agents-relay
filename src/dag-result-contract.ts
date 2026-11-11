import {readFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {once} from 'node:events';
import {spawnOwnedProcess} from './owned-process.js';
import {validateShortcutStageGate} from './shortcut-stage-contract.js';
import type {Task} from './types.js';

/** Validate an Agent DAG Task's required on-disk result before accepting
 * task.completed. Invalid output is an ordinary Task failure and enters the
 * existing Troubleshooter path; it must not strand a running Coordinator. */
export async function dagCompletionError(task:Task,projectPath?:string):Promise<string|null>{
 if(!task.dagNode)return null;
 if(task.output?.kind!=='file')return 'DAG Agent Task has no file result target';
 let parsed:unknown;
 try{parsed=JSON.parse(await readFile(task.output.path,'utf8'));}
 catch(error){return `DAG Agent result unreadable: ${error instanceof Error?error.message:String(error)}`;}
 if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))return 'DAG Agent result is not an object';
 const record=parsed as Record<string,unknown>;
 if(record.status!=='COMPLETED'||!record.output||typeof record.output!=='object'||Array.isArray(record.output))
   return 'DAG Agent result must contain status COMPLETED and an output object';
 if(!record.artifacts||typeof record.artifacts!=='object'||Array.isArray(record.artifacts)&&
     !(record.artifacts as unknown[]).every(item=>typeof item==='string'))
   return 'DAG Agent result must contain a list or object of artifacts';
 if(projectPath && task.agentName){
   try{
     await validateShortcutStageGate({projectPath,agent:task.agentName,runPath:dirname(dirname(task.output.path)),
       execute:async(args,cwd)=>{
         const abort=AbortSignal.timeout(300_000);
         const child=spawnOwnedProcess(args[0],args.slice(1),{invocation:'dag.stage-validation',signal:abort,
           spawn:{cwd,stdio:['ignore','pipe','pipe']}});
         let stdout='',stderr='';
         child.stdout?.on('data',chunk=>{stdout+=String(chunk)});
         child.stderr?.on('data',chunk=>{stderr+=String(chunk)});
         const [code]=await once(child,'close') as [number|null,NodeJS.Signals|null];
         return {stdout,stderr,code:code??-1};
       }});
   }catch(error){return `DAG Stage contract rejected Task completion: ${error instanceof Error?error.message:String(error)}`;}
 }
 return null;
}
