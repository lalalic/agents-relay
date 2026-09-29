#!/usr/bin/env node
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatGptAdapter, CodexAdapter } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { NatsEventBus } from './events.js';
import { RepositoryWorkerPool, aggregateManagedGitHubJobs } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GitHubStore, InMemoryStore, ManagedJobOverview, loadManagedGitHubPullRequestSnapshotGraphql, type ManagedGitHubPullRequestSnapshot, withGitHubRequestContext } from './store.js';
import { githubAuthContext } from './github-auth.js';
import { dashboardJobAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { dashboardJobSetState, dashboardTaskAction, dashboardTaskSetState } from './dashboard-actions.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories, resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { decisionMode, LayaCliDecisionEngine } from './decision.js';
import { JsonlDecisionAuditStore } from './decision-audit.js';
import { summarizeRuntime } from './runtime-summary.js';
import { runScheduledBucket } from './scheduled-jobs.js';
import { scheduleBucket } from './scheduler.js';

export interface DaemonArguments { repository: string | null; workspaceRoot: string | null; pullRequest: number | null; jobId: string | null; serviceArguments: string[]; }
export type PullRequestRefreshTrigger = string;
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
  return overviews.filter(item => item.githubState === 'OPEN' && item.job.executionMode === 'autonomous' && item.job.schedule && Date.parse(item.job.schedule.nextRunAt) <= now.getTime());
}
export function shouldCoalescePullRequestRefresh(completedAt: number | null, now = Date.now(), force = false): boolean {
  return !force && completedAt !== null && now >= completedAt && now - completedAt < PR_REFRESH_COALESCE_MS;
}
export const daemonHelp = `Agents Relay daemon runs the dashboard and worker pool.

Usage:
  npx agents-relayd [options]

Options:
  --repo OWNER/REPO       Watch one repository
  --workspace PATH        Discover repositories below PATH (default: ~/Workspace)
  --port PORT             Dashboard port (default: 8787)
  --concurrency N         Maximum concurrent workers (default: 4)
  --interval MS           Recovery interval
  --events nats            Enable event wakeups

Legacy single-job mode also accepts --repo OWNER/REPO --pr NUMBER --id JOB_ID.

Examples:
  npx agents-relayd --repo OWNER/REPO
  npx agents-relayd --workspace ~/Workspace`;
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
    if (!values || values.length === 0 || values.some(item => item.githubState === 'OPEN' && !['COMPLETED','CANCELLED'].includes(item.job.state))) activeOrUnknown.push(repository);
    else dormant.push(repository);
  }
  if (dormant.length === 0) return activeOrUnknown;
  return [...activeOrUnknown, dormant[Math.abs(dormantProbeIndex) % dormant.length]];
}

export async function runDaemon(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(daemonHelp); return; }
  const normalized = normalizeDaemonArguments(argv);
  if (normalized.pullRequest && normalized.jobId) { await startService([...argv]); return; }
  const auth = await githubAuthContext(argv); const client = auth.client;
  const trusted = auth.trustedAuthors;
  const concurrency = Number(value(argv,'--concurrency','4'));
  const bus = value(argv,'--events') === 'nats' ? new NatsEventBus(value(argv,'--nats-url','nats://127.0.0.1:4222'), value(argv,'--subject-prefix','neo.events.job')) : undefined;
  const workspaceRoot = normalized.workspaceRoot ?? defaultWorkspaceRoot();
  const discoveredRepositories = normalized.repository ? [] : await discoverWorkspaceRepositories(workspaceRoot);
  const repositories = normalized.repository ? [normalized.repository] : discoveredRepositories.map(item => item.repository);
  const repositoryPaths = new Map(discoveredRepositories.map(item => [item.repository, item.path]));
  const explicitProjectPath = value(argv,'--project-path');
  const usageRegistry = codexAndZaiUsageRegistry();
  const decisionAuditStore = new JsonlDecisionAuditStore(process.env.AGENTS_RELAY_DECISION_AUDIT_PATH ?? join(homedir(), '.agents-relay', 'decision-audit.jsonl'));
  let cachedOverviews: ManagedJobOverview[] = [];
  const githubReadPaths: GitHubReadPathDiagnostics = { workspaceScans: 0, prRefreshes: 0, prRefreshesByTrigger: {}, prRefreshCoalesced: 0, prRefreshCoalescedByTrigger: {} };
  let dormantProbeIndex = 0;
  const makeReconciler = (store: GitHubStore, maxConcurrent: number) => new Reconciler(store,{ owner:`relayd-${process.pid}`, maxConcurrent, leaseMs:Number(value(argv,'--lease-ms','300000')), adapters:[new CodexAdapter(value(argv,'--codex','codex')),new ChatGptAdapter()], continuations:[new CodexThreadContinuation(value(argv,'--codex','codex')),new CommandContinuation(),new WebhookContinuation()], planner:runtimePlanner(argv), usageSnapshotProvider: () => usageRegistry.snapshot(), runtimeSummaryProvider: () => ({ chatgptRunning: summarizeRuntime(cachedOverviews.map(item => item.job)).workers.chatgpt }), decisionEngine:new LayaCliDecisionEngine(), decisionMode:decisionMode(), decisionAuditStore, eventBus:bus, reviewer:runtimeReviewer(), projectPathForJob: async job => resolveRepositoryProjectPath(repositoryPaths.get(job.repository) ?? await resolveManagedProjectPath(job.repository, explicitProjectPath, workspaceRoot), job.projectPath) });
  if (repositories.length === 0) throw new Error(`No Git repositories with GitHub origins found under ${normalized.workspaceRoot ?? defaultWorkspaceRoot()}`);
  const cacheDirectory = join(homedir(), '.agents-relay');
  const cacheFile = join(cacheDirectory, 'dashboard-jobs.json');
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as ManagedJobOverview[];
    if (Array.isArray(parsed)) cachedOverviews = parsed;
  } catch { /* first run or invalid cache */ }
  const refreshAll = async (full = false, failOnError = false): Promise<ManagedJobOverview[]> => {
    if (client.rateLimitStatus().limited) return cachedOverviews;
    const scanRepositories = full ? repositories : recoveryScanRepositories(repositories, cachedOverviews, dormantProbeIndex++);
    if (scanRepositories.length === 0) return cachedOverviews;
    try {
      githubReadPaths.workspaceScans += 1;
      const refreshed = await withGitHubRequestContext(client, 'relayd.workspace-refresh', () => aggregateManagedGitHubJobs(client, scanRepositories, trusted));
      const scanned = new Set(scanRepositories);
      cachedOverviews = dashboardManagedJobs([...cachedOverviews.filter(item => !scanned.has(item.job.repository)), ...refreshed]);
      try { await mkdir(cacheDirectory, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cachedOverviews), 'utf8'); } catch { /* cache is best effort */ }
      return cachedOverviews;
    } catch (error) {
      if (failOnError) throw error;
      process.stderr.write(`warning: workspace job refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return cachedOverviews;
    }
  };
  const overviews = async (forceRefresh = false, _trigger = 'internal.unknown'): Promise<ManagedJobOverview[]> => forceRefresh ? refreshAll(true) : cachedOverviews;
  const persistCache = async (): Promise<void> => {
    try { await mkdir(cacheDirectory, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cachedOverviews), 'utf8'); } catch { /* cache is best effort */ }
  };
  const pullRequestRefreshFlights = new Map<string, Promise<ManagedGitHubPullRequestSnapshot>>();
  const pullRequestRefreshCache = new Map<string, { snapshot: ManagedGitHubPullRequestSnapshot; completedAt: number }>();
  const incrementTrigger = (counts: Record<string, number>, trigger: PullRequestRefreshTrigger): void => { counts[trigger] = (counts[trigger] ?? 0) + 1; };
  const refreshPullRequestSnapshot = async (repository: string, prNumber: number, trigger: PullRequestRefreshTrigger = 'internal', options: { force?: boolean } = {}): Promise<ManagedGitHubPullRequestSnapshot> => {
    if (client.rateLimitStatus().limited) return { overviews: cachedOverviews.filter(item => item.job.repository === repository && item.job.prNumber === prNumber), seed: { prNode: {}, comments: null } };
    const key = `${repository}#${prNumber}`;
    incrementTrigger(githubReadPaths.prRefreshesByTrigger, trigger);
    const existing = pullRequestRefreshFlights.get(key);
    if (existing) {
      githubReadPaths.prRefreshCoalesced += 1;
      incrementTrigger(githubReadPaths.prRefreshCoalescedByTrigger, trigger);
      return existing;
    }
    const cached = pullRequestRefreshCache.get(key);
    if (cached && shouldCoalescePullRequestRefresh(cached.completedAt, Date.now(), options.force === true)) {
      githubReadPaths.prRefreshCoalesced += 1;
      incrementTrigger(githubReadPaths.prRefreshCoalescedByTrigger, trigger);
      return cached.snapshot;
    }
    const flight = (async (): Promise<ManagedGitHubPullRequestSnapshot> => {
      githubReadPaths.prRefreshes += 1;
      const snapshot = await withGitHubRequestContext(client, `relayd.pr-refresh:${trigger}`, () => loadManagedGitHubPullRequestSnapshotGraphql(client, repository, prNumber, trusted));
      cachedOverviews = cachedOverviews.filter(item => item.job.repository !== repository || item.job.prNumber !== prNumber);
      cachedOverviews.push(...snapshot.overviews);
      cachedOverviews = dashboardManagedJobs(cachedOverviews);
      await persistCache();
      pullRequestRefreshCache.set(key, { snapshot, completedAt: Date.now() });
      return snapshot;
    })();
    pullRequestRefreshFlights.set(key, flight);
    try { return await flight; }
    finally { if (pullRequestRefreshFlights.get(key) === flight) pullRequestRefreshFlights.delete(key); }
  };
  const refreshPullRequest = async (repository: string, prNumber: number, trigger: PullRequestRefreshTrigger, options?: { force?: boolean }): Promise<ManagedJobOverview[]> => (await refreshPullRequestSnapshot(repository, prNumber, trigger, options)).overviews;
  const pool = new RepositoryWorkerPool(
    client,
    repositories,
    trusted,
    concurrency,
    makeReconciler,
    () => client.rateLimitStatus().limited,
    (repository, prNumber, trigger) => refreshPullRequestSnapshot(repository, prNumber, trigger),
  );
  const initial = cachedOverviews; const fallback = initial[0]?.job;
  const dashboardStore = fallback ? new GitHubStore(client, fallback.repository, fallback.prNumber, trusted) : new InMemoryStore();
  const workspaceJobAction = (action: 'start' | 'reconcile' | 'cancel') => async (jobId: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = new GitHubStore(client, overview.job.repository, overview.job.prNumber, trusted);
    if (action === 'reconcile') {
      await pool.reconcileTarget(overview.job.repository, overview.job.prNumber, jobId);
      return await store.load(jobId);
    }
    return await dashboardJobAction(store, makeReconciler(store, concurrency), action)(jobId);
  };
  const workspaceJobSetState = async (jobId: string, state: import('./types.js').JobLifecycleState) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = new GitHubStore(client, overview.job.repository, overview.job.prNumber, trusted);
    const result = await dashboardJobSetState(store)(jobId, state);
    await refreshPullRequest(overview.job.repository, overview.job.prNumber, 'dashboard.job-state', { force: true });
    return result;
  };
  const workspaceTaskAction = (action: 'retry' | 'cancel') => async (jobId: string, taskId: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = new GitHubStore(client, overview.job.repository, overview.job.prNumber, trusted);
    return await dashboardTaskAction(store, makeReconciler(store, concurrency), action)(jobId, taskId);
  };
  const workspaceTaskSetState = async (jobId: string, taskId: string, state: import('./types.js').TaskState) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = new GitHubStore(client, overview.job.repository, overview.job.prNumber, trusted);
    const result = await dashboardTaskSetState(store)(jobId, taskId, state);
    await refreshPullRequest(overview.job.repository, overview.job.prNumber, 'dashboard.task-state', { force: true });
    return result;
  };
  const secretFile = value(argv,'--github-webhook-secret-file');
  const secret = value(argv,'--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || (secretFile ? (await readFile(secretFile,'utf8')).trim() : '');
  const webhook = secret ? {
    secret,
    repositories: new Set(repositories),
    wake: async (event: GitHubWebhookWake): Promise<void> => {
      if (!event.repository || !event.pullRequest) return;
      try {
        await pool.webhookSignal(bus, event);
      } catch (error) {
        process.stderr.write(`warning: webhook wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } : undefined;
  const exactJob = async (jobId: string) => {
    const cached = cachedOverviews.find(item => item.job.id === jobId);
    if (!cached) return null;
    const cachedJob = () => ({ ...cached.job, githubState: cached.githubState, runtimeStatus: deriveJobRuntimeStatus(cached.job, cached.githubState), mergedAt: cached.mergedAt, closedAt: cached.closedAt, draft: cached.draft, publication: cached.publication });
    if (client.rateLimitStatus().limited) return cachedJob();
    try {
      const refreshed = (await refreshPullRequest(cached.job.repository, cached.job.prNumber, 'dashboard.selected-job', { force: true })).find(item => item.job.id === jobId);
      if (!refreshed) return null;
      return { ...refreshed.job, githubState: refreshed.githubState, runtimeStatus: deriveJobRuntimeStatus(refreshed.job, refreshed.githubState), mergedAt: refreshed.mergedAt, closedAt: refreshed.closedAt, draft: refreshed.draft, publication: refreshed.publication };
    } catch (error) {
      process.stderr.write(`warning: selected job refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return cachedJob();
    }
  };
  const stopWatch = bus ? await pool.watch(bus) : async()=>{};
  const server = serveDashboard(dashboardStore,Number(value(argv,'--port',String(SERVICE_DEFAULTS.port))),bus,Number(value(argv,'--refresh-ms',String(SERVICE_DEFAULTS.dashboardRefreshMs))),fallback?.id,usageRegistry,overviews,webhook,()=>({ ...client.rateLimitStatus(), readPaths: { ...githubReadPaths } }),()=>client.rateLimitSnapshot(),exactJob, {
    start: workspaceJobAction('start'),
    reconcile: workspaceJobAction('reconcile'),
    cancel: workspaceJobAction('cancel'),
    jobSetState: workspaceJobSetState,
    taskRetry: workspaceTaskAction('retry'),
    taskCancel: workspaceTaskAction('cancel'),
    taskSetState: workspaceTaskSetState,
  });
  const reconcileSafely = async (): Promise<void> => {
    if (client.rateLimitStatus().limited) return;
    try { await pool.reconcile(); }
    catch (error) { process.stderr.write(`warning: workspace reconcile unavailable: ${error instanceof Error ? error.message : String(error)}\n`); }
  };
  const scheduleHeartbeatSafely = async (): Promise<void> => {
    if (client.rateLimitStatus().limited) return;
    const now = new Date();
    for (const item of dueScheduledOverviews(cachedOverviews, now)) {
      const repository = item.job.repository;
      try {
        await runScheduledBucket(client, repository, trusted, { prNumber: item.job.prNumber, jobId: item.job.id, bucket: scheduleBucket(new Date(item.job.schedule!.nextRunAt)) }, { reconcile: async () => { await pool.reconcileTarget(repository, item.job.prNumber, item.job.id); }, idle: async () => {} }, now);
      } catch (error) {
        process.stderr.write(`warning: scheduled heartbeat unavailable for ${repository}#${item.job.prNumber}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  };
  const watchdogDefault = webhook ? SERVICE_DEFAULTS.webhookWatchdogMs : SERVICE_DEFAULTS.watchdogMs;
  let interval: NodeJS.Timeout | undefined;
  let scheduleInterval: NodeJS.Timeout | undefined;
  const stop=()=>{if (interval) clearInterval(interval); if (scheduleInterval) clearInterval(scheduleInterval); void stopWatch().finally(()=>server.close(()=>process.exit(0)));}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  await once(server,'listening');
  const startupItems = await refreshAll(true, true); // void refreshAll(true)
  await pool.reconcileKnown(startupItems);
  // Startup recovery must finish before normal polling or scheduled work can run.
  await scheduleHeartbeatSafely();
  interval=setInterval(()=>void reconcileSafely(),Number(value(argv,'--interval',String(watchdogDefault)))); interval.unref();
  scheduleInterval=setInterval(()=>void scheduleHeartbeatSafely(),SCHEDULE_HEARTBEAT_MS); scheduleInterval.unref();
  console.log('Dashboard listening; repository worker pool active');
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
