#!/usr/bin/env node
import { homedir } from 'node:os'; import { join } from 'node:path';
import { GhApiClient } from './github-client.js'; import { configureLocalGitMerge } from './cli-local-merge-config.js'; import { DisabledGitHubClient, noGitHubMode } from './no-github.js'; import { discoverLocalRelayStoreSnapshots } from './relay-store.js'; import { readFile, writeFile } from 'node:fs/promises'; import { realpathSync } from 'node:fs'; import { once } from 'node:events'; import { fileURLToPath } from 'node:url'; import { randomUUID } from 'node:crypto'; import { dashboardManagedJobs, InMemoryStore, DurableStore, GitHubClient, GitHubStore, PullRequest, resolvePullRequest, listManagedGitHubJobs } from './store.js'; import { githubAuthContext } from './github-auth.js'; import { EventRecord, Job, Plan, Task, AdapterName, RoutingDecision, ExecutionMode, ChatGptTabClosePolicy, StorySize, storySizeTimeoutMs, taskOverallTimeoutMs } from './types.js'; import { Reconciler } from './reconciler.js'; import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js'; export { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js'; import { CodexAdapter, ChatGptAdapter } from './adapters.js'; import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js'; import { NatsEventBus, eventFor, EventBus } from './events.js'; import { serveDashboard } from './dashboard.js'; import { codexAndZaiUsageRegistry } from './usage.js'; import { decisionMode, executionDecisionEngine } from './decision.js'; import { Server } from 'node:http';
import { AgentRegistration, Priority } from './types.js'; import { discoverAgents } from './registry.js'; import { AgentObjectivePlanner, CommandObjectivePlanner } from './planner.js';
import { parseJobSchedule, transitionJobEvent } from './scheduler.js'; import { applyOrchestratorStartAction, applyOrchestratorCompleteAction, applyTaskHoldAction, applyTaskQueueAction, dispatchTaskAction } from './task-actions.js';
import { applyJobActivateAction, applyJobCancelAction } from './job-actions.js'; import { ExecutionRole, resolveExecutionContext } from './execution-context.js'; import { startServiceExternalActionFlusher } from './service-external-actions.js'; import { handleServicePublication } from './service-publication.js';
import { defaultWorkspaceRoot, prepareLocalJobExecutionWorktree, resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { runBlockerCommand } from './cli-blocker.js'; import { runEscalationCommand } from './cli-escalation.js'; import { projectionHelp, runProjectionCommand } from './cli-projection.js'; import { helpText, usage } from './cli-help.js'; import { parseAgentGraph } from './agent-graph.js'; import { runJobUnblockCommand, runTaskUnblockCommand } from './cli-unblock.js'; import { createJobEntity, createTaskEntity } from './workflow/entity-creation.js'; import { runCliEntrypoint } from './cli-shutdown.js'; import { shutdownOwnedProcesses } from './owned-process.js'; export { helpText } from './cli-help.js'; import { runReviewCommand } from './cli-review.js'; import { normalizeThreadId, runtimeReviewer } from './reviewer-thread.js'; export { runtimeReviewer } from './reviewer-thread.js'; import { SERVICE_DEFAULTS, ServiceEventBus, arg, hasArg, textOption, integerArg, repository, pullRequest, storeFor, saveLocal, githubStore, eventBus, publishWake, publishDependentUnblocked, priority, storySize, executionMode, chatGptTabClosePolicy, requestedExecutionMode, continuation, scheduleFromArgs, jobTagFromArgs, requestManagedReconciliation, relayControlJob, relayControlCommand, relayJobList, relayJobStateCommand, relayTaskCommand, withEventBus } from './cli-support.js'; export { SERVICE_DEFAULTS, eventBus, executionMode, chatGptTabClosePolicy } from './cli-support.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
export { ensureManagedGitHubJob } from './cli-job-create.js';
async function workerTaskFromArgs(job: Job, args: string[], now: string): Promise<Task> {
  const model = arg(args, '--model');
  const adapterValue = arg(args, '--adapter');
  const adapter = (adapterValue || 'codex') as AdapterName;
  const outputKind = arg(args, '--output');
  const outputPath = arg(args, '--output-path');
  const input = await textOption(args, '--input', '--input-file');
  const agentGraph = hasArg(args, '--agent-graph') || hasArg(args, '--agent-graph-file') ? await textOption(args, '--agent-graph', '--agent-graph-file') : undefined;
  if (agentGraph) parseAgentGraph(agentGraph);
  if (!input.trim()) throw new Error('task create requires --input-file PATH|- or --input MARKDOWN');
  if (!['codex', 'chatgpt', 'orchestrator'].includes(adapter)) throw new Error('task create --adapter must be codex, chatgpt, or orchestrator');
  if (outputKind !== 'task-pr' && outputKind !== 'file') throw new Error('task create requires --output task-pr|file'); if (outputKind === 'file' && !outputPath) throw new Error('--output file requires --output-path');
  if (adapter !== 'orchestrator' && ['--provider','--profile','--reasoning','--cwd','--chatgpt-project'].some(flag => hasArg(args, flag)) && !model) throw new Error('task create explicit routing requires --model');
  const routing: RoutingDecision | undefined = adapter === 'orchestrator' || !model ? undefined : { provider: arg(args, '--provider', 'openai'), model, profile: arg(args, '--profile') || undefined, reasoning: arg(args, '--reasoning') || undefined, cwd: arg(args, '--cwd') || undefined, projectId: arg(args, '--chatgpt-project') || undefined, decidedBy: 'cli', decidedAt: now };
  const workerRequirements = adapter === 'orchestrator' || routing ? undefined : { capabilities: [], runtime: adapterValue ? adapter : undefined };
  const closePolicy = hasArg(args, '--chatgpt-tab-close-policy') ? chatGptTabClosePolicy(args) : undefined;
  const size = storySize(args);
  const dependencies = arg(args, '--deps').split(',').filter(Boolean);
  const timeoutMs = adapter === 'orchestrator' ? 0 : hasArg(args, '--timeout') ? integerArg(args, '--timeout', taskOverallTimeoutMs(size, routing?.reasoning)) : routing ? taskOverallTimeoutMs(size, routing.reasoning) : 0;
  return createTaskEntity(job, {
    jobId: job.id,
    id: arg(args, '--task-id', 'initial'),
    priority: priority(args, job.priority ?? 'P2'),
    storySize: size,
    projectName: arg(args, '--project') || undefined,
    agentName: arg(args, '--agent') || undefined,
    agentGraph,
    parentTaskId: arg(args, '--parent') || null,
    dependencies,
    capabilities: arg(args, '--capabilities').split(',').filter(Boolean),
    workerRequirements,
    adapter,
    chatgptTabClosePolicy: closePolicy,
    input: input || 'true',
    attachments: arg(args, '--attachments').split(',').filter(Boolean),
    output: outputKind === 'file' ? { kind: 'file', path: outputPath } : { kind: 'task_pr' },
    routing,
    continuation: continuation(args),
    continuationDeliveredAt: null,
    attempt: 0,
    maxAttempts: Number(arg(args, '--max-attempts', '3')),
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: null,
    timeoutMs,
    createdAt: now,
    updatedAt: now
  }, { defer: hasArg(args, '--draft') });
}
async function runManagedTaskCommand(action: 'create'|'start'|'retry'|'cancel'|'complete', args: string[]): Promise<void> {
  const jobId = arg(args, '--id');
  if (!jobId) throw new Error('--id is required for managed task commands');
  const id = arg(args, '--task-id', action === 'create' ? randomUUID() : '');
  if (!id) throw new Error(`task ${action} requires --task-id`);
  let result: Job;
  if (action === 'create') {
    const job = await relayControlJob(args, jobId);
    if (['COMPLETED','CANCELLED'].includes(job.state)) throw new Error(`Cannot create task on terminal job ${job.id} (${job.state})`);
    const task = await workerTaskFromArgs(job, args, new Date().toISOString());
    task.id = id;
    result = await relayTaskCommand(args, { jobId, action, task });
  } else if (action === 'complete') {
    const summary = arg(args, '--summary');
    if (!summary) throw new Error('task complete requires --summary');
    result = await relayTaskCommand(args, { jobId, taskId: id, action, summary });
  } else result = await relayTaskCommand(args, { jobId, taskId: id, action });
  const task = result.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} missing after ${action}`);
  console.log(JSON.stringify(task, null, 2));
}
async function runTaskCommand(action: string, args: string[]): Promise<void> {
  if (!['create', 'update', 'show', 'list', 'start', 'complete', 'retry', 'recover', 'unblock', 'cancel'].includes(action)) throw new Error(usage);
  const managed = !arg(args, '--file') && Boolean(arg(args, '--repo') && arg(args, '--id'));
  if (managed) {
    const jobId = arg(args, '--id');
    if (action === 'list') { const job = await relayControlJob(args, jobId); console.log(JSON.stringify(job.tasks, null, 2)); return; }
    const taskId = arg(args, '--task-id', action === 'create' ? randomUUID() : '');
    if (action === 'show') { if (!taskId) throw new Error('task show requires --task-id'); const job = await relayControlJob(args, jobId); const task = job.tasks.find(item => item.id === taskId); if (!task) throw new Error(`Task ${taskId} not found`); console.log(JSON.stringify(task, null, 2)); return; }
    if (['create','start','complete','retry','cancel'].includes(action)) { await runManagedTaskCommand(action as 'create'|'start'|'retry'|'cancel'|'complete', args); return; }
    if (action === 'recover') { if (!taskId) throw new Error('task recover requires --task-id'); const recoveryTaskId = arg(args, '--recovery-task-id'); if (!recoveryTaskId) throw new Error('task recover requires --recovery-task-id'); const job = await relayControlCommand<Job>(args, { command: 'task.recover', jobId, taskId, recoveryTaskId }); console.log(JSON.stringify(job.tasks.find(item => item.id === taskId), null, 2)); return; }
    if (action === 'unblock') { if (!taskId) throw new Error('task unblock requires --task-id'); const reason = arg(args, '--reason'); if (!reason.trim()) throw new Error('task unblock requires --reason'); const job = await relayControlCommand<Job>(args, { command: 'task.unblock', jobId, taskId, reason }); console.log(JSON.stringify(job.tasks.find(item => item.id === taskId), null, 2)); return; }
    if (action === 'update') {
      const job = await relayControlJob(args, jobId); const task = job.tasks.find(item => item.id === taskId); if (!task) throw new Error(`Task ${taskId} not found`); const expectedUpdatedAt = task.updatedAt;
      if (['RUNNING', 'UNBLOCKED', 'SUCCEEDED', 'CANCELLED'].includes(task.state)) throw new Error(`Task ${taskId} is ${task.state}; durable execution fields are immutable in this state`);
      if (hasArg(args, '--adapter')) { const adapter = arg(args, '--adapter') as AdapterName; if (!['codex','chatgpt','orchestrator'].includes(adapter)) throw new Error('--adapter must be codex, chatgpt, or orchestrator'); task.adapter = adapter; }
      if (hasArg(args, '--priority')) task.priority = priority(args, task.priority ?? job.priority ?? 'P2');
      if (hasArg(args, '--story-size')) { task.storySize = storySize(args, task.storySize ?? 'M'); if (!hasArg(args, '--timeout')) task.timeoutMs = taskOverallTimeoutMs(task.storySize, task.routing?.reasoning); }
      if (hasArg(args, '--input') || hasArg(args, '--input-file')) task.input = await textOption(args, '--input', '--input-file');
      if (hasArg(args, '--project')) task.projectName = arg(args, '--project') || undefined; if (hasArg(args, '--agent')) task.agentName = arg(args, '--agent') || undefined;
      if (hasArg(args, '--parent')) task.parentTaskId = arg(args, '--parent') || null; if (hasArg(args, '--deps')) task.dependencies = arg(args, '--deps').split(',').filter(Boolean); if (hasArg(args, '--capabilities')) task.capabilities = arg(args, '--capabilities').split(',').filter(Boolean);
      task.timeoutMs = integerArg(args, '--timeout', task.timeoutMs); task.maxAttempts = integerArg(args, '--max-attempts', task.maxAttempts);
      if (hasArg(args, '--draft') && hasArg(args, '--queue')) throw new Error('--draft and --queue are mutually exclusive'); if (hasArg(args, '--draft') && task.state === 'QUEUED') await applyTaskHoldAction(task); if (hasArg(args, '--queue')) await applyTaskQueueAction(job, task);
      const updated = await relayTaskCommand(args, { jobId, taskId, action: 'update', task, expectedUpdatedAt }); console.log(JSON.stringify(updated.tasks.find(item => item.id === taskId), null, 2)); return;
    }
  }
  const loaded = await storeFor(args); const { store, localFile } = loaded;
  const job = loaded.job;
  if (action === 'list') { console.log(JSON.stringify(job.tasks, null, 2)); return; }
  const id = arg(args, '--task-id', action === 'create' ? randomUUID() : '');
  if (!id) throw new Error(`task ${action} requires --task-id`);
  if (action === 'create') {
    if (['COMPLETED', 'CANCELLED'].includes(job.state)) throw new Error(`Cannot create task on terminal job ${job.id} (${job.state})`);
    const now = new Date().toISOString();
    const task = await workerTaskFromArgs(job, args, now);
    task.id = id;
    await store.appendTask(task);
    const refreshed = await store.load(job.id);
    if (refreshed.state === 'DRAFT') { await applyJobActivateAction(refreshed); await store.saveJob(refreshed); }
    const durableTask = (await store.load(job.id)).tasks.find(item => item.id === task.id) ?? task;
    await saveLocal(localFile, await store.load(job.id));
    await withEventBus(args, bus => publishWake(bus, refreshed, task.id, `Task ${task.id} created`));
    console.log(JSON.stringify(durableTask, null, 2));
    return;
  }
  const task = job.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} not found`);
  if (action === 'show') { console.log(JSON.stringify(task, null, 2)); return; }
  if (action === 'unblock') { await runTaskUnblockCommand(args, store, job, task, localFile); return; }
  if (action === 'start') {
    await applyOrchestratorStartAction(task);
    await store.saveTask(task);
    await saveLocal(localFile, await store.load(job.id));
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (action === 'complete') {
    const summary = arg(args, '--summary');
    if (!summary) throw new Error('task complete requires --summary');
    await applyOrchestratorCompleteAction(task, summary);
    await store.saveTask(task);
    await saveLocal(localFile, await store.load(job.id));
    console.log(JSON.stringify(task, null, 2));
    return;
  }
  if (action === 'retry' || action === 'recover' || action === 'cancel') {
    let outputJob = job;
    let outputTask = task;
    if (action === 'retry' || action === 'recover') {
      const recoveryTaskId = action === 'recover' ? arg(args, '--recovery-task-id') : '';
      if (action === 'recover' && !recoveryTaskId) throw new Error('task recover requires --recovery-task-id');
      const result = await dispatchTaskAction(store, { id: action === 'recover' ? 'task.recover' : 'task.retry', jobId: job.id, taskId: id, ...(recoveryTaskId ? { recoveryTaskId } : {}) });
      if (result.job.state === 'DRAFT') { await applyJobActivateAction(result.job); await store.saveJob(result.job); }
      outputJob = await store.load(job.id);
      outputTask = outputJob.tasks.find(item => item.id === id) ?? result.task;
    } else {
      const result = await dispatchTaskAction(store, { id: 'task.cancel', jobId: job.id, taskId: id });
      outputJob = await store.load(job.id);
      outputTask = outputJob.tasks.find(item => item.id === id) ?? result.task;
    }
    await saveLocal(localFile, outputJob);
    await withEventBus(args, bus => publishWake(bus, outputJob, outputTask.id, `${outputTask.id} ${action} requested`));
    console.log(JSON.stringify(outputTask, null, 2));
    return;
  }
  const expectedUpdatedAt = task.updatedAt;
  if (['RUNNING', 'UNBLOCKED', 'SUCCEEDED', 'CANCELLED'].includes(task.state)) throw new Error(`Task ${id} is ${task.state}; durable execution fields are immutable in this state`);
  if (hasArg(args, '--adapter')) {
    const adapter = arg(args, '--adapter') as AdapterName;
    if (!['codex', 'chatgpt', 'orchestrator'].includes(adapter)) throw new Error('--adapter must be codex, chatgpt, or orchestrator');
    task.adapter = adapter;
  }
  if (hasArg(args, '--priority')) task.priority = priority(args, task.priority ?? job.priority ?? 'P2');
  if (hasArg(args, '--story-size')) { task.storySize = storySize(args, task.storySize ?? 'M'); if (!hasArg(args, '--timeout')) task.timeoutMs = taskOverallTimeoutMs(task.storySize, task.routing?.reasoning); }
  if (hasArg(args, '--input') || hasArg(args, '--input-file')) task.input = await textOption(args, '--input', '--input-file');
  if (hasArg(args, '--project')) task.projectName = arg(args, '--project') || undefined;
  if (hasArg(args, '--agent')) task.agentName = arg(args, '--agent') || undefined;
  if (hasArg(args, '--agent-graph') || hasArg(args, '--agent-graph-file')) {
    const agentGraph = await textOption(args, '--agent-graph', '--agent-graph-file');
    if (agentGraph) parseAgentGraph(agentGraph);
    task.agentGraph = agentGraph || undefined;
  }
  if (hasArg(args, '--parent')) task.parentTaskId = arg(args, '--parent') || null;
  if (hasArg(args, '--deps')) task.dependencies = arg(args, '--deps').split(',').filter(Boolean);
  if (hasArg(args, '--capabilities')) task.capabilities = arg(args, '--capabilities').split(',').filter(Boolean);
  if (hasArg(args, '--chatgpt-tab-close-policy')) task.chatgptTabClosePolicy = chatGptTabClosePolicy(args);
  task.timeoutMs = integerArg(args, '--timeout', task.timeoutMs);
  task.maxAttempts = integerArg(args, '--max-attempts', task.maxAttempts);
  if (hasArg(args, '--draft') && hasArg(args, '--queue')) throw new Error('--draft and --queue are mutually exclusive');
  if (hasArg(args, '--draft') && task.state === 'QUEUED') await applyTaskHoldAction(task);
  if (hasArg(args, '--queue')) {
    if (managed) await applyTaskQueueAction(job, task);
    else {
      await store.saveTask(task);
      const result = await dispatchTaskAction(store, { id: 'task.queue', jobId: job.id, taskId: id });
      Object.assign(task, result.task);
    }
  }
  if (hasArg(args, '--max-attempts') && task.maxAttempts < task.attempt) throw new Error('--max-attempts cannot be less than the current attempt count');
  const routingFlags = ['--provider','--model','--profile','--reasoning','--cwd','--chatgpt-project'];
  if (args.includes('--clear-routing')) task.routing = undefined;
  else if (routingFlags.some(flag => hasArg(args, flag))) {
    const current = task.routing;
    const model = hasArg(args, '--model') ? arg(args, '--model') : current?.model;
    if (!model) throw new Error('task routing update requires --model when no existing routing is present');
    task.routing = {
      provider: hasArg(args, '--provider') ? arg(args, '--provider') : current?.provider ?? 'openai',
      model,
      profile: hasArg(args, '--profile') ? arg(args, '--profile') || undefined : current?.profile,
      reasoning: hasArg(args, '--reasoning') ? arg(args, '--reasoning') || undefined : current?.reasoning,
      cwd: hasArg(args, '--cwd') ? arg(args, '--cwd') || undefined : current?.cwd,
      projectId: hasArg(args, '--chatgpt-project') ? arg(args, '--chatgpt-project') || undefined : current?.projectId,
      decidedBy: 'cli:update', decidedAt: new Date().toISOString()
    };
    if (hasArg(args, '--reasoning') && !hasArg(args, '--timeout')) task.timeoutMs = taskOverallTimeoutMs(task.storySize ?? 'M', task.routing.reasoning);
  }
  if (managed) {
    const updated = await relayTaskCommand(args, { jobId: job.id, taskId: id, action: 'update', task, expectedUpdatedAt });
    console.log(JSON.stringify(updated.tasks.find(item => item.id === id), null, 2));
    return;
  }
  task.updatedAt = new Date().toISOString();
  await store.saveTask(task);
  await saveLocal(localFile, job);
  console.log(JSON.stringify(task, null, 2));
}
async function runContextCommand(action: string, args: string[]): Promise<void> {
  if (action !== 'resolve') throw new Error(usage);
  const projectPath = arg(args, '--project-path');
  if (!projectPath) throw new Error('context resolve requires --project-path');
  const roleValue = arg(args, '--role', 'orchestrator');
  const roles: ExecutionRole[] = ['orchestrator', 'planner', 'reviewer', 'worker', 'nested-worker'];
  if (!roles.includes(roleValue as ExecutionRole)) throw new Error('--role must be orchestrator, planner, reviewer, worker, or nested-worker');
  const neoRootArg = arg(args, '--neo-root');
  const context = await resolveExecutionContext(projectPath, roleValue as ExecutionRole, {
    workspaceRoot: arg(args, '--workspace-root') || undefined,
    neoRoot: neoRootArg === 'none' ? null : neoRootArg || undefined,
    globalRoot: arg(args, '--global-root') || undefined,
    explicitSkills: arg(args, '--skills').split(',').filter(Boolean),
    explicitAgents: arg(args, '--agents').split(',').filter(Boolean),
  });
  console.log(JSON.stringify(context, null, 2));
}
async function runJobCommand(action: string, args: string[]): Promise<void> {
  if (!['create', 'update', 'show', 'list', 'merge', 'unblock', 'cancel'].includes(action)) throw new Error(usage);
  const repo = repository(args);
  let createObjective: string | undefined;
  if (action === 'create') {
    if (hasArg(args, '--no-auto-merge')) throw new Error('job create does not accept --no-auto-merge; new Jobs always enable auto-merge');
    const taskOnlyFlags = ['--start','--task-id','--input','--input-file','--adapter','--provider','--model','--profile','--reasoning','--story-size','--project','--agent','--parent','--deps','--capabilities','--attachments','--max-attempts','--timeout','--cwd','--chatgpt-project','--chatgpt-tab-close-policy','--output','--output-path','--draft','--queue'];
    const invalid = taskOnlyFlags.find(flag => hasArg(args, flag));
    if (invalid) throw new Error(`job create does not accept task execution option ${invalid}; create the job first, then let the orchestrator create the initial plan/task batch`);
    createObjective = await textOption(args, '--objective', '--objective-file');
    if ((!arg(args, '--pr') || noGitHubMode(args)) && !createObjective.trim()) throw new Error('job create with --head requires --objective-file PATH|- or --objective MARKDOWN containing the complete standalone Job context');
  }
  if (action === 'list') { console.log(JSON.stringify(await relayJobList(args), null, 2)); return; }
  const id = arg(args, '--id');
  if (!id) throw new Error('--id is required for managed local Jobs');
  const prValue = arg(args, '--pr');
  const prNumber = prValue ? Number(prValue) : 0;
  if (prValue && (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0)) throw new Error('--pr must be a positive integer');
  if (action === 'create') {
    const objective = createObjective ?? '';
    if (hasArg(args, '--local-merge-source') !== hasArg(args, '--local-merge-target')) throw new Error('Supply both --local-merge-source and --local-merge-target');
    const result = await relayControlCommand(args, { command: 'job.create', repository: repo, initialPlan: hasArg(args, '--initial-plan'), options: {
      id, title: arg(args, '--title') || undefined, objective: objective || undefined, projectPath: arg(args, '--project-path') || undefined,
      priority: priority(args), executionMode: requestedExecutionMode(args), schedule: scheduleFromArgs(args), tag: jobTagFromArgs(args), reviewEnabled: !hasArg(args, '--no-review'), continuation: continuation(args),
      reviewerThreadId: hasArg(args, '--reviewer-thread-id') ? arg(args, '--reviewer-thread-id') : undefined, creatorThreadId: hasArg(args, '--creator-thread-id') ? arg(args, '--creator-thread-id') : undefined,
      prNumber, head: arg(args, '--head') || undefined, base: arg(args, '--base', 'main'), body: arg(args, '--body') || objective || undefined,
      localMergeSource: arg(args, '--local-merge-source') || undefined, localMergeTarget: arg(args, '--local-merge-target') || undefined,
    }}); console.log(JSON.stringify(result, null, 2)); return;
  }
  const job = await relayControlJob(args, id);
  if (action === 'unblock') { const reason = arg(args, '--reason'); if (!reason.trim()) throw new Error('job unblock requires --reason'); const updated = await relayControlCommand<Job>(args, { command: 'job.unblock', jobId: id, reason }); console.log(JSON.stringify(updated, null, 2)); return; }
  if (action === 'show') { console.log(JSON.stringify(job, null, 2)); return; }
  const boundPrNumber = job.externalPrNumber ?? (job.prNumber > 0 ? job.prNumber : 0);
  if (job.repository !== repo || (prValue && boundPrNumber !== prNumber)) {
    throw new Error('Local Job/PR binding mismatch');
  }
  if (action === 'merge') {
    throw new Error('GitHub is audit-only. Configure local merge source/target and reconcile the local Job instead.');
  }
  if (action === 'cancel') {
    const updated = await relayJobStateCommand(args, job.id, 'CANCELLED');
    console.log(JSON.stringify(updated, null, 2)); return;
  }
  if (hasArg(args, '--title')) job.title = arg(args, '--title');
  if (hasArg(args, '--objective') || hasArg(args, '--objective-file')) { const objective = await textOption(args, '--objective', '--objective-file'); if (!objective.trim()) throw new Error('Job objective cannot be empty'); job.objective = objective; }
  if (hasArg(args, '--project-path')) job.projectPath = arg(args, '--project-path') || undefined;
  if (hasArg(args, '--local-merge-source') || hasArg(args, '--local-merge-target'))
    configureLocalGitMerge(job, arg(args, '--local-merge-source'), arg(args, '--local-merge-target'), noGitHubMode(args));
  if (hasArg(args, '--priority')) job.priority = priority(args, job.priority ?? 'P2');
  if (hasArg(args, '--mode') || hasArg(args, '--execution-mode')) job.executionMode = executionMode(args, job.executionMode ?? 'fixed');
  if (hasArg(args, '--schedule')) job.schedule = scheduleFromArgs(args);
  if (hasArg(args, '--tag')) job.tag = jobTagFromArgs(args);
  if (hasArg(args, '--auto-merge') && hasArg(args, '--no-auto-merge')) throw new Error('choose only one of --auto-merge or --no-auto-merge');
  if (hasArg(args, '--auto-merge')) job.autoMerge = true;
  if (hasArg(args, '--no-auto-merge')) job.autoMerge = false;
  if (hasArg(args, '--review') && hasArg(args, '--no-review')) throw new Error('choose only one of --review or --no-review');
  if (hasArg(args, '--review')) job.reviewEnabled = true;
  if (hasArg(args, '--no-review')) job.reviewEnabled = false;
  if (hasArg(args, '--reviewer-thread-id')) job.reviewerThreadId = normalizeThreadId(arg(args, '--reviewer-thread-id'), '--reviewer-thread-id');
  if (hasArg(args, '--creator-thread-id')) job.creatorThreadId = normalizeThreadId(arg(args, '--creator-thread-id'), '--creator-thread-id');
  if (hasArg(args, '--continue-kind') || hasArg(args, '--continue-target')) {
    const next = continuation(args);
    if (!next) throw new Error('--continue-kind and --continue-target must be supplied together');
    job.continuation = next;
  }
  const patch: Record<string, unknown> = {};
  for (const key of ['title','objective','projectPath','priority','executionMode','schedule','tag','autoMerge','reviewEnabled','reviewerThreadId','creatorThreadId','continuation','localMerge'] as const) patch[key] = (job as unknown as Record<string, unknown>)[key];
  console.log(JSON.stringify(await relayControlCommand<Job>(args, { command: 'job.update', jobId: id, patch }), null, 2));
}
export function runtimePlanner(args: readonly string[]): AgentObjectivePlanner | CommandObjectivePlanner { const plannerCommand = arg([...args], '--planner-command'); const modelRuntime = arg([...args], '--codex', 'codex'); return plannerCommand ? new CommandObjectivePlanner(plannerCommand) : new AgentObjectivePlanner(modelRuntime); }
export function runtime(store: DurableStore, args: string[], bus: EventBus | undefined, usageRegistry = codexAndZaiUsageRegistry()): Reconciler { const emit = (event: ReturnType<typeof eventFor>): void => { process.stderr.write(`${JSON.stringify(event)}\n`); }; const modelRuntime = arg(args, '--codex', 'codex'); const policy = chatGptTabClosePolicy(args); const planner = runtimePlanner(args); return new Reconciler(store, { noGitHub: noGitHubMode(args), owner: arg(args, '--owner', `cli-${process.pid}`), maxConcurrent: Number(arg(args, '--concurrency', '4')), leaseMs: Number(arg(args, '--lease-ms', '300000')), adapters: [new CodexAdapter(modelRuntime), new ChatGptAdapter({ tabClosePolicy: policy })], continuations: [new CodexThreadContinuation(modelRuntime), new CommandContinuation(), new WebhookContinuation()], planner, usageSnapshotProvider: () => usageRegistry.snapshot(), decisionEngine: executionDecisionEngine(), decisionMode: decisionMode(), reviewer: runtimeReviewer(args), eventBus: bus, emit, chatgptTabClosePolicy: policy, projectPathForJob: async job => { const workspaceRoot = arg(args, '--workspace-root') || defaultWorkspaceRoot(); const canonical = await resolveManagedProjectPath(noGitHubMode(args) ? undefined : job.repository, arg(args, '--project-path'), workspaceRoot); return job.prNumber === 0 && job.localMerge?.sourceRef ? prepareLocalJobExecutionWorktree(canonical, job, workspaceRoot) : resolveRepositoryProjectPath(canonical, job.projectPath); } }); }
export function dashboardJobAction(store: DurableStore, reconciler: Reconciler, action: 'start' | 'reconcile' | 'cancel'): (jobId: string) => Promise<Job> {
  return async (jobId: string): Promise<Job> => {
    const job = await store.load(jobId);
    if (action === 'start') {
      await applyJobActivateAction(job); await store.saveJob(job);
    } else if (action === 'cancel') {
      await applyJobCancelAction(store, job);
      return await store.load(job.id);
    }
    return await reconciler.wake(job.id);
  };
}
export interface Service { store: DurableStore; job: Job; reconciler: Reconciler; dashboardServer: Server; watchdogCleared: boolean; stop(): Promise<void>; }
export async function createService(args: string[]): Promise<Service> {
  const loaded = await storeFor(args); const upstream = await eventBus(args); const bus = upstream ? new ServiceEventBus(upstream) : undefined;
  const requestedUsageDays = Number(arg(args, '--usage-window-days', '1')); const usageWindowDays = Number.isInteger(requestedUsageDays) && requestedUsageDays > 0 ? requestedUsageDays : 1;
  const usageRegistry = codexAndZaiUsageRegistry(undefined, usageWindowDays);
  const reconciler = runtime(loaded.store, args, bus, usageRegistry);
  const repo = noGitHubMode(args) ? repository(args) : arg(args, '--repo');
  let overviewProvider: (() => Promise<Awaited<ReturnType<typeof listManagedGitHubJobs>>>) | undefined;
  if (repo) {
    overviewProvider = async () => {
      const snapshots = await discoverLocalRelayStoreSnapshots(join(homedir(), '.agents-relay', 'stores'));
      return dashboardManagedJobs(snapshots.flatMap(snapshot => snapshot.jobs
        .filter(job => job.repository === repo)
        .map(job => ({
          job, githubState: snapshot.facts?.state ?? 'UNKNOWN' as const, draft: false,
          mergedAt: null, closedAt: null, publication: snapshot.publications[job.id]?.latest ?? null, publicationFailure: snapshot.publications[job.id]?.failure ?? null,
        }))));
    };
  }
  const webhookSecret = arg(args, '--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || '';
  const webhook = !noGitHubMode(args) && repo && webhookSecret ? {
    secret: webhookSecret,
    repositories: new Set([repo]),
    pullRequest: loaded.job.externalPrNumber ?? loaded.job.prNumber,
    wake: async (event: import('./github-webhook.js').GitHubWebhookWake): Promise<void> => {
      if (event.pullRequestFacts && loaded.store.applyPullRequestFacts) {
        await loaded.store.applyPullRequestFacts({
          ...event.pullRequestFacts, observedAt: event.pullRequestFacts.observedAt ?? new Date().toISOString(),
        });
      }
      await handleServicePublication(await loaded.store.load(loaded.job.id), event, bus);
    },
  } : undefined;
  const dashboardServer = serveDashboard(loaded.store, Number(arg(args, '--port', String(SERVICE_DEFAULTS.port))), bus, Number(arg(args, '--refresh-ms', String(SERVICE_DEFAULTS.dashboardRefreshMs))), loaded.job.id, usageRegistry, overviewProvider, webhook, undefined, undefined, undefined, {
    start: dashboardJobAction(loaded.store, reconciler, 'start'),
    reconcile: dashboardJobAction(loaded.store, reconciler, 'reconcile'),
    cancel: dashboardJobAction(loaded.store, reconciler, 'cancel'),
    jobSetState: dashboardJobSetState(loaded.store),
    taskRetry: dashboardTaskAction(loaded.store, reconciler, 'retry'),
    taskCancel: dashboardTaskAction(loaded.store, reconciler, 'cancel'),
    taskSetState: dashboardTaskSetState(loaded.store),
  });
  await once(dashboardServer, 'listening');
  const stopWatcher = await reconciler.watch(loaded.job.id);
  const watchdog = setInterval(() => void reconciler.reconcile(loaded.job.id), Number(arg(args, '--interval', String(SERVICE_DEFAULTS.watchdogMs)))); watchdog.unref(); const stopExternalActions = startServiceExternalActionFlusher(loaded.store, reconciler, loaded.job.id, Number(arg(args, '--projection-ms', String(SERVICE_DEFAULTS.projectionFlushMs))));
  let stopping: Promise<void> | null = null;
  const service: Service = {
    store: loaded.store,
    job: loaded.job,
    reconciler,
    dashboardServer,
    watchdogCleared: false,
    stop(): Promise<void> {
      if (stopping) return stopping;
      clearInterval(watchdog); stopExternalActions(); service.watchdogCleared = true;
      const serverClosed = new Promise<void>((resolve, reject) => { dashboardServer.close(error => error ? reject(error) : resolve()); });
      dashboardServer.closeAllConnections();
      const watcherClosed = bus ? bus.close() : stopWatcher();
      stopping = Promise.all([reconciler.close(), watcherClosed, serverClosed, shutdownOwnedProcesses('parent-shutdown')]).then(() => undefined, error => { throw error; });
      return stopping;
    }
  };
  return service;
}
export async function startService(args: string[]): Promise<Service> {
  const service = await createService(args);
  const stop = (): void => { void service.stop().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  console.log('Dashboard listening');
  try {
    await service.reconciler.reconcile(service.job.id);
  } catch (error) {
    console.error(`Initial reconciliation failed; dashboard remains available: ${error instanceof Error ? error.message : String(error)}`);
  }
  return service;
}
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1]; if (!invoked) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invoked); } catch { return moduleUrl === `file://${invoked}`; }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2).filter(value => value !== '--no-github');
  if (!command || command === '--help' || command === '-h') { console.log(helpText()); return; }
  if (args.includes('--help') || args.includes('-h')) { console.log(helpText(command, command === 'job' || command === 'task' || command === 'context' || command === 'review' ? args[0] : undefined)); return; }
  if (command === 'job') { const [action, ...jobArgs] = args; await runJobCommand(action ?? '', jobArgs); return; }
  if (command === 'task') { const [action, ...taskArgs] = args; await runTaskCommand(action ?? '', taskArgs); return; }
  if (command === 'review') { const [action, ...reviewArgs] = args; await runReviewCommand(action ?? '', reviewArgs); return; }
  if (command === 'context') { const [action, ...contextArgs] = args; await runContextCommand(action ?? '', contextArgs); return; }
  if (command === 'blocker') { const [action, ...blockerArgs] = args; await runBlockerCommand(action ?? '', blockerArgs); return; }
  if (command === 'projection') { const [action, ...projectionArgs] = args; await runProjectionCommand(action ?? '', projectionArgs); return; }
  if (command === 'escalation') { await runEscalationCommand(args); return; }
  if (command === 'init') {
    const file = arg(args, '--file');
    const now = new Date().toISOString(); const initialSchedule = scheduleFromArgs(args); const id = arg(args, '--id', randomUUID());
    if (!file) {
      const repo = repository(args);
      const result = await relayControlCommand(args, { command: 'job.create', repository: repo, options: { id, title: arg(args, '--title', 'Agents Relay job'), objective: arg(args, '--objective') || undefined, priority: priority(args), executionMode: executionMode(args), schedule: initialSchedule, reviewEnabled: !hasArg(args, '--no-review'), continuation: continuation(args), prNumber: Number(arg(args, '--pr', '0')) || 0 } });
      console.log(JSON.stringify(result, null, 2)); return;
    }
    const job = createJobEntity({ id, title: arg(args, '--title', 'Agents Relay job'), objective: arg(args, '--objective') || undefined, priority: priority(args), executionMode: executionMode(args), schedule: initialSchedule, autoMerge: !hasArg(args, '--no-auto-merge'), reviewEnabled: !hasArg(args, '--no-review'), prNumber: Number(arg(args, '--pr', '0')), repository: arg(args, '--repo'), continuation: continuation(args), createdAt: now, updatedAt: now, tasks: [] }, { activate: Boolean(initialSchedule) });
    const store = new InMemoryStore(job); await store.saveJob(job); await saveLocal(file, job); console.log(`Initialized ${job.id}`); return;
  }
  if (command === 'status') {
    const host = arg(args, '--host', '127.0.0.1');
    const port = Number(arg(args, '--port', String(SERVICE_DEFAULTS.port)));
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
    let response: Response;
    try { response = await fetch(`http://${host}:${port}/api/runtime-summary`); }
    catch (error) { throw new Error(`Agents Relay service unavailable at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`); }
    if (!response.ok) throw new Error(`Agents Relay status request failed: HTTP ${response.status}`);
    console.log(JSON.stringify(await response.json(), null, 2));
    return;
  }
  if (!arg(args, '--file') && ['plan','reconcile','record','agent-register','agent-discover'].includes(command)) {
    const jobId = arg(args, '--id'); if (!jobId) throw new Error(`${command} requires --repo and --id`);
    if (command === 'plan') { const guidance = hasArg(args, '--prompt') || hasArg(args, '--prompt-file') ? await textOption(args, '--prompt', '--prompt-file') : undefined; console.log(JSON.stringify(await relayControlCommand(args, { command: 'job.plan', jobId, ...(guidance?.trim() ? { guidance: guidance.trim() } : {}) }), null, 2)); return; }
    if (command === 'reconcile') { console.log(JSON.stringify(await relayControlCommand(args, { command: 'job.reconcile', jobId }), null, 2)); return; }
    if (command === 'record') {
      const now = new Date().toISOString(); const id = arg(args, '--task-id', randomUUID()); const summary = arg(args, '--summary'); if (!summary) throw new Error('record requires --summary'); const commit = arg(args, '--commit');
      const task: Task = { jobId, id, projectName: arg(args, '--project') || undefined, agentName: arg(args, '--agent', 'orchestrator'), parentTaskId: arg(args, '--parent') || null, dependencies: arg(args, '--deps').split(',').filter(Boolean), capabilities: [], adapter: 'orchestrator', input: arg(args, '--input', summary), continuation: null, continuationDeliveredAt: null, state: 'SUCCEEDED', attempt: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: commit || null, threadId: null, result: { summary, data: commit ? { commit } : undefined }, error: null, timeoutMs: 0, createdAt: now, updatedAt: now };
      const updated = await relayControlCommand<Job>(args, { command: 'record', jobId, task }); console.log(JSON.stringify(updated.tasks.find(item => item.id === id), null, 2)); return;
    }
    if (command === 'agent-register') {
      const now = new Date().toISOString(); const agent: AgentRegistration = { id: arg(args, '--agent-id', randomUUID()), name: arg(args, '--name'), responsibility: arg(args, '--responsibility'), role: arg(args, '--role'), capabilities: arg(args, '--capabilities').split(',').filter(Boolean), boundaries: arg(args, '--boundaries').split('|').filter(Boolean), endpoint: { kind: arg(args, '--endpoint-kind', 'adapter') as 'adapter' | 'command' | 'http', target: arg(args, '--endpoint') }, runtime: { adapter: arg(args, '--runtime', arg(args, '--adapter', 'shell')), provider: arg(args, '--provider') || undefined, model: arg(args, '--model') || undefined }, availability: arg(args, '--availability', 'available') as AgentRegistration['availability'], routing: { labels: arg(args, '--labels').split(',').filter(Boolean).reduce<Record<string, string>>((out, item) => { const [key, value] = item.split('=', 2); if (key && value) out[key] = value; return out; }, {}), trustDomains: arg(args, '--trust-domains').split(',').filter(Boolean), regions: arg(args, '--regions').split(',').filter(Boolean) }, evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: null }, registeredAt: now, updatedAt: now };
      if (!agent.name || !agent.responsibility || !agent.role || !agent.endpoint.target) throw new Error('--name, --responsibility, --role, and --endpoint are required'); console.log(JSON.stringify(await relayControlCommand(args, { command: 'agent.register', jobId, agent }), null, 2)); return;
    }
    if (command === 'agent-discover') { const requirements = { capabilities: arg(args, '--capabilities').split(',').filter(Boolean), runtime: arg(args, '--runtime') || undefined, availability: arg(args, '--availability').split(',').filter(Boolean) as AgentRegistration['availability'][], trustDomain: arg(args, '--trust-domain') || undefined, taskKind: arg(args, '--task-kind') || undefined, explore: args.includes('--explore') }; console.log(JSON.stringify(await relayControlCommand(args, { command: 'agent.discover', jobId, requirements }), null, 2)); return; }
  }
  const loaded = await storeFor(args); const { store, job, localFile } = loaded;
  if (command === 'plan') {
    const guidance = hasArg(args, '--prompt') || hasArg(args, '--prompt-file') ? await textOption(args, '--prompt', '--prompt-file') : undefined;
    await withEventBus(args, async bus => {
      const reconciler = runtime(store, args, bus);
      try {
        const result = await reconciler.planJob(job.id, guidance?.trim() || undefined);
        await saveLocal(localFile, result.job); await publishWake(bus, result.job, result.round.id, `Planning round ${result.round.id} completed`);
        console.log(JSON.stringify(result.round, null, 2));
      } finally { await reconciler.close(); await shutdownOwnedProcesses('parent-shutdown'); }
    });
    return;
  }
  if (command === 'agent-register') {
    const now = new Date().toISOString();
    const agent: AgentRegistration = { id: arg(args, '--agent-id', randomUUID()), name: arg(args, '--name'), responsibility: arg(args, '--responsibility'), role: arg(args, '--role'), capabilities: arg(args, '--capabilities').split(',').filter(Boolean), boundaries: arg(args, '--boundaries').split('|').filter(Boolean), endpoint: { kind: arg(args, '--endpoint-kind', 'adapter') as 'adapter' | 'command' | 'http', target: arg(args, '--endpoint') }, runtime: { adapter: arg(args, '--runtime', arg(args, '--adapter', 'shell')), provider: arg(args, '--provider') || undefined, model: arg(args, '--model') || undefined }, availability: arg(args, '--availability', 'available') as AgentRegistration['availability'], routing: { labels: arg(args, '--labels').split(',').filter(Boolean).reduce<Record<string, string>>((out, item) => { const [key, value] = item.split('=', 2); if (key && value) out[key] = value; return out; }, {}), trustDomains: arg(args, '--trust-domains').split(',').filter(Boolean), regions: arg(args, '--regions').split(',').filter(Boolean) }, evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: null }, registeredAt: now, updatedAt: now };
    if (!agent.name || !agent.responsibility || !agent.role || !agent.endpoint.target) throw new Error('--name, --responsibility, --role, and --endpoint are required');
    await store.saveAgent(agent); console.log(`Registered ${agent.id}`); return;
  }
  if (command === 'agent-discover') { const candidates = discoverAgents(await store.listAgents(), { capabilities: arg(args, '--capabilities').split(',').filter(Boolean), runtime: arg(args, '--runtime') || undefined, availability: arg(args, '--availability').split(',').filter(Boolean) as AgentRegistration['availability'][], trustDomain: arg(args, '--trust-domain') || undefined, taskKind: arg(args, '--task-kind') || undefined, explore: args.includes('--explore') }); console.log(JSON.stringify(candidates, null, 2)); return; }
  if (command === 'record') {
    const now = new Date().toISOString(); const id = arg(args, '--task-id', randomUUID()); const summary = arg(args, '--summary');
    if (!summary) throw new Error('record requires --summary');
    const commit = arg(args, '--commit');
    const task: Task = { jobId: job.id, id, projectName: arg(args, '--project') || undefined, agentName: arg(args, '--agent', 'orchestrator'), parentTaskId: arg(args, '--parent') || null, dependencies: arg(args, '--deps').split(',').filter(Boolean), capabilities: [], adapter: 'orchestrator', input: arg(args, '--input', summary), continuation: null, continuationDeliveredAt: null, state: 'SUCCEEDED', attempt: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: commit || null, threadId: null, result: { summary, data: commit ? { commit } : undefined }, error: null, timeoutMs: 0, createdAt: now, updatedAt: now };
    await store.appendTask(task); job.tasks.push(task); await saveLocal(localFile, job); console.log(`Recorded ${id}`); return;
  }
  if (command === 'serve') { await startService(args); return; }
  if (command === 'reconcile') {
    await withEventBus(args, async bus => {
      if (!localFile && !noGitHubMode(args)) {
        await requestManagedReconciliation(bus, job);
        console.log(JSON.stringify(await store.load(job.id), null, 2));
        return;
      }
      const reconciler = runtime(store, args, bus);
      try {
        await reconciler.reconcile(job.id); await reconciler.idle();
        const finalState = await store.load(job.id); await saveLocal(localFile, finalState);
        console.log(JSON.stringify(finalState, null, 2));
      } finally { await reconciler.close(); await shutdownOwnedProcesses('parent-shutdown'); }
    });
    return;
  }
  throw new Error(usage);
}
if (isEntrypoint(import.meta.url)) void runCliEntrypoint(main, { serve: process.argv[2] === 'serve' });
