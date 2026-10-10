#!/usr/bin/env node
import type { Job } from './types.js';
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
import { dashboardJobAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { eventBusResolutionMessage, publishOrchestratorTaskStarted, publishOrchestratorTaskCompletion, publishTaskUnblocked, resolveEventBus } from './cli-support.js';
import { eventFor } from './events.js';
import { dispatchTaskAction } from './task-actions.js';
import { isEffectivelyBlocked, unblockAutonomousTasks, unblockTask } from './unblock.js';
import { registerBlockerDependency } from './blockers.js';
import { ensureManagedGitHubJob } from './cli-job-create.js';
import { applyJobActivateAction } from './job-actions.js';
import { applyOrchestratorStartAction, applyOrchestratorCompleteAction } from './task-actions.js';
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

export function createDashboardActions(deps: any) {
  const { getOverviews, requireLocalJobBinding, pool, dashboardJobAction, makeReconciler, concurrency, dashboardJobSetState, refreshAll, applyJobActivateAction, applyOrchestratorStartAction, applyOrchestratorCompleteAction, publishOrchestratorTaskStarted, publishOrchestratorTaskCompletion, bus, dashboardTaskAction, dashboardTaskSetState } = deps;
  const currentOverviews = (): ManagedJobOverview[] => getOverviews();
  const dashboardOverview = (jobId: string, target?: { repository?: string; prNumber?: number }) =>
    currentOverviews().find((item: {job: Job}) => item.job.id === jobId
      && (!target?.repository || item.job.repository === target.repository)
      && (!target?.prNumber || (item.job.externalPrNumber ?? item.job.prNumber) === target.prNumber));
  const workspaceJobAction = (action: 'start' | 'reconcile' | 'cancel') => async (jobId: string) => {
    const overview = currentOverviews().find((item: {job: Job}) => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    if (action === 'reconcile') {
      await pool.reconcileLocalJob(jobId, 'control.job.reconcile');
      return await store.load(jobId);
    }
    return await dashboardJobAction(store, makeReconciler(store, concurrency), action)(jobId);
  };
  const workspaceJobSetState = async (jobId: string, state: import('./types.js').JobLifecycleState, target?: { repository?: string; prNumber?: number }) => {
    const overview = dashboardOverview(jobId, target);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const result = await dashboardJobSetState(store)(jobId, state);
    await refreshAll();
    return result;
  };
  const workspaceTaskCreate = async (jobId: string, task: import('./types.js').Task) => {
    const overview = currentOverviews().find((item: {job: Job}) => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    if (task.jobId !== jobId) throw new Error(`Task ${task.id} belongs to ${task.jobId}, not ${jobId}`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const job = await store.load(jobId);
    if (['COMPLETED', 'CANCELLED'].includes(job.state)) throw new Error(`Cannot create task on terminal job ${job.id} (${job.state})`);
    if (store.mutateJob) {
      await store.mutateJob(jobId, (current: Job) => {
        if (['COMPLETED', 'CANCELLED'].includes(current.state)) throw new Error(`Cannot create task on terminal job ${current.id}`);
        if (current.tasks.some((item: import('./types.js').Task) => item.id === task.id)) throw new Error(`Task ${task.id} already exists`);
        current.tasks.push(structuredClone(task));
        if (current.state === 'DRAFT') applyJobActivateAction(current);
        current.updatedAt = new Date().toISOString();
        return current;
      });
    } else {
      await store.appendTask(task);
      const refreshed = await store.load(jobId);
      if (refreshed.state === 'DRAFT') { await applyJobActivateAction(refreshed); await store.saveJob(refreshed); }
    }
    await pool.reconcileLocalJob(jobId, 'control.task.create');
    return await store.load(jobId);
  };
  const workspaceTaskStart = async (jobId: string, taskId: string) => {
    const overview = currentOverviews().find((item: {job: Job}) => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const job = await store.load(jobId);
    const task = job.tasks.find((item: import('./types.js').Task) => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await applyOrchestratorStartAction(task);
    await store.saveTask(task);
    await publishOrchestratorTaskStarted(bus, job, task);
    await pool.reconcileLocalJob(jobId, 'control.task.start');
    return await store.load(jobId);
  };
  const workspaceTaskComplete = async (jobId: string, taskId: string, summary: string) => {
    const overview = currentOverviews().find((item: {job: Job}) => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const job = await store.load(jobId);
    const task = job.tasks.find((item: import('./types.js').Task) => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await applyOrchestratorCompleteAction(task, summary);
    await store.saveTask(task);
    await publishOrchestratorTaskCompletion(bus, job, task, summary);
    await pool.reconcileLocalJob(jobId, 'control.task.complete');
    return await store.load(jobId);
  };
  const workspaceTaskAction = (action: 'retry' | 'cancel') => async (jobId: string, taskId: string) => {
    const overview = currentOverviews().find((item: {job: Job}) => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    return await dashboardTaskAction(store, makeReconciler(store, concurrency), action)(jobId, taskId);
  };
  const workspaceTaskSetState = async (jobId: string, taskId: string, state: import('./types.js').TaskState, target?: { repository?: string; prNumber?: number }) => {
    const overview = dashboardOverview(jobId, target);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const result = await dashboardTaskSetState(store)(jobId, taskId, state);
    await refreshAll();
    return result;
  };

 return {dashboardOverview,workspaceJobAction,workspaceJobSetState,workspaceTaskCreate,workspaceTaskStart,workspaceTaskComplete,workspaceTaskAction,workspaceTaskSetState};
}
