import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {spawnOwnedProcess} from './owned-process.js';
import {errorMessage, observability} from './observability.js';
import type {Job,Task} from './types.js';

/** The interactive decision has already been applied by the canonical Relay
 * handler. Invoke the *same* CLI a human would run, once per in-flight Job.
 * No Shortcut scheduler, queue, or normal-Job Worker Pool dispatch required.
 */
export function eligibleShortcutReviewTask(job:Job, taskId:string):Task|null{
 if(job.executionMode!=='shortcut'||job.contentOnly!==true||job.state!=='ACTIVE'||job.pause||
    !job.shortcutExecutionStartedAt||!job.shortcutRunnerContext?.projectPath||
    !job.shortcutRunnerContext.workspaceRoot)return null;
 const task=job.tasks.find(t=>t.id===taskId);
 if(!task?.agentGraph||task.state!=='QUEUED'||task.executionId!==null||task.leaseOwner!==null)return null;
 const rev=task.interactiveInvocation;
 const cp=task.result?.data?.shortcut as {inFlight?:Record<string,string>}|undefined;
 const pending=Object.values(cp?.inFlight??{});
 if(pending.length!==1||!rev?.decidedAt||!['approved','changes_requested'].includes(rev.status)||
    rev.revision!==rev.executionId||rev.executionId!==pending[0])return null;
 return task;
}

export async function launchShortcutReviewCLI(job:Job,task:Task):Promise<void>{
 const ctx=job.shortcutRunnerContext;
 if(!ctx)throw Error('Missing trusted original Shortcut launch context');
 const args=[fileURLToPath(new URL('./cli.js',import.meta.url)),
   'job','run','--mode','shortcut','--repo',job.repository,'--id',job.id,'--task-id',task.id,
   '--project-path',ctx.projectPath,'--workspace-root',ctx.workspaceRoot,
   ...(ctx.sharedRoot?['--shared-root',ctx.sharedRoot]:[]),
   ...(ctx.globalRoot?['--global-root',ctx.globalRoot]:[]),
   ...(ctx.noGitHub?['--no-github']:[])];
 const child=spawnOwnedProcess(process.execPath,args,{invocation:'shortcut.review-resume',
   correlation:{jobId:job.id,repository:job.repository,taskId:task.id},
   spawn:{cwd:ctx.projectPath,stdio:['ignore','pipe','pipe'],env:process.env}});
 const stderr:string[]=[];
 child.stderr?.on('data',chunk=>{if(stderr.join('').length<4000)stderr.push(String(chunk).slice(0,500));});
 child.stdout?.resume();
 const [code,signal]=await once(child,'close') as [number|null,NodeJS.Signals|null];
 if(signal||(code!==0&&code!==3))throw Error(`Shortcut CLI exited (${signal??code}): ${stderr.join('').slice(-1500)}`);
}

export function createShortcutReviewWake(
  loadJob:(jobId:string)=>Promise<Job|null>,
  run:(job:Job,task:Task)=>Promise<void>=launchShortcutReviewCLI,
):(jobId:string,taskId:string)=>Promise<boolean>{
 const running=new Set<string>();
 return async(jobId,taskId)=>{
   const job=await loadJob(jobId);
   if(!job||job.executionMode!=='shortcut')return false;
   const task=eligibleShortcutReviewTask(job,taskId);
   if(!task||running.has(jobId))return true;
   running.add(jobId);
   // Return immediately to the event consumer: the CLI may wait on an Agent.
   void run(job,task).catch(error=>{
     observability().record({stage:'reconcile',event:'shortcut.review_resume_failed',level:'error',outcome:'failed',
       message:'Shortcut review CLI failed: '+errorMessage(error),
       correlation:{jobId,repository:job.repository,taskId}});
   }).finally(()=>running.delete(jobId));
   return true;
 };
}
