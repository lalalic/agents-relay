import {once} from 'node:events';
import {fileURLToPath} from 'node:url';
import {spawnOwnedProcess} from './owned-process.js';
import type {Job,Task} from './types.js';

/** The shared Scheduler launches only the trusted current Relay CLI. Paths are
 * bound during the first explicit Shortcut run, never parsed from Task text. */
export async function resumeShortcutInOwnedProcess(job: Job,task: Task):Promise<void>{
 const ctx=job.shortcutRunnerContext;
 if(!ctx?.projectPath||!ctx.workspaceRoot)throw Error('Unbound Shortcut launch context');
 const args=[fileURLToPath(new URL('./cli.js',import.meta.url)),
   'job','run','--mode','shortcut','--repo',job.repository,'--id',job.id,'--task-id',task.id,
   '--project-path',ctx.projectPath,'--workspace-root',ctx.workspaceRoot,
   ...(ctx.sharedRoot?['--shared-root',ctx.sharedRoot]:[]),
   ...(ctx.globalRoot?['--global-root',ctx.globalRoot]:[]),
   ...(ctx.noGitHub?['--no-github','--shortcut-local']:[])];
 const child=spawnOwnedProcess(process.execPath,args,{invocation:'shortcut.auto-resume',
  correlation:{jobId:job.id,repository:job.repository,taskId:task.id},
  spawn:{cwd:ctx.projectPath,stdio:['ignore','pipe','pipe'],env:process.env}});
 const errors:string[]=[];
 child.stderr?.on('data',chunk=>{const text=String(chunk);if(errors.join('').length<4000)errors.push(text.slice(0,500));});
 child.stdout?.resume();
 const [code,signal]=await once(child,'close') as [number|null,NodeJS.Signals|null];
 // Exit 3 is a persisted WAITING_REVIEW/WAITING_EVENT, not worker failure.
 if(signal||(code!==0&&code!==3))throw Error(`Shortcut runner stopped (${signal??code}): ${errors.join('').slice(-1500)}`);
}
