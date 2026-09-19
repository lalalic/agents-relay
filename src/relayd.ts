#!/usr/bin/env node
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ChatGptAdapter, CodexAdapter, ShellAdapter } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { NatsEventBus } from './events.js';
import { RepositoryWorkerPool, aggregateManagedGitHubJobs } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GhApiClient, GitHubStore, InMemoryStore, ManagedJobOverview, loadManagedGitHubPullRequestGraphql } from './store.js';
import { isEntrypoint, startService, SERVICE_DEFAULTS } from './cli.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories } from './workspace.js';
import { GitHubWebhookWake } from './github-webhook.js';
import { VoiceActionGateway } from './voice-action.js';

export interface DaemonArguments { repository: string | null; workspaceRoot: string | null; pullRequest: number | null; jobId: string | null; serviceArguments: string[]; }
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
  const normalized = normalizeDaemonArguments(argv);
  if (normalized.pullRequest && normalized.jobId) { await startService([...argv]); return; }
  const client = new GhApiClient(); const login = await client.currentLogin();
  const trusted = new Set([login, ...value(argv,'--trusted-authors').split(',').map(x=>x.trim()).filter(Boolean)]);
  const concurrency = Number(value(argv,'--concurrency','4'));
  const bus = value(argv,'--events') === 'nats' ? new NatsEventBus(value(argv,'--nats-url','nats://127.0.0.1:4222'), value(argv,'--subject-prefix','agents-relay.events.job')) : undefined;
  const makeReconciler = (store: GitHubStore, maxConcurrent: number) => new Reconciler(store,{ owner:`relayd-${process.pid}`, maxConcurrent, leaseMs:Number(value(argv,'--lease-ms','300000')), adapters:[new ShellAdapter(),new CodexAdapter(value(argv,'--codex','codex')),new ChatGptAdapter({endpoint:value(argv,'--macbridge-url')||undefined,tokenFile:value(argv,'--macbridge-token-file')||undefined})], continuations:[new CodexThreadContinuation(value(argv,'--codex','codex')),new CommandContinuation(),new WebhookContinuation()], eventBus:bus });
  const repositories = normalized.repository
    ? [normalized.repository]
    : (await discoverWorkspaceRepositories(normalized.workspaceRoot ?? defaultWorkspaceRoot())).map(item => item.repository);
  if (repositories.length === 0) throw new Error(`No Git repositories with GitHub origins found under ${normalized.workspaceRoot ?? defaultWorkspaceRoot()}`);
  const pool = new RepositoryWorkerPool(client, repositories, trusted, concurrency, makeReconciler);
  const cacheDirectory = join(homedir(), '.agents-relay');
  const cacheFile = join(cacheDirectory, 'dashboard-jobs.json');
  let cachedOverviews: ManagedJobOverview[] = [];
  try {
    const parsed = JSON.parse(await readFile(cacheFile, 'utf8')) as ManagedJobOverview[];
    if (Array.isArray(parsed)) cachedOverviews = parsed;
  } catch { /* first run or invalid cache */ }
  const overviews = async (): Promise<ManagedJobOverview[]> => {
    try {
      cachedOverviews = dashboardManagedJobs(await aggregateManagedGitHubJobs(client, repositories, trusted));
      try { await mkdir(cacheDirectory, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cachedOverviews), 'utf8'); } catch { /* cache is best effort */ }
      return cachedOverviews;
    } catch (error) {
      process.stderr.write(`warning: workspace job refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return cachedOverviews;
    }
  };
  const persistCache = async (): Promise<void> => {
    try { await mkdir(cacheDirectory, { recursive: true }); await writeFile(cacheFile, JSON.stringify(cachedOverviews), 'utf8'); } catch { /* cache is best effort */ }
  };
  const refreshPullRequest = async (repository: string, prNumber: number): Promise<ManagedJobOverview[]> => {
    const refreshed = await loadManagedGitHubPullRequestGraphql(repository, prNumber, trusted);
    cachedOverviews = cachedOverviews.filter(item => item.job.repository !== repository || item.job.prNumber !== prNumber);
    cachedOverviews.push(...refreshed);
    cachedOverviews = dashboardManagedJobs(cachedOverviews);
    await persistCache();
    return refreshed;
  };
  const initial = await overviews(); const fallback = initial[0]?.job;
  const dashboardStore = fallback ? new GitHubStore(client, fallback.repository, fallback.prNumber, trusted) : new InMemoryStore();
  const secretFile = value(argv,'--github-webhook-secret-file');
  const secret = value(argv,'--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || (secretFile ? (await readFile(secretFile,'utf8')).trim() : '');
  const webhook = secret ? {
    secret,
    repositories: new Set(repositories),
    wake: async (event: GitHubWebhookWake): Promise<void> => {
      if (!event.repository || !event.pullRequest) return;
      try {
        const refreshed = await refreshPullRequest(event.repository, event.pullRequest);
        for (const item of refreshed) await pool.webhookWake(bus, item.job, event.deliveryId, event.event, event.action);
      } catch (error) {
        process.stderr.write(`warning: webhook PR refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  } : undefined;
  const exactJob = async (jobId: string) => {
    const cached = cachedOverviews.find(item => item.job.id === jobId);
    if (!cached) return null;
    try {
      const refreshed = (await refreshPullRequest(cached.job.repository, cached.job.prNumber)).find(item => item.job.id === jobId);
      if (!refreshed) return null;
      return { ...refreshed.job, githubState: refreshed.githubState, mergedAt: refreshed.mergedAt, closedAt: refreshed.closedAt, draft: refreshed.draft };
    } catch (error) {
      process.stderr.write(`warning: selected job refresh unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
      return null;
    }
  };
  const usageRegistry = codexAndZaiUsageRegistry();
  const voiceSecretFile = value(argv,'--voice-action-secret-file');
  const voiceSecret = value(argv,'--voice-action-secret') || process.env.AGENTS_RELAY_VOICE_ACTION_SECRET || (voiceSecretFile ? (await readFile(voiceSecretFile,'utf8')).trim() : '');
  const voiceRepositories = new Set(value(argv,'--voice-action-repos').split(',').map(item=>item.trim()).filter(Boolean));
  const voiceActionGateway = voiceSecret && voiceRepositories.size > 0 ? new VoiceActionGateway(client, trusted, voiceSecret, voiceRepositories) : undefined;
  const server = serveDashboard(dashboardStore,Number(value(argv,'--port',String(SERVICE_DEFAULTS.port))),bus,Number(value(argv,'--refresh-ms',String(SERVICE_DEFAULTS.dashboardRefreshMs))),fallback?.id,usageRegistry,overviews,webhook,()=>client.rateLimitStatus(),exactJob,voiceActionGateway);
  await once(server,'listening');
  const reconcileSafely = async (): Promise<void> => {
    try { await pool.reconcile(); }
    catch (error) { process.stderr.write(`warning: workspace reconcile unavailable: ${error instanceof Error ? error.message : String(error)}\n`); }
  };
  const interval=setInterval(()=>void reconcileSafely(),Number(value(argv,'--interval',String(SERVICE_DEFAULTS.watchdogMs)))); interval.unref();
  const stopWatch = bus ? await pool.watch(bus) : async()=>{};
  const stop=()=>{clearInterval(interval);void stopWatch().finally(()=>server.close(()=>process.exit(0)));}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log('Dashboard listening; repository worker pool active'); void reconcileSafely();
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
