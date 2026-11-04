import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { missingShortcutNodes, recordShortcutReceipt, runAgentShortcut, shortcutResumeEvent } from './agent-shortcut.js';
import { parseAgentGraph } from './agent-graph.js';
import { tryTransitionTaskEvent } from './task-transitions.js';
import { dispatchJobLifecycleSync } from './workflow/lifecycle.js';
import type { DurableStore } from './store.js';
import type { EventBus } from './events.js';
import type { Reconciler } from './reconciler.js';
import { driveShortcutWorkers } from './shortcut-worker-runner.js';
import { noGitHubMode } from './no-github.js';
import { resolveManagedProjectPath, resolveRepositoryProjectPath, resolveWorkspaceRoot } from './workspace.js';
import { arg, hasArg, integerArg, publishWake, saveLocal, storeFor, textOption, withEventBus } from './cli-support.js';

function assertSqliteShortcutArgs(args: string[]): void {
  if (args.some(value => value === '--file' || value.startsWith('--file=')))
    throw new Error('Shortcut commands require the authoritative SQLite Relay store; --file is unsupported');
}

/** Apply the canonical Job Graph activate edge before the first direct run.
 * The Job is created DRAFT so creation alone cannot launch any work. */
export async function activateShortcutJobForDirectRun(store: DurableStore, jobId: string): Promise<void> {
  if (!store.mutateJob) throw new Error('Shortcut activation requires atomic SQLite Job mutation');
  await store.mutateJob(jobId, current => {
    if (current.executionMode !== 'shortcut' || current.contentOnly !== true)
      throw new Error('Only a content-only Shortcut Job may be activated by direct run');
    if (current.state === 'DRAFT') {
      const decision = dispatchJobLifecycleSync(current, 'activate');
      if (!decision.accepted || decision.target !== 'ACTIVE')
        throw new Error('Job Lifecycle graph rejected shortcut activation');
    } else if (current.state !== 'ACTIVE') {
      throw new Error(`Shortcut Job ${jobId} is not runnable (${current.state})`);
    }
    return current;
  });
}

export async function runShortcutJobCommand(args: string[], id: string, repo: string, makeRunner?: (store: DurableStore, bus: EventBus | undefined) => Reconciler): Promise<void> {
  assertSqliteShortcutArgs(args);
  if (arg(args, '--mode') !== 'shortcut') throw new Error('job run requires --mode shortcut');
  const loaded = await storeFor(args);
  if (loaded.localFile !== null || !loaded.store.mutateJob || !loaded.store.reserveWorkflowLaunch)
    throw new Error('Shortcut execution requires the authoritative SQLite Relay store');
  const job = loaded.job;
  if (job.executionMode !== 'shortcut' || job.contentOnly !== true) throw new Error('job run shortcut mode must be durably selected at Job creation with --shortcut-execution before Tasks are materialized');
  const taskId = arg(args, '--task-id');
  if (!taskId) throw new Error('job run requires --task-id');
  let task = job.tasks.find(item => item.id === taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  if (hasArg(args, '--event-json')) shortcutResumeEvent(arg(args, '--event-json'));
  if (!task.agentGraph && !hasArg(args, '--agent-graph-file')) throw new Error(`Task ${taskId} has no Agent Graph; set it on the Task or pass --agent-graph-file`);
  let resumeReceiptSelected=false;
  if(task.state==='RUNNING'&&task.leaseOwner===null&&task.executionId!==null) {
    const checkpoint=task.result?.data?.shortcut as {receipts?:Record<string,unknown>}|undefined;
    if(Object.keys(checkpoint?.receipts??{}).length>0) {
      const decision=tryTransitionTaskEvent(task,'shortcut.result',{shortcutResultCorrelated:true});
      if(!decision.accepted||!decision.actions.includes('effect.resumeShortcut')) throw new Error('Task Lifecycle graph did not select direct receipt resumption');
      resumeReceiptSelected=true;
    }
  }
  const graphOverride = hasArg(args, '--agent-graph-file') ? await textOption(args, '--agent-graph', '--agent-graph-file') : undefined;
  if (graphOverride) {
    parseAgentGraph(graphOverride);
    if (!loaded.store.mutateJob) throw new Error('Persisting an Agent Graph override requires atomic SQLite mutation');
    await loaded.store.mutateJob(id, current => {
      const durable = current.tasks.find(item => item.id === taskId);
      if (!durable) throw new Error(`Task ${taskId} not found`);
      if (durable.agentGraph && durable.agentGraph !== graphOverride) throw new Error('Cannot replace a durable Task Agent Graph');
      if (!durable.agentGraph && durable.state !== 'QUEUED') throw new Error('Agent Graph must be persisted before Task execution starts');
      durable.agentGraph = graphOverride;
      return current;
    });
    loaded.job = await loaded.store.load(id);
    task = loaded.job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} disappeared`);
  }
  await activateShortcutJobForDirectRun(loaded.store, id);
  loaded.job = await loaded.store.load(id);
  const workspaceRoot = await resolveWorkspaceRoot(arg(args, '--workspace-root') || undefined);
  const projectRoot = await resolveManagedProjectPath(noGitHubMode(args) ? undefined : repo, arg(args, '--project-path') || loaded.job.projectPath || '', workspaceRoot);
  const projectPath = resolveRepositoryProjectPath(projectRoot, loaded.job.projectPath);
  const missing = await missingShortcutNodes(task.agentGraph!, projectPath, arg(args, '--neo-root') || join(workspaceRoot, 'neo'));
  const previous = task.result?.data?.shortcut as { workerFallback?:boolean } | undefined;
  if (missing.length || previous?.workerFallback === true) {
    if (!makeRunner) throw new Error('Foreground Worker fallback requires a Shortcut Runner factory');
    if (task.state !== 'QUEUED' || task.executionId !== null || task.leaseOwner !== null)
      throw new Error(`Shortcut Worker fallback has an active/failed/foreign execution (${task.state}); refusing duplicate execution`);
    if (missing.length && previous?.workerFallback !== true) {
      await loaded.store.mutateJob(id, current => {
        const t = current.tasks.find(row => row.id === taskId);
        if (!t || t.state !== 'QUEUED' || t.executionId !== null || t.attempt !== 0 || t.result?.data?.shortcut)
          throw new Error('Shortcut Worker fallback must be selected before execution or prior effects');
        t.result = { summary: 'Foreground Shortcut Runner selected existing Worker adapter for uncovered Agent Graph',
          data: { shortcut: { workerFallback: true, missingNodes: missing, selectedBy: 'shortcut-foreground', at: new Date().toISOString() } } };
        return current;
      });
    }
    await withEventBus(args, async bus => {
      if (!bus) throw new Error('Foreground model Worker requires a reachable EventBus for authoritative task events');
      const reconciler=makeRunner(loaded.store,bus);
      const result=await driveShortcutWorkers({ store: loaded.store, jobId: id, taskId, reconciler,
        onTask: t => process.stderr.write(`shortcut.node ${JSON.stringify({nodeId:t.id,type:t.state.toLowerCase(),timestamp:new Date().toISOString(),data:{attempt:t.attempt,error:t.error,executionId:t.executionId}})}\n`) });
      const latest=result.job.tasks.find(row=>row.id===taskId);
      console.log(JSON.stringify({outcome:{status:result.status},fallbackQueued:false,task:latest},null,2));
      if(result.status!=='COMPLETED')process.exitCode=result.status==='TIMED_OUT'?4:result.status==='INTERRUPTED'?5:result.status==='WAITING_EVENT'?3:1;
    });
    return;
  }
  const controller=new AbortController();
  const onInterrupt=():void=>controller.abort(new Error('Interrupted by operator'));
  process.once('SIGINT',onInterrupt); process.once('SIGTERM',onInterrupt);
  try {
    const result = await runAgentShortcut({ store: loaded.store, job: loaded.job, task, projectPath,
      neoRoot: arg(args, '--neo-root') || join(workspaceRoot, 'neo'), concurrency: integerArg(args, '--concurrency', 4), signal:controller.signal,
      ...(resumeReceiptSelected?{resumeReceiptSelected:true as const}:{}),
      onNodeEvent:event=>process.stderr.write(`shortcut.node ${JSON.stringify(event)}\n`) });
    console.log(JSON.stringify({ outcome: result.outcome, fallbackQueued: false, task: result.task }, null, 2));
    if(result.outcome.status==='FAILED') {
      const checkpoint=result.task.result?.data?.shortcut as {terminal?:{status?:string}}|undefined;
      process.exitCode=checkpoint?.terminal?.status==='TIMED_OUT'?4:checkpoint?.terminal?.status==='INTERRUPTED'?5:1;
    } else if(result.outcome.status==='WAITING_EVENT') process.exitCode=3;
  } finally { process.removeListener('SIGINT',onInterrupt); process.removeListener('SIGTERM',onInterrupt); }
}

export async function recordShortcutReceiptCommand(args: string[], id: string): Promise<void> {
  assertSqliteShortcutArgs(args);
  const taskId = arg(args, '--task-id'), nodeId = arg(args, '--node-id'), waitId = arg(args, '--wait-id');
  const revision = arg(args, '--revision'), executionId = arg(args, '--execution-id'), outputFile = arg(args, '--output-file');
  const contentSha256 = arg(args, '--content-sha256');
  if (!taskId || !nodeId || !waitId || !revision || !executionId || !outputFile || !contentSha256)
    throw new Error('job shortcut-receipt requires --task-id --node-id --wait-id --revision --execution-id --output-file --content-sha256');
  if (outputFile === '-') throw new Error('--output-file requires a local file path');
  const { store, localFile } = await storeFor(args);
  if (localFile !== null || !store.mutateJob || !store.reserveWorkflowLaunch)
    throw new Error('Shortcut receipts require the authoritative SQLite Relay store');
  const bytes = await readFile(outputFile);
  const output: unknown = JSON.parse(bytes.toString('utf8'));
  const receipt = await recordShortcutReceipt(store, { jobId: id, taskId, nodeId, waitId, revision, executionId, contentSha256, output });
  const updated = await store.load(id);
  await saveLocal(localFile, updated);
  await withEventBus(args, bus => publishWake(bus, updated, taskId, 'Shortcut receipt recorded in Relay SQLite'));
  console.log(JSON.stringify({ receipt: { ...receipt, output: undefined }, jobId: id, taskId }, null, 2));
}
