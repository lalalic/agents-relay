import type { Job, Task } from './types.js';
import {consumeMethodInjection,withTestInjection} from './e2e-injection.js';
import { once } from 'node:events';
import { spawnOwnedProcess } from './owned-process.js';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatGptAdapter, CodexAdapter, ensureChatGptBrowserWorkspace } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { RepositoryWorkerPool } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GitHubStore, InMemoryStore, ManagedJobOverview, resolvePullRequest, type DurableStore, type ManagedGitHubPullRequestSnapshot } from './store.js';
import { GitHubProjectionWriter } from './projected-store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { discoverLocalRelayStoreSnapshots, relayStorePath, SQLiteRelayStore } from './relay-store.js';
import { createJobIdRegistryResolver } from './local-job-registry.js';
import { projectAuthoritativeLocalMerge } from './local-merge-projection.js';
import { archiveDisplayPullRequest } from './github-pr-archive.js';
import { orderGitHubBindingCandidates } from './github-binding-order.js';
import { githubAuthContext } from './github-auth.js';
import { GhApiClient } from './github-client.js';
import { DisabledGitHubClient, noGitHubMode } from './no-github.js';
import { basename } from 'node:path';
import { normalizeThreadId } from './reviewer-thread.js';
import { dashboardJobAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { eventBusResolutionMessage, publishTaskUnblocked, resolveEventBus } from './cli-support.js';
import { eventFor } from './events.js';
import { dispatchTaskAction } from './task-actions.js';
import { isEffectivelyBlocked, unblockAutonomousTasks, unblockTask } from './unblock.js';
import { registerBlockerDependency } from './blockers.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
import { applyJobActivateAction } from './job-actions.js';
import { managedTaskUpdateHandler } from './task-update.js';
import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories, ensureLocalJobSourceBranch, prepareLocalJobExecutionWorktree, resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { createRuntimeStatusPublisher } from './runtime-status-events.js';
import { subscribeLocalCommits } from './local-commit-events.js';
import { decisionMode, executionDecisionEngine } from './decision.js';
import { JsonlDecisionAuditStore } from './decision-audit.js';
import { summarizeRuntime } from './runtime-summary.js';
import { executionRouterRulesPath } from './routing-policy.js';
import { workerCandidates } from './worker-routing.js';
import { discoverAgents } from './registry.js'; import { shutdownOwnedProcesses } from './owned-process.js';
import { routeExecution } from './execution-routing.js';
import { RelayObservability, classifyFailure, errorMessage, observability, setObservability } from './observability.js';

export function createWorkspaceControl(deps: any) {
  const { client, trusted, noGitHub, repositories, refreshAll, requireLocalJobBinding, makeReconciler, concurrency, pool, bus, isEffectivelyBlocked, unblockAutonomousTasks, unblockTask, publishTaskUnblocked, dispatchTaskAction, registerBlockerDependency, discoverAgents, ensureManagedGitHubJob } = deps;
  const workspaceControl = async (body: Record<string, unknown>): Promise<unknown> => {
    const command = typeof body.command === 'string' ? body.command : '';
    const jobId = typeof body.jobId === 'string' ? body.jobId : '';
    if (!command) throw new Error('control command is required');

    if (command === 'job.create') {
      const repository = typeof body.repository === 'string' ? body.repository : '';
      const options = (body.options && typeof body.options === 'object' ? body.options : {}) as Record<string, unknown>;
      if (!repository) throw new Error('job.create requires repository');
      const result = await ensureManagedGitHubJob(client, repository, trusted, {
        id: typeof options.id === 'string' && options.id ? options.id : undefined,
        idempotencyKey: typeof options.idempotencyKey === 'string' ? options.idempotencyKey : undefined,
        title: typeof options.title === 'string' ? options.title : undefined,
        objective: typeof options.objective === 'string' ? options.objective : undefined,
        projectPath: typeof options.projectPath === 'string' ? options.projectPath : undefined,
        priority: options.priority as import('./types.js').Priority | undefined,
        executionMode: options.executionMode as import('./types.js').ExecutionMode | undefined,
        schedule: options.schedule as import('./types.js').Job['schedule'] | undefined,
        tag: options.tag as import('./types.js').Job['tag'] | undefined,
        reviewEnabled: typeof options.reviewEnabled === 'boolean' ? options.reviewEnabled : undefined,
        continuation: options.continuation as import('./types.js').Job['continuation'] | undefined,
        prNumber: typeof options.prNumber === 'number' ? options.prNumber : undefined,
        head: typeof options.head === 'string' ? options.head : undefined,
        base: typeof options.base === 'string' ? options.base : undefined,
        body: typeof options.body === 'string' ? options.body : undefined,
        reviewerThreadId: typeof options.reviewerThreadId === 'string' ? options.reviewerThreadId : undefined,
        creatorThreadId: typeof options.creatorThreadId === 'string' ? options.creatorThreadId : undefined,
        implementationThreadId: typeof options.implementationThreadId === 'string' ? options.implementationThreadId : undefined,
        noGitHub,
        localMergeSource: typeof options.localMergeSource === 'string' ? options.localMergeSource : undefined,
        localMergeTarget: typeof options.localMergeTarget === 'string' ? options.localMergeTarget : undefined,
      });
      if (!repositories.includes(repository)) repositories.push(repository);
      await refreshAll();
      if (body.initialPlan === true) {
        const binding = await requireLocalJobBinding(result.job.id);
        const current = await binding.store.load(result.job.id);
        const existingPlan = current.plans?.at(-1);
        if (existingPlan) return { repository, pr: result.pr.number, job: current.id, executionMode: current.executionMode, state: current.state, initialPlan: existingPlan.id, reused: true };
        const reconciler = makeReconciler(binding.store, concurrency);
        try {
          const planned = await reconciler.planJob(result.job.id);
          await pool.reconcileLocalJob(result.job.id, 'control.job.create.initial-plan');
          return { repository, pr: result.pr.number, job: result.job.id, executionMode: result.job.executionMode, state: result.job.state, initialPlan: planned.round.id };
        } finally { await reconciler.close(); }
      }
      return { repository, pr: result.pr.number, job: result.job.id, executionMode: result.job.executionMode, state: result.job.state };
    }

    if (!jobId) throw new Error(command + ' requires jobId');
    const binding = await requireLocalJobBinding(jobId);
    const store = binding.store;
    const job = await store.load(jobId);

    if (command === 'job.update') {
      const patch = (body.patch && typeof body.patch === 'object' ? body.patch : {}) as Record<string, unknown>;
      const mutable = ['title','objective','projectPath','priority','executionMode','schedule','tag','autoMerge','reviewEnabled','reviewerThreadId','creatorThreadId','implementationThreadId','continuation','localMerge'] as const;
      for (const key of mutable) if (Object.prototype.hasOwnProperty.call(patch, key)) {
        const value = patch[key];
        if (['reviewerThreadId', 'creatorThreadId', 'implementationThreadId'].includes(key)) {
          (job as unknown as Record<string, unknown>)[key] = value === undefined || value === null ? undefined : normalizeThreadId(value, `Job ${key}`);
        } else (job as unknown as Record<string, unknown>)[key] = value;
      }
      job.updatedAt = new Date().toISOString();
      await store.saveJob(job); await refreshAll(); return await store.load(jobId);
    }
    if (command === 'job.plan') {
      const reconciler = makeReconciler(store, concurrency);
      try { const planned = await reconciler.planJob(jobId, typeof body.guidance === 'string' && body.guidance.trim() ? body.guidance : undefined); await pool.reconcileLocalJob(jobId, 'control.job.plan'); return planned.round; }
      finally { await reconciler.close(); }
    }
    if (command === 'job.unblock') {
      const reason = typeof body.reason === 'string' ? body.reason : '';
      if (!reason.trim()) throw new Error('job unblock requires reason');
      const blocked = job.tasks.filter(isEffectivelyBlocked);
      if (!blocked.length) throw new Error(`Job ${job.id} has no effective BLOCKED work task`);
      if (job.executionMode === 'autonomous') await unblockAutonomousTasks({ store, job, tasks: blocked, trigger: { source: 'cli', reason } });
      else for (const task of blocked) await unblockTask({ store, job, task, trigger: { source: 'cli', reason } });
      const refreshed = await store.load(jobId);
      for (const task of blocked) await publishTaskUnblocked(bus, refreshed, task.id, reason);
      await pool.reconcileLocalJob(jobId, 'control.job.unblock');
      return await store.load(jobId);
    }
    if (command === 'task.recover') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : '';
      const recoveryTaskId = typeof body.recoveryTaskId === 'string' ? body.recoveryTaskId : '';
      if (!taskId || !recoveryTaskId) throw new Error('task recover requires taskId and recoveryTaskId');
      await dispatchTaskAction(store, { id: 'task.recover', jobId, taskId, recoveryTaskId });
      await pool.reconcileLocalJob(jobId, 'control.task.recover'); return await store.load(jobId);
    }
    if (command === 'task.unblock') {
      const taskId = typeof body.taskId === 'string' ? body.taskId : ''; const reason = typeof body.reason === 'string' ? body.reason : '';
      const task = job.tasks.find((item: {id: string}) => item.id === taskId); if (!task) throw new Error(`Task ${taskId} not found`);
      await unblockTask({ store, job, task, trigger: { source: 'cli', reason } });
      const refreshed = await store.load(jobId); await publishTaskUnblocked(bus, refreshed, taskId, reason);
      await pool.reconcileLocalJob(jobId, 'control.task.unblock'); return await store.load(jobId);
    }
    if (command === 'review.request') {
      if (job.state === 'CANCELLED' || job.state === 'COMPLETED') throw new Error('Cannot request review for terminal Job');
      if (!job.reviewEnabled) throw new Error('Review disabled for this Job');
      if (typeof body.threadId === 'string') { job.reviewerThreadId = body.threadId; job.updatedAt = new Date().toISOString(); await store.saveJob(job); }
      await pool.reconcileLocalJob(jobId, 'control.review.request'); return await store.load(jobId);
    }
    if (command === 'blocker.add') {
      const dependentJobId = typeof body.dependentJobId === 'string' ? body.dependentJobId : '';
      const dependentTaskId = typeof body.dependentTaskId === 'string' ? body.dependentTaskId : '';
      const dependent = await requireLocalJobBinding(dependentJobId);
      const relation = await registerBlockerDependency({ blockerStore: store, blockerJobId: jobId, dependentStore: dependent.store, dependentJobId, dependentTaskId, resolutionMode: body.resolutionMode === 'verified' ? 'verified' : 'merge' });
      // Registering a blocker is itself runnable-work creation. Wake the blocker
      // Job immediately instead of waiting for inventory polling/stale rescue.
      await pool.reconcileLocalJob(jobId, 'control.blocker.add');
      await refreshAll(); return relation;
    }
    if (command === 'blocker.resolve') {
      if (!store.resolveBlockerDependents) throw new Error('Blocker resolution unavailable');
      const summary = await store.resolveBlockerDependents(jobId, body.resolution === 'merge' ? 'merge' : 'verified');
      for (const target of summary.unblocked) await pool.reconcileLocalJob(target.jobId, 'control.blocker.resolve');
      await refreshAll(); return summary;
    }
    if (command === 'projection.conflicts') return await binding.relay.listProjectionConflicts();
    if (command === 'job.reconcile') { await pool.reconcileLocalJob(jobId, 'control.job.reconcile'); return await store.load(jobId); }
    if (command === 'agent.discover') {
      return discoverAgents(await store.listAgents(), (body.requirements && typeof body.requirements === 'object' ? body.requirements : {}) as Parameters<typeof discoverAgents>[1]);
    }
    if (command === 'projection.resolve') {
      const id = Number(body.projectionId); const action = body.action === 'discard_local' ? 'discard_local' : 'requeue';
      if (!Number.isInteger(id) || id <= 0) throw new Error('projection resolve requires projectionId');
      const resolved = await binding.relay.resolveProjectionConflict(id, { action, ...(typeof body.note === 'string' && body.note ? { note: body.note } : {}) });
      if (!resolved) throw new Error(`Projection ${id} is not in a resolvable conflict state`); return { resolved: id, action };
    }
    if (command === 'record') {
      const task = body.task as import('./types.js').Task | undefined; if (!task || task.jobId !== jobId) throw new Error('record requires a task for this Job');
      await store.appendTask(task); await pool.reconcileLocalJob(jobId, 'control.record'); return await store.load(jobId);
    }
    if (command === 'agent.register') {
      const agent = body.agent as import('./types.js').AgentRegistration | undefined; if (!agent) throw new Error('agent.register requires agent');
      await store.saveAgent(agent); return agent;
    }
    throw new Error('Unsupported control command ' + command);
  };
  return workspaceControl;
}
