import { writeFile } from 'node:fs/promises';
import { plannerInput } from './planner.js';
import { arg, storeFor } from './cli-support.js';
import { resolveExecutionContext } from './execution-context.js';
import { buildPlannerExecutionPrompt, type PlannerContext } from './planner.js';
import { managedWorkerInput } from './managed-worker-input.js';
import { resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { taskExecutionContext } from './task-context.js';
import { eventsBusHistoryPage } from './events-bus-runtime.js';
import type { PromptAdapter } from './agent-prompt-builder.js';

/** Print the actual prompt emitted by the same production Builder entry point.
 * This is read-only: it does not start an adapter, create a Plan or mutate a Task.
 */
export async function runPromptCommand(args: string[]): Promise<void> {
  const adapter = arg(args, '--adapter', 'codex') as PromptAdapter;
  if (!['codex', 'chatgpt', 'z'].includes(adapter)) throw new Error('prompt --adapter must be codex|chatgpt|z');
  const planId = arg(args, '--plan-id'), taskId = arg(args, '--task-id');
  if (!!planId === !!taskId) throw new Error('prompt requires exactly one of --plan-id or --task-id');
  const {job} = await storeFor(args,true);
  const projectPath = arg(args, '--project-path') || resolveRepositoryProjectPath(await resolveManagedProjectPath(job.repository), job.projectPath);
  let prompt: string;
  if (planId) {
    const plan = job.plans?.find(item => item.id === planId);
    if (!plan) throw new Error(`Plan ${planId} not found in Job ${job.id}`);
    const executionId = plan.executionId || plan.appliedExecutionId;
    if (!executionId) throw new Error(`Plan ${planId} has no recorded execution identity`);
    // An immutable historical Planner input is not persisted. Exclude tasks
    // and plans written AFTER the selected planning round to avoid injecting
    // future results as though the Planner had already observed them.
    const boundary = plan.createdAt;
    const historicalTasks = job.tasks.filter(task => task.createdAt < boundary);
    const historicalPlans = (job.plans ?? []).filter(item => item.round <= plan.round).map(item =>
      item.id === plan.id ? {...item, status:'PLANNING' as const, executionId, appliedExecutionId:undefined,generatedTaskIds:[]} : item);
    const historicalJob = {...job, tasks:historicalTasks, plans:historicalPlans};
    const context = await resolveExecutionContext(projectPath, 'planner');
    const planner: PlannerContext = {
      job: historicalJob, tasks: historicalTasks,
      objective: job.objective ?? job.description ?? job.title,
      previousPlannerTaskId: plan.previousPlanId,
      planExecution: { planId, executionId },
      trigger: plan.trigger, guidance: plan.guidance,
      retryFeedback: plan.retryFeedback, forceRestate:plan.forceRestate,
      restateTaskIds:plan.restateTaskIds, executionContext: context,
    };
    prompt = await buildPlannerExecutionPrompt(planner, undefined, adapter);
  } else {
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found in Job ${job.id}`);
    if (!task.executionId) throw new Error(`Task ${taskId} has no execution ID`);
    const context = await resolveExecutionContext(projectPath,
      task.agentName === 'troubleshooter' ? 'troubleshooter' : task.agentName === 'reviewer' ? 'reviewer' : 'worker');
    prompt = await managedWorkerInput(job, {...task, adapter}, context);
  }
  const output = arg(args, '--output');
  if (output) await writeFile(output,prompt+'\n',{mode:0o600});
  else console.log(prompt);
}

/** Authorized active Plan Context retrieval, like `task context`, from SQLite.
 * Read-only; a stale or completed Plan cannot claim a current execution.
 */
export async function runPlanContextCommand(args: string[]): Promise<void> {
  const planId=arg(args,'--plan-id'), executionId=arg(args,'--execution-id');
  if(!planId || !executionId)throw new Error('plan context requires --plan-id and --execution-id');
  const {job}=await storeFor(args,true);
  const plan=job.plans?.find(p=>p.id===planId);
  if(!plan || plan.status!=='PLANNING' || plan.executionId!==executionId)
    throw new Error(`Stale Plan execution ${planId}/${executionId}; current state ${plan?.status??'not-found'}`);
  const projectPath=arg(args,'--project-path') || resolveRepositoryProjectPath(await resolveManagedProjectPath(job.repository),job.projectPath);
  const context=await resolveExecutionContext(projectPath,'planner');
  const input:PlannerContext={job,tasks:job.tasks,objective:job.objective??job.description??job.title,
    previousPlannerTaskId:plan.previousPlanId,planExecution:{planId,executionId},
    trigger:plan.trigger,executionContext:context,retryFeedback:plan.retryFeedback,
    guidance:plan.guidance,forceRestate:plan.forceRestate,restateTaskIds:plan.restateTaskIds};
  console.log(plannerInput(input));
}

/** Read-only Task Context Action; no HTTP service, GitHub or mutable state. */
export async function runTaskContextCommand(args:string[]):Promise<void>{
  const id=arg(args,'--task-id');
  if(!id)throw new Error('task context requires --task-id');
  const {job}=await storeFor(args,true);
  console.log(JSON.stringify(taskExecutionContext(job,id,arg(args,'--execution-id')),null,2));
}

/** Read Task-scoped event history via the Relay CLI; never require workers to query backing services directly. */
export async function runTaskEventsCommand(args: string[]): Promise<void> {
  const id=arg(args,'--task-id');
  if(!id)throw new Error('task events requires --task-id');
  const {job}=await storeFor(args,true);
  if(!job.tasks.some(task=>task.id===id))throw new Error(`Task ${id} not found in Job ${job.id}`);
  for(const flag of ['--limit','--order','--after']) {
    if(args.filter(value=>value===flag).length>1)throw new Error(`task events ${flag} may not be repeated`);
    if(args.includes(flag) && (!arg(args,flag) || arg(args,flag).startsWith('--')))
      throw new Error(`task events ${flag} requires a value`);
  }
  const requested=Number(arg(args,'--limit','60'));
  if(!Number.isInteger(requested)||requested<1||requested>60)
    throw new Error('task events --limit must be an integer from 1 to 60');
  const order=arg(args,'--order','desc');
  if(order!=='asc' && order!=='desc')throw new Error('task events --order must be asc or desc');
  const afterRaw=arg(args,'--after','0');
  const after=Number(afterRaw);
  if(!Number.isSafeInteger(after)||after<0)throw new Error('task events --after must be a non-negative integer cursor');
  if(args.includes('--after') && order!=='asc')throw new Error('task events --after requires --order asc');
  const page=await eventsBusHistoryPage(job.id,id,requested,{order,after});
  const events=page.events; // Source validates Job/Task identity and cursor before exposing evidence.
  console.log(JSON.stringify({jobId:job.id,taskId:id,order:order==='asc'?'oldest-first':'newest-first',
    ...(order==='asc'?{nextCursor:page.nextCursor,morePossible:events.length===requested}:{}),events},null,2));
}

/** Read-only Task details/comments. ID-only lookup uses the immutable local Job index. */
export async function runTaskReadCommand(action: 'show'|'comments', args: string[]): Promise<void> {
  const id=arg(args,'--task-id');
  if(!id)throw new Error(`task ${action} requires --task-id`);
  const {job}=await storeFor(args,true);
  const task=job.tasks.find(item=>item.id===id);
  if(!task)throw new Error(`Task ${id} not found in Job ${job.id}`);
  console.log(JSON.stringify(action==='show'?task:task.comments??[],null,2));
}
