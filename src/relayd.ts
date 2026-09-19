#!/usr/bin/env node
import { once } from 'node:events';
import { ChatGptAdapter, CodexAdapter, ShellAdapter } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { serveDashboard } from './dashboard.js';
import { NatsEventBus } from './events.js';
import { RepositoryWorkerPool, aggregateManagedGitHubJobs } from './pool.js';
import { Reconciler } from './reconciler.js';
import { dashboardManagedJobs, GhApiClient, GitHubStore } from './store.js';
import { isEntrypoint, startService, SERVICE_DEFAULTS } from './cli.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { defaultWorkspaceRoot, discoverWorkspaceRepositories } from './workspace.js';

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
  const overviews = async () => dashboardManagedJobs(await aggregateManagedGitHubJobs(client, repositories, trusted));
  const initial = await overviews(); const fallback = initial[0]?.job; if (!fallback) throw new Error('No managed jobs found');
  const dashboardStore = new GitHubStore(client, fallback.repository, fallback.prNumber, trusted);
  const secret = value(argv,'--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || '';
  const webhook = secret && normalized.repository ? {secret,repository:normalized.repository,wake:(deliveryId:string,event:string,action:string|null)=>pool.webhookWake(bus,deliveryId,event,action)} : undefined;
  const usageRegistry = codexAndZaiUsageRegistry();
  const server = serveDashboard(dashboardStore,Number(value(argv,'--port',String(SERVICE_DEFAULTS.port))),bus,Number(value(argv,'--refresh-ms',String(SERVICE_DEFAULTS.dashboardRefreshMs))),fallback.id,usageRegistry,overviews,webhook);
  await once(server,'listening');
  const interval=setInterval(()=>void pool.reconcile(),Number(value(argv,'--interval',String(SERVICE_DEFAULTS.watchdogMs)))); interval.unref();
  const stopWatch = bus ? await pool.watch(bus) : async()=>{};
  const stop=()=>{clearInterval(interval);void stopWatch().finally(()=>server.close(()=>process.exit(0)));}; process.once('SIGINT',stop);process.once('SIGTERM',stop);
  console.log('Dashboard listening; repository worker pool active'); void pool.reconcile();
}
if (isEntrypoint(import.meta.url)) runDaemon(process.argv.slice(2)).catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
