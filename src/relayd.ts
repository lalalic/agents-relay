#!/usr/bin/env node
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
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
import { githubAuthContext } from './github-auth.js';
import { GhApiClient } from './github-client.js';
import { DisabledGitHubClient, noGitHubMode } from './no-github.js';
import { basename } from 'node:path';
import { dashboardJobAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { eventBusResolutionMessage, publishOrchestratorTaskStarted, publishOrchestratorTaskCompletion, resolveEventBus } from './cli-support.js';
import { eventFor } from './events.js';
import { applyJobActivateAction } from './job-actions.js';
import { applyOrchestratorStartAction, applyOrchestratorCompleteAction } from './task-actions.js';
import { managedTaskUpdateHandler } from './task-update.js';
import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories, prepareLocalJobExecutionWorktree, resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { decisionMode, executionDecisionEngine } from './decision.js';
import { JsonlDecisionAuditStore } from './decision-audit.js';
import { summarizeRuntime } from './runtime-summary.js';
import { executionRouterRulesPath } from './routing-policy.js';
import { workerCandidates } from './worker-routing.js'; import { shutdownOwnedProcesses } from './owned-process.js';
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
function firstStageChoices(decisionInput: Record<string, unknown> | undefined): string[] {
  const stages = decisionInput?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return [];
  const contract = (stages[0] as { contract?: { choices?: unknown } }).contract;
  return Array.isArray(contract?.choices) ? contract.choices.filter((item): item is string => typeof item === 'string') : [];
}

function value(args: readonly string[], name: string, fallback = ''): string { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; }
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

export async function runDaemon(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(daemonHelp); return; }
  configureDaemonObservability();
  configureExecutionRouterRulesPath(argv);
  try {
    await ensureChatGptBrowserWorkspace();
  } catch (error) {
    process.stderr.write(`Browser Workspace bootstrap skipped: ${errorMessage(error)}\n`);
  }
  const noGitHub = noGitHubMode(argv);
  if (noGitHub) process.env.AGENTS_RELAY_NO_GITHUB = '1';
  const normalized = normalizeDaemonArguments(argv);
  if (normalized.pullRequest && normalized.jobId) { await startService([...argv]); return; }
  // Local authority never depends on GitHub availability, but every enabled
  // GitHub transport must use the same authenticated context as the CLI. Probe
  // identity separately so an auth outage is observable without blocking startup.
  const auth = noGitHub ? null : await githubAuthContext(argv, undefined, false);
  const client = noGitHub ? new DisabledGitHubClient() : auth!.client;
  const trusted = noGitHub ? new Set<string>() : auth!.trustedAuthors;
  let githubAuthenticated: boolean | null = noGitHub ? false : null;
  let githubAuthError: string | null = null;
  if (!noGitHub) {
    try { const login = auth?.appAuth ? await client.currentLogin() : await client.localLogin(); if (!login) throw new Error('gh authentication did not return a healthy login'); trusted.add(login); githubAuthenticated = true; }
    catch (error) { githubAuthenticated = false; githubAuthError = errorMessage(error); }
  }
  const concurrency = Number(value(argv,'--concurrency','4'));
  const eventResolution = await resolveEventBus([...argv]);
  const bus = eventResolution.bus;
  process.stderr.write(`${eventBusResolutionMessage(eventResolution)}\n`);
  const workspaceRoot = noGitHub ? (value(argv, '--project-path') || value(argv, '--workspace') || process.cwd())
    : normalized.workspaceRoot ?? defaultWorkspaceRoot();
  const discoveredRepositories = normalized.repository || noGitHub ? [] : await discoverWorkspaceRepositories(workspaceRoot).catch(() => []);
  const repositories = noGitHub && !normalized.repository ? [`local/${basename(workspaceRoot)}`] : normalized.repository ? [normalized.repository] : discoveredRepositories.map(item => item.repository);
  const repositoryPaths = new Map(discoveredRepositories.map(item => [item.repository, item.path]));
  if (noGitHub) for (const repo of repositories) repositoryPaths.set(repo, value(argv, '--project-path') || workspaceRoot);
  const explicitProjectPath = value(argv,'--project-path');
  const usageRegistry = codexAndZaiUsageRegistry();
  const decisionAuditStore = new JsonlDecisionAuditStore(process.env.AGENTS_RELAY_DECISION_AUDIT_PATH ?? join(homedir(), '.agents-relay', 'decision-audit.jsonl'));
  let cachedOverviews: ManagedJobOverview[] = [];
  const githubReadPaths: GitHubReadPathDiagnostics = { workspaceScans: 0, prRefreshes: 0, prRefreshesByTrigger: {}, prRefreshCoalesced: 0, prRefreshCoalescedByTrigger: {} };
  let dormantProbeIndex = 0;
  const relayStores = new Map<string, SQLiteRelayStore>();
  const projectionWriters = new Map<string, GitHubProjectionWriter>();
  const runtimeStore = (repository: string, prNumber: number, seed?: import('./store.js').GitHubPullRequestSeed | null): DurableStore => {
    const key = `${repository}#${prNumber}`;
    let relay = relayStores.get(key);
    if (!relay) {
      relay = new SQLiteRelayStore(relayStorePath(join(homedir(), '.agents-relay', 'stores'), repository, prNumber));
      relayStores.set(key, relay);
    }
    const github = new GitHubStore(client, repository, prNumber, trusted, seed);
    const projected = new LocalAuthorityDurableStore(relay, github, (relatedRepository, relatedPrNumber) => runtimeStore(relatedRepository, relatedPrNumber), noGitHub);
    // SQLite PR facts are written through awaited webhook/action handlers; never seed detached remote snapshots.
    if (!noGitHub) projectionWriters.set(key, projected.projection);
    return projected;
  };
  // SQLite inventory, not GitHub discovery, defines which repositories exist.
  const existingInventory = await discoverLocalRelayStoreSnapshots(join(homedir(), '.agents-relay', 'stores'));
  for (const snapshot of existingInventory) for (const job of snapshot.jobs) {
    if (!repositories.includes(job.repository)) repositories.push(job.repository);
  }
  if (repositories.length === 0) repositories.push('local/' + basename(workspaceRoot));
  const inventoryFromLocal = async (): Promise<ManagedJobOverview[]> => {
    const snapshots = await discoverLocalRelayStoreSnapshots(join(homedir(), '.agents-relay', 'stores'));
    const known = new Set(repositories);
    const entries = snapshots.flatMap(snapshot =>
      snapshot.jobs.filter(job => known.has(job.repository)).map(job => ({
        job, githubState: snapshot.facts?.state ?? 'UNKNOWN' as const,
        draft: false, mergedAt: null, closedAt: null, publication: snapshot.publications[job.id]?.latest ?? null, publicationFailure: snapshot.publications[job.id]?.failure ?? null,
      })));
    const counts = new Map<string, number>();
    for (const item of entries) if (!['COMPLETED','CANCELLED'].includes(item.job.state))
      counts.set(item.job.id, (counts.get(item.job.id) ?? 0) + 1);
    // Hide obsolete terminal snapshots only when one live authoritative Job exists.
    // Multiple live copies remain visible for diagnosis but cannot be mutated.
    return dashboardManagedJobs(entries.filter(item =>
      !['COMPLETED','CANCELLED'].includes(item.job.state) || counts.get(item.job.id) !== 1));
  };
  cachedOverviews = await inventoryFromLocal();
  const makeReconciler = (store: DurableStore, maxConcurrent: number) => new Reconciler(store,{ noGitHub, owner:`relayd-${process.pid}`, maxConcurrent, leaseMs:Number(value(argv,'--lease-ms','300000')), adapters:[new CodexAdapter(value(argv,'--codex','codex')),new ChatGptAdapter()], continuations:[new CodexThreadContinuation(value(argv,'--codex','codex')),new CommandContinuation(),new WebhookContinuation()], planner:runtimePlanner(argv), usageSnapshotProvider: () => usageRegistry.snapshot(), runtimeSummaryProvider: () => ({ chatgptRunning: summarizeRuntime(cachedOverviews.map(item => item.job)).workers.chatgpt }), decisionEngine:executionDecisionEngine(), decisionMode:decisionMode(), decisionAuditStore, eventBus:bus, reviewer:runtimeReviewer(argv), projectPathForJob: async job => { const canonical = repositoryPaths.get(job.repository) ?? await resolveManagedProjectPath(job.repository, explicitProjectPath, workspaceRoot); return job.prNumber === 0 && job.localMerge?.sourceRef ? prepareLocalJobExecutionWorktree(canonical, job, workspaceRoot) : resolveRepositoryProjectPath(canonical, job.projectPath); } });
  const refreshAll = async (_full = false): Promise<ManagedJobOverview[]> => {
    cachedOverviews = await inventoryFromLocal();
    return cachedOverviews;
  };
  const overviews = async (_forceRefresh = false, _trigger = 'internal.unknown'): Promise<ManagedJobOverview[]> => refreshAll();
  const refreshPullRequestSnapshot = async (repository: string, prNumber: number, _trigger: PullRequestRefreshTrigger = 'internal', _options: { force?: boolean } = {}): Promise<ManagedGitHubPullRequestSnapshot> => {
    const inventory = await refreshAll();
    return {
      overviews: inventory.filter(item => item.job.repository === repository && item.job.prNumber === prNumber),
      seed: { prNode: {}, comments: null },
    };
  };
  const refreshPullRequest = async (repository: string, prNumber: number, trigger: PullRequestRefreshTrigger, options?: { force?: boolean }): Promise<ManagedJobOverview[]> =>
    (await refreshPullRequestSnapshot(repository, prNumber, trigger, options)).overviews;
  const localJobBinding = createJobIdRegistryResolver(join(homedir(), '.agents-relay', 'stores'), relayStores, { client, trustedAuthors: trusted, noGitHub });
  const requireLocalJobBinding = async (jobId: string) => {
    const binding = await localJobBinding(jobId);
    if (!binding) throw new Error('Local Job ' + jobId + ' not found or ambiguous in SQLite registry');
    return binding;
  };

  const gitText = (cwd: string, args: string[]): string => execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
  const syncGitHubBindings = async (): Promise<void> => {
    if (noGitHub || githubAuthenticated !== true) return;
    if (client.rateLimitStatus().limited) return;
    const snapshots = await discoverLocalRelayStoreSnapshots(join(homedir(), '.agents-relay', 'stores'));
    for (const snapshot of snapshots) for (const discovered of snapshot.jobs) {
      if (!repositoryPaths.has(discovered.repository) || !discovered.localMerge?.sourceRef || !discovered.localMerge?.targetRef) continue;
      const sourceRef = discovered.localMerge.sourceRef;
      const targetRef = discovered.localMerge.targetRef;
      if (!sourceRef.startsWith('refs/heads/') || !targetRef.startsWith('refs/heads/')) continue;
      const branch = sourceRef.slice('refs/heads/'.length), base = targetRef.slice('refs/heads/'.length);
      let relay = relayStores.get(snapshot.path);
      if (!relay) { relay = new SQLiteRelayStore(snapshot.path); relayStores.set(snapshot.path, relay); }
      const canonical = repositoryPaths.get(discovered.repository) ?? await resolveManagedProjectPath(discovered.repository, explicitProjectPath, workspaceRoot);
      const sourceSha = gitText(canonical, ['rev-parse', '--verify', sourceRef]);
      const facts = await relay.loadPullRequestFacts();
      if (facts?.head?.sha !== sourceSha) {
        gitText(canonical, ['push', 'origin', `${branch}:${branch}`]);
      }
      let job = (await relay.loadJob(discovered.id)) ?? discovered;
      let externalPrNumber = job.externalPrNumber ?? (job.prNumber > 0 ? job.prNumber : 0);
      if (externalPrNumber === 0 && ['COMPLETED','CANCELLED'].includes(job.state)) continue;
      if (externalPrNumber === 0) {
        const pr = await resolvePullRequest(client, job.repository, { head: branch, base, title: job.title, body: job.objective ?? job.description ?? '' });
        if (!relay.mutateJob) throw new Error('Atomic SQLite mutation is required for GitHub PR binding');
        job = await relay.mutateJob(job.id, current => ({ ...current, externalPrNumber: pr.number, updatedAt: new Date().toISOString() }));
        externalPrNumber = pr.number;
        observability().record({ stage: 'projection', event: 'github.pr_bound', outcome: 'succeeded', message: `Bound local Job ${job.id} to GitHub PR #${pr.number}`, correlation: { repository: job.repository, prNumber: pr.number, jobId: job.id }, data: { head: branch, base } });
      }
      if (externalPrNumber <= 0) continue;
      const latestFacts = await relay.loadPullRequestFacts();
      if (latestFacts?.state !== 'MERGED' && (latestFacts?.head?.sha !== sourceSha || latestFacts?.head?.ref !== branch)) {
        await relay.savePullRequestFacts({ state: latestFacts?.state === 'CLOSED' ? 'CLOSED' : 'OPEN', head: { ref: branch, sha: sourceSha }, observedAt: new Date().toISOString() });
      }
      const github = new GitHubStore(client, job.repository, externalPrNumber, trusted);
      projectionWriters.set(`job:${job.id}`, new GitHubProjectionWriter(relay, github, undefined, true));
      if (job.state === 'COMPLETED' && job.localMerge?.status === 'succeeded' && latestFacts?.state !== 'MERGED') {
        const projected = new LocalAuthorityDurableStore(relay, github, undefined, false);
        await projected.mergePullRequest(job.localMerge.sourceSha ?? sourceSha);
      }
    }
    cachedOverviews = await inventoryFromLocal();
  };
  const syncGitHubBindingsSafely = async (): Promise<void> => {
    try { await syncGitHubBindings(); }
    catch (error) { observability().record({ stage: 'projection', event: 'github.binding_sync_failed', level: 'warn', outcome: 'failed', message: `GitHub Job binding sync failed: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }); }
  };
  const pool = new RepositoryWorkerPool(
    concurrency,
    makeReconciler,
    inventoryFromLocal,
    localJobBinding,
  );
  const initial = cachedOverviews; const fallback = initial[0]?.job;
  const dashboardStore = fallback ? (await requireLocalJobBinding(fallback.id)).store : new InMemoryStore();
  const dashboardOverview = (jobId: string, target?: { repository?: string; prNumber?: number }) =>
    cachedOverviews.find(item => item.job.id === jobId
      && (!target?.repository || item.job.repository === target.repository)
      && (!target?.prNumber || item.job.prNumber === target.prNumber));
  const workspaceJobAction = (action: 'start' | 'reconcile' | 'cancel') => async (jobId: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
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
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    if (task.jobId !== jobId) throw new Error(`Task ${task.id} belongs to ${task.jobId}, not ${jobId}`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const job = await store.load(jobId);
    if (['COMPLETED', 'CANCELLED'].includes(job.state)) throw new Error(`Cannot create task on terminal job ${job.id} (${job.state})`);
    await store.appendTask(task);
    const refreshed = await store.load(jobId);
    if (refreshed.state === 'DRAFT') { await applyJobActivateAction(refreshed); await store.saveJob(refreshed); }
    await pool.reconcileLocalJob(jobId, 'control.task.create');
    return await store.load(jobId);
  };
  const workspaceTaskStart = async (jobId: string, taskId: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await applyOrchestratorStartAction(task);
    await store.saveTask(task);
    await publishOrchestratorTaskStarted(bus, job, task);
    await pool.reconcileLocalJob(jobId, 'control.task.start');
    return await store.load(jobId);
  };
  const workspaceTaskComplete = async (jobId: string, taskId: string, summary: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = (await requireLocalJobBinding(jobId)).store;
    const job = await store.load(jobId);
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    await applyOrchestratorCompleteAction(task, summary);
    await store.saveTask(task);
    await publishOrchestratorTaskCompletion(bus, job, task, summary);
    await pool.reconcileLocalJob(jobId, 'control.task.complete');
    return await store.load(jobId);
  };
  const workspaceTaskAction = (action: 'retry' | 'cancel') => async (jobId: string, taskId: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
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
  const secretFile = value(argv,'--github-webhook-secret-file');
  const secret = noGitHub ? '' : value(argv,'--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || (secretFile ? (await readFile(secretFile,'utf8')).trim() : '');
  const webhook = secret ? {
    secret,
    repositories: new Set(repositories),
    wake: async (event: GitHubWebhookWake): Promise<void> => {
      const targets = cachedOverviews.filter(item => item.job.repository === event.repository && (item.job.externalPrNumber ?? item.job.prNumber) === event.pullRequest);
      if (targets.length === 0) return;
      for (const target of targets) {
        const binding = await requireLocalJobBinding(target.job.id);
        const store = binding.store;
        if (event.pullRequestFacts && store.applyPullRequestFacts) {
          await store.applyPullRequestFacts({ ...event.pullRequestFacts,
            observedAt: event.pullRequestFacts.observedAt ?? new Date().toISOString() });
          target.githubState = await store.pullRequestState?.() ?? target.githubState;
        }
        if (event.publication || event.publishFailure) {
          const relay = binding.relay;
          try {
            const inserted = await relay.recordPublication(target.job.id, event.deliveryId, event.publication, event.publishFailure ?? null, event.publicationObservedAt);
            // Replayed webhook deliveries may retry EventBus delivery; SQLite state remains idempotent.
            const state = await relay.loadPublication(target.job.id);
            target.publication = state?.latest ?? null;
            target.publicationFailure = state?.failure ?? null;
          } finally { /* The SQLite registry owns the shared connection. */ }
        }
        // GitHub is an audit input only: no workflow or reconcile wake.
      }
      cachedOverviews = dashboardManagedJobs(cachedOverviews);
    }
  } : undefined;
  const exactJob = async (jobId: string, target?: { repository?: string; prNumber?: number }) => {
    let cached = dashboardOverview(jobId, target);
    if (!cached && target?.repository && target.prNumber && repositories.includes(target.repository)) {
      cached = (await refreshPullRequest(target.repository, target.prNumber, 'control.job-lookup', { force: true }))
        .find(item => item.job.id === jobId && item.job.repository === target.repository && item.job.prNumber === target.prNumber);
    }
    if (!cached) return null;
    const cachedJob = () => ({ ...cached.job, githubState: cached.githubState, runtimeStatus: deriveJobRuntimeStatus(cached.job, cached.githubState), mergedAt: cached.mergedAt, closedAt: cached.closedAt, draft: cached.draft, publication: cached.publication, publicationFailure: cached.publicationFailure });
    try {
      const refreshed = (await refreshPullRequest(cached.job.repository, cached.job.prNumber, 'dashboard.selected-job', { force: true })).find(item => item.job.id === jobId);
      if (!refreshed) return null;
      return { ...refreshed.job, githubState: refreshed.githubState, runtimeStatus: deriveJobRuntimeStatus(refreshed.job, refreshed.githubState), mergedAt: refreshed.mergedAt, closedAt: refreshed.closedAt, draft: refreshed.draft, publication: refreshed.publication, publicationFailure: refreshed.publicationFailure };
    } catch (error) {
      observability().record({ stage: 'daemon', event: 'daemon.refresh_failed', level: 'warn', outcome: 'failed', message: `Selected job refresh unavailable: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } });
      return cachedJob();
    }
  };
  const stopWatch = bus ? await pool.watch(bus) : async()=>{};
  const server = serveDashboard(dashboardStore,Number(value(argv,'--port',String(SERVICE_DEFAULTS.port))),bus,Number(value(argv,'--refresh-ms',String(SERVICE_DEFAULTS.dashboardRefreshMs))),fallback?.id,usageRegistry,overviews,webhook,()=>({ githubEnabled: !noGitHub, githubAuthenticated, githubAuthError, ...client.rateLimitStatus(), readPaths: { ...githubReadPaths } }),noGitHub ? undefined : () => client.rateLimitSnapshot(),exactJob, {
    start: workspaceJobAction('start'),
    reconcile: workspaceJobAction('reconcile'),
    cancel: workspaceJobAction('cancel'),
    jobSetState: workspaceJobSetState,
    taskCreate: workspaceTaskCreate,
    taskUpdate: managedTaskUpdateHandler(async jobId => {
      const binding = await requireLocalJobBinding(jobId);
      return { store: binding.store, repository: binding.job.repository, prNumber: binding.job.prNumber };
    }, async (_repository, _prNumber, jobId) => pool.reconcileLocalJob(jobId, 'control.task.update')),
    taskStart: workspaceTaskStart,
    taskRetry: workspaceTaskAction('retry'),
    taskCancel: workspaceTaskAction('cancel'),
    taskComplete: workspaceTaskComplete,
    taskSetState: workspaceTaskSetState,
  }, async ({ jobId, taskId }) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error('Selected Job '+jobId+' is not available');
    const job = overview.job;
    const task = job.tasks.find(item => item.id === taskId);
    if (!task) throw new Error('Selected Task '+taskId+' is not available in Job '+jobId);
    const usage = await usageRegistry.snapshot();
    const runtime = summarizeRuntime(cachedOverviews.map(item => item.job));
    const workers = workerCandidates([
      { name: 'codex', id: 'codex', capabilities: ['model', 'codex'] },
      { name: 'chatgpt', id: 'chatgpt/browser-worker', capabilities: ['model', 'chatgpt', 'browser-workspace'] },
    ], [], usage);
    const result = await routeExecution(workers, task.workerRequirements ?? { capabilities: task.capabilities ?? [] }, {
      decisionEngine: executionDecisionEngine(),
      decisionMode: 'active',
      taskFacts: {
        job: {
          id: job.id, title: job.title, objective: job.objective ?? null,
          description: job.description ?? null, priority: job.priority ?? null,
          executionMode: job.executionMode, repository: job.repository,
          prNumber: job.prNumber, state: job.state,
        },
        task: {
          id: task.id, kind: task.kind ?? 'work', storySize: task.storySize ?? 'M',
          priority: task.priority ?? null, agentName: task.agentName ?? null,
          parentTaskId: task.parentTaskId, dependencies: task.dependencies,
          capabilities: task.capabilities, taskCapabilities: task.taskCapabilities, workerCapabilities: task.workerCapabilities, input: task.input,
          attachments: task.attachments ?? [], output: task.output ?? null,
          state: task.state, attempt: task.attempt, maxAttempts: task.maxAttempts,
        },
        storySize: task.storySize ?? 'M',
      },
      usage,
      chatgptRunning: runtime.workers.chatgpt,
    });
    return {
      selected: {
        route: result.audit?.selected?.id,
        worker: result.selection.workerId,
        adapter: result.selection.adapter,
        provider: result.candidate.routing.provider,
        model: result.candidate.routing.model,
        profile: result.candidate.routing.profile,
        reasoning: result.candidate.routing.reasoning,
      },
      probabilities: result.candidate.routing.decisionEvidence?.probabilities ?? {},
      proposedFields: result.candidate.routing.decisionEvidence?.proposedFields ?? {},
      fallback: result.candidate.routing.decisionEvidence?.fallback ?? false,
      current: {
        chatgptRunning: runtime.workers.chatgpt,
        browserWorkspace: usage.browserWorkspace ?? null,
        providers: usage.providers,
        credits: usage.credits,
      },
      effectiveChoices: result.audit?.contract?.effectiveChoices ?? [],
      routingInstruction: result.audit?.contract?.routingInstruction ?? '',
      mergedChoices: firstStageChoices(result.audit?.decision_input),
      decisionInput: result.audit?.decision_input ?? null,
      gates: result.audit?.gate_results ?? [],
    };
  },
  async () => (await decisionAuditStore.read()).filter((record): record is import('./decision-audit.js').DecisionAuditRecord => record.record_type === 'decision' && record.schema_version === 5));

  await once(server,'listening');
  const reconcileSafely = async (): Promise<void> => {
    try { await pool.reconcile(); }
    catch (error) { observability().record({ stage: 'daemon', event: 'daemon.reconcile_failed', level: 'warn', outcome: 'failed', message: `Workspace reconcile unavailable: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }); }
  };
  const scheduleHeartbeatSafely = async (): Promise<void> => {
    const now = new Date();
    for (const item of dueScheduledOverviews(cachedOverviews, now)) {
      try {
        await pool.scheduleTickSignal(bus, item.job, now);
      } catch (error) {
        observability().record({ stage: 'daemon', event: 'daemon.schedule_heartbeat_failed', level: 'warn', outcome: 'failed', message: `Scheduled heartbeat unavailable: ${errorMessage(error)}`, correlation: { repository: item.job.repository, prNumber: item.job.prNumber, jobId: item.job.id }, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } });
      }
    }
  };
  const flushProjectionsSafely = async (): Promise<void> => {
    let externalActionsCompleted = 0;
    for (const writer of projectionWriters.values()) {
      try { externalActionsCompleted += (await writer.flushOnce()).projected; }
      catch (error) { observability().record({ stage: 'daemon', event: 'daemon.projection_flush_failed', level: 'warn', outcome: 'failed', message: `GitHub external action unavailable: ${errorMessage(error)}`, data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }); }
    }
    // GitHub external acknowledgements are audit-only. Never wake local Graphs.
    if (externalActionsCompleted > 0) observability().record({ stage: 'daemon', event: 'github.external_actions_recorded', level: 'info', outcome: 'succeeded', message: String(externalActionsCompleted) + ' external actions acknowledged without lifecycle reconciliation' });
  };
  const watchdogDefault = webhook ? SERVICE_DEFAULTS.webhookWatchdogMs : SERVICE_DEFAULTS.watchdogMs;
  let interval: NodeJS.Timeout | undefined;
  let scheduleInterval: NodeJS.Timeout | undefined;
  let projectionInterval: NodeJS.Timeout | undefined;
  const stop=()=>{if (interval) clearInterval(interval); if (scheduleInterval) clearInterval(scheduleInterval); if (projectionInterval) clearInterval(projectionInterval); void Promise.allSettled([stopWatch(), shutdownOwnedProcesses('parent-shutdown')]).finally(()=>{ for (const store of relayStores.values()) store.close(); server.close(()=>process.exit(0)); });}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await syncGitHubBindingsSafely();
  await pool.reconcileKnown(cachedOverviews);
  await scheduleHeartbeatSafely();
  await flushProjectionsSafely();
  interval=setInterval(()=>void reconcileSafely().finally(flushProjectionsSafely),Number(value(argv,'--interval',String(watchdogDefault)))); interval.unref();
  if (!noGitHub) { projectionInterval=setInterval(()=>void syncGitHubBindingsSafely().then(flushProjectionsSafely),Number(value(argv,'--projection-ms',String(SERVICE_DEFAULTS.projectionFlushMs)))); projectionInterval.unref(); }
  scheduleInterval=setInterval(()=>void scheduleHeartbeatSafely(),SCHEDULE_HEARTBEAT_MS); scheduleInterval.unref();
  console.log('Dashboard listening; repository worker pool active');
  void refreshAll(true)
    .then(items => pool.reconcileKnown(items))
    .catch(error => observability().record({ stage: 'daemon', event: 'daemon.startup_refresh_failed', level: 'warn', outcome: 'failed', message: 'Startup local refresh unavailable: ' + errorMessage(error), data: { classification: classifyFailure(error).classification, reason: errorMessage(error) } }));
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});

function conflictJobId(repository: string, prNumber: number): string {
  return `${repository}#${prNumber}`;
}
