#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { InMemoryStore, DurableStore, GhApiClient, GitHubStore } from './store.js';
import { EventRecord, Job, Task, AdapterName, RoutingDecision } from './types.js';
import { Reconciler } from './reconciler.js';
import { ShellAdapter, CodexAdapter } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { NatsEventBus, eventFor, EventBus } from './events.js';
import { serveDashboard } from './dashboard.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { Server } from 'node:http';
const usage = 'agents-relay <init|submit|status|reconcile|retry|cancel|serve> [options]';
export const SERVICE_DEFAULTS = { port: 8787, watchdogMs: 60000, dashboardRefreshMs: 15000 } as const;
class ServiceEventBus implements EventBus {
  private readonly unsubscribers = new Set<() => Promise<void>>();
  constructor(private readonly upstream: EventBus) {}
  async publish(event: EventRecord): Promise<void> { await this.upstream.publish(event); }
  async subscribe(jobId: string, wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> {
    const unsubscribe = await this.upstream.subscribe(jobId, wake);
    this.unsubscribers.add(unsubscribe);
    return async (): Promise<void> => { this.unsubscribers.delete(unsubscribe); await unsubscribe(); };
  }
  async close(): Promise<void> {
    const pending = [...this.unsubscribers].map(unsubscribe => unsubscribe());
    this.unsubscribers.clear(); await Promise.all(pending);
  }
}
function arg(args: string[], name: string, fallback = ''): string { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; }
function repository(args: string[]): string { const value = arg(args, '--repo'); if (!value) throw new Error('--repo is required for GitHub-backed operation'); return value; }
function pullRequest(args: string[]): number { const value = Number(arg(args, '--pr')); if (!Number.isInteger(value) || value <= 0) throw new Error('--pr is required for GitHub-backed operation'); return value; }
async function localStore(file: string): Promise<{ store: InMemoryStore; job: Job }> { const job = JSON.parse(await readFile(file, 'utf8')) as Job; return { store: new InMemoryStore(job), job }; }
async function githubStore(args: string[]): Promise<GitHubStore> { const client = new GhApiClient(); const login = await client.currentLogin(); const trusted = new Set([login, ...arg(args, '--trusted-authors').split(',').map(value => value.trim()).filter(Boolean)]); return new GitHubStore(client, repository(args), pullRequest(args), trusted); }
async function storeFor(args: string[]): Promise<{ store: DurableStore; job: Job; localFile: string | null }> { const repo = arg(args, '--repo'); const pr = arg(args, '--pr'); if (repo && pr) { const store = await githubStore(args); const jobId = arg(args, '--id'); if (!jobId) throw new Error('--id is required for GitHub-backed operation'); return { store, job: await store.load(jobId), localFile: null }; } const file = arg(args, '--file'); if (!file) throw new Error('Local mode is demo/test only; pass --file explicitly'); const loaded = await localStore(file); return { store: loaded.store, job: loaded.job, localFile: file }; }
async function saveLocal(file: string | null, job: Job): Promise<void> { if (file) await writeFile(file, JSON.stringify(job, null, 2)); }
export function eventBus(args: string[]): EventBus | undefined { if (arg(args, '--events') !== 'nats') return undefined; return new NatsEventBus(arg(args, '--nats-url', 'nats://127.0.0.1:4222'), arg(args, '--subject-prefix', 'agents-relay.events.job')); }
async function publishWake(bus: EventBus | undefined, job: Job, taskId: string, message: string): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'job.wake', 'queued', message, 'orchestrator')); } catch (error) { process.stderr.write(`warning: event wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
function continuation(args: string[]): Job['continuation'] { const kind = arg(args, '--continue-kind'); const target = arg(args, '--continue-target'); return kind && target ? { kind: kind as NonNullable<Job['continuation']>['kind'], target, input: arg(args, '--continue-input') || undefined } : null; }
export function runtime(store: DurableStore, args: string[], bus: EventBus | undefined): Reconciler { const emit = (event: ReturnType<typeof eventFor>): void => { process.stderr.write(`${JSON.stringify(event)}\n`); }; return new Reconciler(store, { owner: arg(args, '--owner', `cli-${process.pid}`), maxConcurrent: Number(arg(args, '--concurrency', '4')), leaseMs: Number(arg(args, '--lease-ms', '300000')), adapters: [new ShellAdapter(), new CodexAdapter(arg(args, '--codex', 'codex'))], continuations: [new CodexThreadContinuation(arg(args, '--codex', 'codex')), new CommandContinuation(), new WebhookContinuation()], eventBus: bus, emit }); }
export interface Service { store: DurableStore; job: Job; reconciler: Reconciler; dashboardServer: Server; watchdogCleared: boolean; stop(): Promise<void>; }
export async function createService(args: string[]): Promise<Service> {
  const loaded = await storeFor(args); const upstream = eventBus(args); const bus = upstream ? new ServiceEventBus(upstream) : undefined; const reconciler = runtime(loaded.store, args, bus);
  const requestedUsageDays = Number(arg(args, '--usage-window-days', '1'));
  const usageWindowDays = Number.isInteger(requestedUsageDays) && requestedUsageDays > 0 ? requestedUsageDays : 1;
  const usageRegistry = codexAndZaiUsageRegistry(undefined, usageWindowDays);
  const dashboardServer = serveDashboard(loaded.store, Number(arg(args, '--port', String(SERVICE_DEFAULTS.port))), bus, Number(arg(args, '--refresh-ms', String(SERVICE_DEFAULTS.dashboardRefreshMs))), loaded.job.id, usageRegistry);
  await once(dashboardServer, 'listening');
  const stopWatcher = await reconciler.watch(loaded.job.id);
  const watchdog = setInterval(() => void reconciler.reconcile(loaded.job.id), Number(arg(args, '--interval', String(SERVICE_DEFAULTS.watchdogMs)))); watchdog.unref();
  let stopping: Promise<void> | null = null;
  const service: Service = {
    store: loaded.store,
    job: loaded.job,
    reconciler,
    dashboardServer,
    watchdogCleared: false,
    stop(): Promise<void> {
      if (stopping) return stopping;
      clearInterval(watchdog); service.watchdogCleared = true;
      const serverClosed = new Promise<void>((resolve, reject) => { dashboardServer.close(error => error ? reject(error) : resolve()); });
      dashboardServer.closeAllConnections();
      const watcherClosed = bus ? bus.close() : stopWatcher();
      stopping = Promise.all([watcherClosed, serverClosed]).then(() => undefined, error => { throw error; });
      return stopping;
    }
  };
  return service;
}
export async function startService(args: string[]): Promise<Service> {
  const service = await createService(args);
  const stop = (): void => { void service.stop().then(() => process.exit(0), error => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); }); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  await service.reconciler.reconcile(service.job.id);
  console.log('Dashboard listening');
  return service;
}
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1]; if (!invoked) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invoked); } catch { return moduleUrl === `file://${invoked}`; }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2); if (!command) throw new Error(usage);
  if (command === 'init') { const now = new Date().toISOString(); const job: Job = { id: arg(args, '--id', randomUUID()), title: arg(args, '--title', 'Agents Relay job'), prNumber: Number(arg(args, '--pr', '0')), repository: arg(args, '--repo'), state: 'OPEN', continuation: continuation(args), createdAt: now, updatedAt: now, tasks: [] }; let store: DurableStore; let file: string | null = null; if (arg(args, '--repo') && arg(args, '--pr')) store = await githubStore(args); else { file = arg(args, '--file'); if (!file) throw new Error('init requires --repo/--pr or explicit --file demo mode'); store = new InMemoryStore(job); } await store.saveJob(job); await saveLocal(file, job); console.log(`Initialized ${job.id}`); return; }
  const loaded = await storeFor(args); const { store, job, localFile } = loaded; const bus = eventBus(args);
  if (command === 'submit') { const now = new Date().toISOString(); const model = arg(args, '--model'); const routing = model ? { provider: arg(args, '--provider', 'openai'), model, profile: arg(args, '--profile') || undefined, reasoning: arg(args, '--reasoning') || undefined, cwd: arg(args, '--cwd') || undefined, decidedBy: 'cli', decidedAt: now } satisfies RoutingDecision : undefined; const task: Task = { jobId: job.id, id: arg(args, '--task-id', randomUUID()), projectName: arg(args, '--project') || undefined, agentName: arg(args, '--agent') || undefined, parentTaskId: arg(args, '--parent') || null, dependencies: arg(args, '--deps').split(',').filter(Boolean), capabilities: arg(args, '--capabilities').split(',').filter(Boolean), adapter: arg(args, '--adapter', 'shell') as AdapterName, input: arg(args, '--input', 'true'), routing, continuation: continuation(args), continuationDeliveredAt: null, state: 'QUEUED', attempt: 0, maxAttempts: Number(arg(args, '--max-attempts', '3')), leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: Number(arg(args, '--timeout', '300000')), createdAt: now, updatedAt: now }; await store.appendTask(task); job.tasks.push(task); await saveLocal(localFile, job); await publishWake(bus, job, task.id, `Task ${task.id} submitted`); console.log(`Submitted ${task.id}`); return; }
  if (command === 'status') { console.log(JSON.stringify(await store.load(job.id), null, 2)); return; }
  if (command === 'retry' || command === 'cancel') { const id = arg(args, '--task-id'); const task = job.tasks.find(item => item.id === id); if (!task) throw new Error(`Task ${id} not found`); task.state = command === 'retry' ? 'READY' : 'CANCELLED'; task.error = command === 'retry' ? null : 'Cancelled by user'; task.updatedAt = new Date().toISOString(); await store.saveTask(task); await saveLocal(localFile, job); await publishWake(bus, job, task.id, `${task.id} ${command} requested`); console.log(`${id}: ${task.state}`); return; }
  const reconciler = runtime(store, args, bus);
  if (command === 'reconcile') { await reconciler.reconcile(job.id); await reconciler.idle(); const finalState = await store.load(job.id); await saveLocal(localFile, finalState); console.log(JSON.stringify(finalState, null, 2)); return; }
  if (command === 'serve') { await startService(args); return; }
  throw new Error(usage);
}
if (isEntrypoint(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
