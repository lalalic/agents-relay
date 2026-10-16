#!/usr/bin/env node
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
import { discoverLocalRelayStoreSnapshots, SQLiteRelayStore } from './relay-store.js';
import { createJobIdRegistryResolver } from './local-job-registry.js';
import { projectAuthoritativeLocalMerge } from './local-merge-projection.js';
import { archiveDisplayPullRequest } from './github-pr-archive.js';
import { orderGitHubBindingCandidates } from './github-binding-order.js';
import { githubAuthContext } from './github-auth.js';
import { GhApiClient } from './github-client.js';
import { DisabledGitHubClient, noGitHubMode } from './no-github.js';
import { basename } from 'node:path';
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
export interface DaemonArguments { repository: string | null; workspaceRoot: string | null; pullRequest: number | null; jobId: string | null; serviceArguments: string[]; }
/** Initialize the process-wide structured observability sink once, from environment. */
export function configureDaemonObservability(env: NodeJS.ProcessEnv = process.env): RelayObservability {
  const configured = RelayObservability.fromEnvironment(env);
  setObservability(configured);
  return configured;
}
export type PullRequestRefreshTrigger = string;
export async function overlayOperationalOverviews(
  overviews: readonly ManagedJobOverview[],
  storeFor: (repository: string, prNumber: number) => DurableStore,
): Promise<ManagedJobOverview[]> {
  return await Promise.all(overviews.map(async item => {
    const store = storeFor(item.job.repository, item.job.prNumber) as DurableStore & { hydrate?: (job: import('./types.js').Job) => Promise<void> };
    await store.hydrate?.(item.job);
    const job = await store.load(item.job.id);
    return { ...item, job };
  }));
}
function managedOverviewKey(item: ManagedJobOverview): string {
  return item.job.repository + '#' + item.job.prNumber + ':' + item.job.id;
}
export function mergeOperationalInventory(
  current: readonly ManagedJobOverview[],
  discovered: readonly ManagedJobOverview[],
): ManagedJobOverview[] {
  const merged = new Map(current.map(item => [managedOverviewKey(item), item]));
  for (const item of discovered) merged.set(managedOverviewKey(item), item);
  return [...merged.values()];
}

export type GitHubReadPathDiagnostics = {
  workspaceScans: number;
  prRefreshes: number;
  prRefreshesByTrigger: Record<string, number>;
  prRefreshCoalesced: number;
  prRefreshCoalescedByTrigger: Record<string, number>;
};
const PR_REFRESH_COALESCE_MS = 1000;
export const SCHEDULE_HEARTBEAT_MS = 600_000;
export function dueScheduledOverviews(overviews: readonly ManagedJobOverview[], now = new Date()): ManagedJobOverview[] {
  return overviews.filter(item => item.job.state === 'ACTIVE' && item.job.executionMode === 'autonomous' && item.job.schedule && Date.parse(item.job.schedule.nextRunAt) <= now.getTime());
}
export function shouldCoalescePullRequestRefresh(completedAt: number | null, now = Date.now(), force = false): boolean {
  return !force && completedAt !== null && now >= completedAt && now - completedAt < PR_REFRESH_COALESCE_MS;
}
export const daemonHelp = `Agents Relay daemon runs the dashboard and worker pool.

Usage:
  npx agents-relayd [options]

Options:
  --no-github             Local-only mode: no GitHub auth, transport, PR, merge, or fetch
  --repo OWNER/REPO       Watch one repository
  --workspace PATH        Discover repositories below PATH (default: ~/Workspace)
  --port PORT             Dashboard port (default: 8787)
  --concurrency N         Maximum concurrent workers (default: 4)
  --interval MS           Recovery interval
  --projection-ms MS      GitHub projection flush interval (default: 1000)
  --execution-router-rules PATH
                         Router Rules file (default: ~/.agents-relay/execution-router-rules.md)
  --events nats            Require NATS event wakeups (otherwise auto-detect reachable NATS)

Legacy single-job mode also accepts --repo OWNER/REPO --pr NUMBER --id JOB_ID.

Examples:
  npx agents-relayd --repo OWNER/REPO
  npx agents-relayd --workspace ~/Workspace`;
export function firstStageChoices(decisionInput: Record<string, unknown> | undefined): string[] {
  const stages = decisionInput?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return [];
  const contract = (stages[0] as { contract?: { choices?: unknown } }).contract;
  return Array.isArray(contract?.choices) ? contract.choices.filter((item): item is string => typeof item === 'string') : [];
}

export function value(args: readonly string[], name: string, fallback = ''): string { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; }
export function normalizeDaemonArguments(argv: readonly string[]): DaemonArguments {
  const repository = value(argv, '--repo') || null;
  const workspaceRoot = value(argv, '--workspace', defaultWorkspaceRoot()) || null;
  const prValue = value(argv, '--pr'); const id = value(argv, '--id');
  if ((prValue && !id) || (!prValue && id)) throw new Error('--pr and --id must be supplied together for legacy single-job mode');
  if ((prValue || id) && !repository) throw new Error('--repo is required for legacy single-job mode');
  if (repository && argv.includes('--workspace')) throw new Error('--repo and --workspace are mutually exclusive');
  const pullRequest = prValue ? Number(prValue) : null; if (pullRequest !== null && (!Number.isInteger(pullRequest) || pullRequest <= 0)) throw new Error('--pr must be positive');
  return { repository, workspaceRoot: repository ? null : workspaceRoot, pullRequest, jobId: id || null, serviceArguments: [...argv] };
}

export function recoveryScanRepositories(repositories: readonly string[], cached: readonly ManagedJobOverview[], dormantProbeIndex = 0): string[] {
  const byRepository = new Map<string, ManagedJobOverview[]>();
  for (const item of cached) {
    const values = byRepository.get(item.job.repository) ?? []; values.push(item); byRepository.set(item.job.repository, values);
  }
  const activeOrUnknown: string[] = []; const dormant: string[] = [];
  for (const repository of repositories) {
    const values = byRepository.get(repository);
    if (!values || values.length === 0 || values.some(item => !['COMPLETED','CANCELLED'].includes(item.job.state))) activeOrUnknown.push(repository);
    else dormant.push(repository);
  }
  if (dormant.length === 0) return activeOrUnknown;
  return [...activeOrUnknown, dormant[Math.abs(dormantProbeIndex) % dormant.length]];
}

export function configureExecutionRouterRulesPath(argv: readonly string[]): string {
  const explicitRulesPath = value(argv, '--execution-router-rules') || undefined;
  if (explicitRulesPath) process.env.AGENTS_RELAY_EXECUTION_ROUTER_RULES = executionRouterRulesPath(explicitRulesPath);
  return executionRouterRulesPath();
}
