import { writeFile } from 'node:fs/promises';
import { plannerInput } from './planner.js';
import { arg, storeFor } from './cli-support.js';
import { resolveExecutionContext } from './execution-context.js';
import { buildPlannerExecutionPrompt, type PlannerContext } from './planner.js';
import { managedWorkerInput } from './managed-worker-input.js';
import { resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { taskExecutionContext } from './task-context.js';
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
