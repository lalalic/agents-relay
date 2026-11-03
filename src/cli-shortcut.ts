import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { recordShortcutReceipt, runAgentShortcut, shortcutResumeEvent } from './agent-shortcut.js';
import { parseAgentGraph } from './agent-graph.js';
import { noGitHubMode } from './no-github.js';
import { dispatchTaskAction } from './task-actions.js';
import { resolveManagedProjectPath, resolveRepositoryProjectPath, resolveWorkspaceRoot } from './workspace.js';
import { arg, hasArg, integerArg, publishWake, saveLocal, storeFor, textOption, withEventBus } from './cli-support.js';

function assertSqliteShortcutArgs(args: string[]): void {
  if (args.some(value => value === '--file' || value.startsWith('--file=')))
    throw new Error('Shortcut commands require the authoritative SQLite Relay store; --file is unsupported');
}

export async function runShortcutJobCommand(args: string[], id: string, repo: string): Promise<void> {
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
  if (task.result?.data?.shortcut && typeof task.result.data.shortcut === 'object'
    && (task.result.data.shortcut as { workerFallback?: boolean }).workerFallback === true)
    throw new Error('Task is durably routed to the original Worker; let the Reconciler dispatch it instead of running shortcut mode');
  if (!task.agentGraph && !hasArg(args, '--agent-graph-file')) throw new Error(`Task ${taskId} has no Agent Graph; set it on the Task or pass --agent-graph-file`);
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
  const workspaceRoot = await resolveWorkspaceRoot(arg(args, '--workspace-root') || undefined);
  const projectRoot = await resolveManagedProjectPath(noGitHubMode(args) ? undefined : repo, arg(args, '--project-path') || loaded.job.projectPath || '', workspaceRoot);
  const projectPath = resolveRepositoryProjectPath(projectRoot, loaded.job.projectPath);
  if (hasArg(args, '--event-json')) shortcutResumeEvent(arg(args, '--event-json'));
  const result = await runAgentShortcut({ store: loaded.store, job: loaded.job, task, projectPath,
    neoRoot: arg(args, '--neo-root') || join(workspaceRoot, 'neo'), concurrency: integerArg(args, '--concurrency', 4) });
  let outputTask = result.task;
  if (result.fallback) {
    await dispatchTaskAction(loaded.store, { id: 'task.retry', jobId: id, taskId });
    const queued = await loaded.store.load(id);
    outputTask = queued.tasks.find(item => item.id === taskId) ?? outputTask;
    await withEventBus(args, bus => publishWake(bus, queued, taskId, 'Shortcut unavailable or invalid; handed to normal Worker execution'));
  } else if (result.outcome.status === 'FAILED') {
    await withEventBus(args, bus => publishWake(bus, loaded.job, taskId, 'Shortcut stopped after possible effects; reconcile its durable Troubleshooter recovery'));
  }
  console.log(JSON.stringify({ outcome: result.outcome, fallbackQueued: result.fallback, task: outputTask }, null, 2));
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
