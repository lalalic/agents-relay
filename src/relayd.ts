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
import { dashboardManagedJobs, GitHubStore, InMemoryStore, ManagedJobOverview, loadManagedGitHubPullRequestGraphql } from './store.js';
import { githubAuthContext } from './github-auth.js';
import { dashboardJobAction, dashboardTaskAction, isEntrypoint, runtimePlanner, runtimeReviewer, startService, SERVICE_DEFAULTS } from './cli.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories, resolveManagedProjectPath, resolveRepositoryProjectPath } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { decisionMode, LayaCliDecisionEngine } from './decision.js';
import { JsonlDecisionAuditStore } from './decision-audit.js';
import { summarizeRuntime } from './runtime-summary.js';

export interface DaemonArguments { repository: string | null; workspaceRoot: string | null; pullRequest: number | null; jobId: string | null; serviceArguments: string[]; }
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
  const makeReconciler = (store: GitHubStore, maxConcurrent: number) => new Reconciler(store,{ owner:`relayd-${process.pid}`, maxConcurrent, leaseMs:Number(value(argv,'--lease-ms','300000')), adapters:[new CodexAdapter(value(argv,'--codex','codex')),new ChatGptAdapter()], continuations:[new CodexThreadContinuation(value(argv,'--codex','codex')),new CommandContinuation(),new WebhookContinuation()], planner:runtimePlanner(argv), usageSnapshotProvider: () => usageRegistry.snapshot(), runtimeSummaryProvider: () => ({ chatgptRunning: summarizeRuntime(cachedOverviews.map(item => item.job)).workers.chatgpt }), decisionEngine:new LayaCliDecisionEngine(), decisionMode:decisionMode(), decisionAuditStore, eventBus:bus, reviewer:runtimeReviewer(), projectPathForJob: async job => resolveRepositoryProjectPath(repositoryPaths.get(job.repository) ?? await resolveManagedProjectPath(job.repository, explicitProjectPath, workspaceRoot), job.projectPath) });
  if (repositories.length === 0) throw new Error(`No Git repositories with GitHub origins found under ${normalized.workspaceRoot ?? defaultWorkspaceRoot()}`);
  const pool = new RepositoryWorkerPool(client, repositories, trusted, concurrency, makeReconciler);
  const cacheDirectory = join(homedir(), '.agents-relay');
  const cacheFile = join(cacheDirectory, 'dashboard-jobs.json');
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as ManagedJobOverview[];
    if (Array.isArray(parsed)) cachedOverviews = parsed;
  } catch { /* first run or invalid cache */ }
  const refreshAll = async (): Promise<ManagedJobOverview[]> => {
    if (client.rateLimitStatus().limited) return cachedOverviews;
    try {
      cachedOverviews = dashboardManagedJobs(await aggregateManagedGitHubJobs(client, repositories, trusted));
      try { await mkdir(cacheDirectory, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cachedOverviews), 'utf8'); } catch { /* cache is best effort */ }
      return cachedOverviews;
    } catch (error) {
      process.stderr.write(`warning: workspace job refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return cachedOverviews;
    }
  };
  const overviews = async (forceRefresh = false): Promise<ManagedJobOverview[]> => forceRefresh ? refreshAll() : cachedOverviews;
  const persistCache = async (): Promise<void> => {
    try { await mkdir(cacheDirectory, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cachedOverviews), 'utf8'); } catch { /* cache is best effort */ }
  };
  const refreshPullRequest = async (repository: string, prNumber: number): Promise<ManagedJobOverview[]> => {
    const refreshed = await loadManagedGitHubPullRequestGraphql(client, repository, prNumber, trusted);
    cachedOverviews = cachedOverviews.filter(item => item.job.repository !== repository || item.job.prNumber !== prNumber);
    cachedOverviews.push(...refreshed);
    cachedOverviews = dashboardManagedJobs(cachedOverviews);
    await persistCache();
    return refreshed;
  };
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
  const workspaceTaskAction = (action: 'retry' | 'cancel') => async (jobId: string, taskId: string) => {
    const overview = cachedOverviews.find(item => item.job.id === jobId);
    if (!overview) throw new Error(`Managed job ${jobId} not found`);
    const store = new GitHubStore(client, overview.job.repository, overview.job.prNumber, trusted);
    return await dashboardTaskAction(store, makeReconciler(store, concurrency), action)(jobId, taskId);
  };
  const secretFile = value(argv,'--github-webhook-secret-file');
  const secret = value(argv,'--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || (secretFile ? (await readFile(secretFile,'utf8')).trim() : '');
  const webhook = secret ? {
    secret,
    repositories: new Set(repositories),
    refresh: async (event: GitHubWebhookWake): Promise<readonly string[]> => {
      if (!event.repository || !event.pullRequest) return [];
      const refreshed = await refreshPullRequest(event.repository, event.pullRequest);
      return refreshed.map(item => item.job.id);
    },
    wake: async (event: GitHubWebhookWake): Promise<void> => {
      if (!event.repository || !event.pullRequest) return;
      try {
        const refreshed = cachedOverviews.filter(item => item.job.repository === event.repository && item.job.prNumber === event.pullRequest);
        for (const item of refreshed) await pool.webhookWake(bus, item.job, event);
      } catch (error) {
        process.stderr.write(`warning: webhook wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } : undefined;
  const exactJob = async (jobId: string) => {
    const cached = cachedOverviews.find(item => item.job.id === jobId);
    if (!cached) return null;
    try {
      const refreshed = (await refreshPullRequest(cached.job.repository, cached.job.prNumber)).find(item => item.job.id === jobId);
      if (!refreshed) return null;
      return { ...refreshed.job, githubState: refreshed.githubState, runtimeStatus: deriveJobRuntimeStatus(refreshed.job, refreshed.githubState), mergedAt: refreshed.mergedAt, closedAt: refreshed.closedAt, draft: refreshed.draft };
    } catch (error) {
      process.stderr.write(`warning: selected job refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  };
  const server = serveDashboard(dashboardStore,Number(value(argv,'--port',String(SERVICE_DEFAULTS.port))),bus,Number(value(argv,'--refresh-ms',String(SERVICE_DEFAULTS.dashboardRefreshMs))),fallback?.id,usageRegistry,overviews,webhook,()=>client.rateLimitStatus(),exactJob, {
    start: workspaceJobAction('start'),
    reconcile: workspaceJobAction('reconcile'),
    cancel: workspaceJobAction('cancel'),
    taskRetry: workspaceTaskAction('retry'),
    taskCancel: workspaceTaskAction('cancel'),
  });
  await once(server,'listening');
  const reconcileSafely = async (): Promise<void> => {
    if (client.rateLimitStatus().limited) return;
    try { await pool.reconcile(); }
    catch (error) { process.stderr.write(`warning: workspace reconcile unavailable: ${error instanceof Error ? error.message : String(error)}\n`); }
  };
  const watchdogDefault = webhook ? SERVICE_DEFAULTS.webhookWatchdogMs : SERVICE_DEFAULTS.watchdogMs;
  const interval=setInterval(()=>void reconcileSafely(),Number(value(argv,'--interval',String(watchdogDefault)))); interval.unref();
  const stopWatch = bus ? await pool.watch(bus) : async()=>{};
  const stop=()=>{clearInterval(interval);void stopWatch().finally(()=>server.close(()=>process.exit(0)));}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log('Dashboard listening; repository worker pool active');
  void refreshAll()
    .then(items => pool.reconcileKnown(items))
    .catch(error => process.stderr.write(`warning: startup reconciliation unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
