import { readFile, writeFile } from 'node:fs/promises';
import { InMemoryStore, DurableStore } from './store.js';
import { noGitHubMode } from './no-github.js';
import { basename } from 'node:path';
import { createJobIdRegistryResolver, findJobIdSnapshot } from './local-job-registry.js';
import { relayStoreDirectory } from './relay-store.js';
import { normalizeRelayJob } from './relay-job-snapshot-reads.js';
import { EventRecord, Job, Task, ChatGptTabClosePolicy, StorySize, Priority } from './types.js';
import { NatsEventBus, eventFor, EventBus } from './events.js';
import { parseJobTagJson } from './task-tag.js';
import { resolveEventsBusRuntime } from './events-bus-runtime.js';

export const SERVICE_DEFAULTS = { port: 8787, watchdogMs: 300000, webhookWatchdogMs: 300000, dashboardRefreshMs: 300000, projectionFlushMs: 1000 } as const;
export class ServiceEventBus implements EventBus {
  private readonly unsubscribers = new Set<() => Promise<void>>();
  constructor(private readonly upstream: EventBus) {}
  async publish(event: EventRecord): Promise<void> { await this.upstream.publish(event); }
  async subscribe(jobId: string, wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> {
    const unsubscribe = await this.upstream.subscribe(jobId, wake);
    this.unsubscribers.add(unsubscribe);
    return async (): Promise<void> => { this.unsubscribers.delete(unsubscribe); await unsubscribe(); };
  }
  async subscribeAll(wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> {
    const unsubscribe = await this.upstream.subscribeAll(wake);
    this.unsubscribers.add(unsubscribe);
    return async (): Promise<void> => { this.unsubscribers.delete(unsubscribe); await unsubscribe(); };
  }
  async close(): Promise<void> {
    const pending = [...this.unsubscribers].map(unsubscribe => unsubscribe());
    this.unsubscribers.clear(); await Promise.all(pending);
  }
}
export function arg(args: string[], name: string, fallback = ''): string { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; }
export function hasArg(args: string[], name: string): boolean { return args.includes(name); }
async function readStdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  return Buffer.concat(chunks).toString('utf8');
}
export async function textOption(args: string[], inlineFlag: string, fileFlag: string): Promise<string> {
  if (hasArg(args, inlineFlag) && hasArg(args, fileFlag)) throw new Error(`${inlineFlag} and ${fileFlag} are mutually exclusive`);
  if (hasArg(args, fileFlag)) {
    const path = arg(args, fileFlag);
    if (!path) throw new Error(`${fileFlag} requires a path or - for stdin`);
    return path === '-' ? readStdinText() : readFile(path, 'utf8');
  }
  return arg(args, inlineFlag);
}
export function integerArg(args: string[], name: string, fallback: number): number { if (!hasArg(args, name)) return fallback; const value = Number(arg(args, name)); if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`); return value; }
export function repository(args: string[]): string { const value = arg(args, '--repo'); if (!value && noGitHubMode(args)) return basename(process.cwd()); if (!value) throw new Error('--repo must name the local Git root directory'); return value; }
export function pullRequest(args: string[]): number { const value = Number(arg(args, '--pr')); if (!Number.isInteger(value) || value <= 0) throw new Error('--pr is required for GitHub-backed operation'); return value; }
async function localStore(file: string): Promise<{ store: InMemoryStore; job: Job }> { const parsed = JSON.parse(await readFile(file, 'utf8')) as Job; const store = new InMemoryStore(parsed); return { store, job: await store.load(parsed.id) }; }
/** The public read-only commands must fail closed on ambiguous Job bindings. */
function validateReadOnlyJobBinding(args: string[]): void {
  for (const flag of ['--id','--repo','--pr','--file','--store-dir','--task-id','--plan-id','--execution-id']) {
    const count=args.filter(value=>value===flag).length;
    if (count>1) throw new Error(`${flag} may not be repeated`);
    if (count===1 && (!arg(args,flag) || arg(args,flag).startsWith('--')))
      throw new Error(`${flag} requires a value`);
  }
  if (!hasArg(args,'--id')) throw new Error('--id is required for read-only Relay commands');
  if (hasArg(args,'--pr')) {
    const pr=Number(arg(args,'--pr'));
    if (!Number.isSafeInteger(pr) || pr<=0) throw new Error('--pr must be a positive integer');
  }
}
export async function storeFor(args: string[], allowIdOnly = false, optionalRepo = false): Promise<{ store: DurableStore; job: Job; localFile: string | null }> {
  if (allowIdOnly) validateReadOnlyJobBinding(args);
  const file = arg(args, '--file');
  if (file) {
    const loaded = await localStore(file);
    if (allowIdOnly || optionalRepo) {
      const requestedId=arg(args,'--id'), requestedRepo=arg(args,'--repo');
      if (requestedId!==loaded.job.id) throw new Error('Local --file Job ID binding mismatch');
      if (requestedRepo && loaded.job.repository!==requestedRepo)
        throw new Error('Local --file repository binding mismatch');
      const boundPr=loaded.job.prNumber>0 ? loaded.job.prNumber:0;
      if (hasArg(args,'--pr') && boundPr!==Number(arg(args,'--pr')))
        throw new Error('Local --file PR binding mismatch');
    }
    return { ...loaded, localFile: file };
  }
  const repo = allowIdOnly || optionalRepo ? arg(args, '--repo') : noGitHubMode(args) ? repository(args) : arg(args, '--repo');
  const jobId = arg(args, '--id');
  if (!jobId || (!repo && !allowIdOnly && !optionalRepo)) throw new Error('Local Job requires --id and, for this operation, --repo (or explicit --file)');
  const directory = arg(args, '--store-dir') || relayStoreDirectory();
  if (allowIdOnly) {
    // Read-only CLI must not initialize SQLiteRelayStore: its constructor
    // runs migrations and reclaims processing outbox actions.
    const selected = await findJobIdSnapshot(directory, jobId);
    if (!selected || (repo && selected.job.repository !== repo))
      throw new Error('Immutable local Job not found for repository: ' + jobId);
    const job = normalizeRelayJob(JSON.stringify(selected.job));
    const suppliedPr = arg(args, '--pr');
    if (suppliedPr && (job.prNumber > 0 ? job.prNumber : 0) !== Number(suppliedPr))
      throw new Error('Local Job/PR binding mismatch');
    return { store: new InMemoryStore(job), job, localFile: null };
  }
  const binding = await createJobIdRegistryResolver(directory, new Map())(jobId);
  if (!binding || (repo && binding.job.repository !== repo))
    throw new Error('Immutable local Job not found for repository: ' + jobId);
  const suppliedPr = arg(args, '--pr');
  const boundPr = binding.job.prNumber > 0 ? binding.job.prNumber : 0;
  if (suppliedPr && boundPr !== Number(suppliedPr))
    throw new Error('Local Job/PR binding mismatch');
  return { store: binding.store, job: await binding.store.load(jobId), localFile: null };
}
export async function saveLocal(file: string | null, job: Job): Promise<void> { if (file) await writeFile(file, JSON.stringify(job, null, 2)); }

export function optionalLegacyPr(args: string[]): number | undefined {
  if (!hasArg(args, '--pr')) return undefined;
  const value = Number(arg(args, '--pr'));
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('--pr must be a positive integer (deprecated; use --id for normal operations)');
  return value;
}

export async function relayControlJob(args: string[], jobId: string): Promise<Job> {
  const host = arg(args, '--host', '127.0.0.1');
  const port = Number(arg(args, '--port', String(SERVICE_DEFAULTS.port)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
  let response: Response;
  const params = new URLSearchParams({ id: jobId });
  const repo = arg(args, '--repo');
  const legacyPr = optionalLegacyPr(args);
  if (repo) params.set('repo', repo);
  // Accept legacy PR bindings as additional fences, but never require them.
  if (legacyPr !== undefined) params.set('pr', String(legacyPr));
  try { response = await fetch(`http://${host}:${port}/api/job?${params.toString()}`); }
  catch (error) { throw new Error(`Agents Relay service unavailable at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`Agents Relay job request failed: ${await response.text() || `HTTP ${response.status}`}`);
  return await response.json() as Job;
}

export async function relayControlCommand<T = unknown>(args: string[], body: Record<string, unknown>): Promise<T> {
  const host = arg(args, '--host', '127.0.0.1');
  const port = Number(arg(args, '--port', String(SERVICE_DEFAULTS.port)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
  let response: Response;
  try { response = await fetch(`http://${host}:${port}/api/control`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (error) { throw new Error(`Agents Relay service unavailable at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`Agents Relay control command failed: ${await response.text() || `HTTP ${response.status}`}`);
  return await response.json() as T;
}

export async function relayJobList(args: string[]): Promise<Job[]> {
  const host = arg(args, '--host', '127.0.0.1');
  const port = Number(arg(args, '--port', String(SERVICE_DEFAULTS.port)));
  const repo = arg(args, '--repo');
  const query = new URLSearchParams({ inventory: '1' });
  if (repo) query.set('repo', repo);
  let response: Response;
  try { response = await fetch(`http://${host}:${port}/api/jobs?${query.toString()}`); }
  catch (error) { throw new Error(`Agents Relay service unavailable at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`Agents Relay jobs request failed: ${await response.text() || `HTTP ${response.status}`}`);
  // /api/jobs serves a paged dashboard envelope rather than a bare array.
  const payload: unknown = await response.json();
  const rows = Array.isArray(payload) ? payload :
    (payload && typeof payload === 'object' && 'jobs' in payload ? (payload as { jobs: unknown }).jobs : undefined);
  if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== 'object' ||
      typeof row.repository !== 'string' || typeof row.id !== 'string')) {
    throw new Error('Invalid Relay jobs response: expected an array of Job summaries');
  }
  const jobs = rows as Job[];
  return repo ? jobs.filter(job => job.repository === repo) : jobs;
}

export async function relayJobStateCommand(args: string[], jobId: string, state: Job['state']): Promise<Job> {
  const host = arg(args, '--host', '127.0.0.1');
  const port = Number(arg(args, '--port', String(SERVICE_DEFAULTS.port)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
  const params = new URLSearchParams({ id: jobId, state });
  const repo = arg(args, '--repo');
  const legacyPr = optionalLegacyPr(args);
  if (repo) params.set('repo', repo);
  if (legacyPr !== undefined) params.set('pr', String(legacyPr));
  let response: Response;
  try { response = await fetch(`http://${host}:${port}/api/job-state?${params.toString()}`, { method: 'POST' }); }
  catch (error) { throw new Error(`Agents Relay service unavailable at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`Agents Relay job state command failed: ${await response.text() || `HTTP ${response.status}`}`);
  return await response.json() as Job;
}
export async function relayTaskCommand(args: string[], body: { jobId: string; taskId?: string; action: 'create'|'start'|'retry'|'cancel'|'complete'|'update'; summary?: string; task?: Task; expectedUpdatedAt?: string; idempotencyKey?: string }): Promise<Job & { createdTaskId?: string }> {
  const host = arg(args, '--host', '127.0.0.1');
  const port = Number(arg(args, '--port', String(SERVICE_DEFAULTS.port)));
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be an integer between 1 and 65535');
  let response: Response;
  try { response = await fetch(`http://${host}:${port}/api/task-command`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); }
  catch (error) { throw new Error(`Agents Relay service unavailable at ${host}:${port}: ${error instanceof Error ? error.message : String(error)}`); }
  if (!response.ok) throw new Error(`Agents Relay task command failed: ${await response.text() || `HTTP ${response.status}`}`);
  return await response.json() as Job & { createdTaskId?: string };
}
export type EventBusResolution = { bus: EventBus | undefined; transport: 'nats' | 'none'; source: 'explicit' | 'auto' | 'unavailable' | 'local'; natsUrl: string };
export async function resolveEventBus(args: string[], probe?: (bus: NatsEventBus) => Promise<boolean>): Promise<EventBusResolution> {
  const explicit = hasArg(args, '--events');
  const requested = arg(args, '--events');
  const runtime = resolveEventsBusRuntime();
  const natsUrl = arg(args, '--nats-url', runtime.natsUrl);
  if (!explicit && hasArg(args, '--file')) return { bus: undefined, transport: 'none', source: 'local', natsUrl };
  if (explicit && requested !== 'nats') return { bus: undefined, transport: 'none', source: 'explicit', natsUrl };
  const subjectPrefix = arg(args, '--subject-prefix', runtime.subjectPrefix);
  const bus = new NatsEventBus(natsUrl, subjectPrefix);
  if (explicit) return { bus, transport: 'nats', source: 'explicit', natsUrl };
  const reachable = probe ? await probe(bus) : await bus.ping().then(() => true, () => false);
  await bus.close().catch(() => undefined);
  if (!reachable) return { bus: undefined, transport: 'none', source: 'unavailable', natsUrl };
  return { bus: new NatsEventBus(natsUrl, subjectPrefix), transport: 'nats', source: 'auto', natsUrl };
}
export function eventBusResolutionMessage(resolution: EventBusResolution): string {
  if (resolution.transport === 'nats') return `event transport: nats (${resolution.source === 'auto' ? 'auto-detected' : 'explicit'})`;
  if (resolution.source === 'explicit') return 'event transport: none (explicit)';
  if (resolution.source === 'local') return 'event transport: none (local mode)';
  return 'event transport: none (NATS unavailable)';
}
export async function eventBus(args: string[]): Promise<EventBus | undefined> {
  const resolution = await resolveEventBus(args);
  process.stderr.write(`${eventBusResolutionMessage(resolution)}\n`);
  return resolution.bus;
}
export async function withEventBus<T>(
  args: string[],
  work: (bus: EventBus | undefined) => Promise<T>,
  resolve: (args: string[]) => Promise<EventBus | undefined> = eventBus,
): Promise<T> {
  const bus = await resolve(args);
  try {
    return await work(bus);
  } finally {
    if (bus?.close) {
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 1_500); });
      try { await Promise.race([bus.close(), deadline]); }
      catch (error) { process.stderr.write('warning: event bus close failed: ' + (error instanceof Error ? error.message : String(error)) + '\n'); }
      finally { if (timer) clearTimeout(timer); }
    }
  }
}
export async function publishWake(bus: EventBus | undefined, job: Job, taskId: string, message: string): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'job.wake', 'queued', message, 'orchestrator', { repository: job.repository, prNumber: job.prNumber })); } catch (error) { process.stderr.write(`warning: event wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
export async function publishTaskUnblocked(bus: EventBus | undefined, job: Job, taskId: string, reason: string): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'task.unblocked', 'unblocked', `Task ${taskId} unblocked: ${reason}`, 'orchestrator', { repository: job.repository, prNumber: job.prNumber, reason })); } catch (error) { process.stderr.write(`warning: unblock event unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
export async function publishTaskBlocked(bus: EventBus | undefined, job: Job, taskId: string, reason: string, data?: Record<string, unknown>): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'task.blocked', 'blocked', `Task ${taskId} blocked: ${reason}`, 'orchestrator', { repository: job.repository, prNumber: job.prNumber, reason, ...data })); } catch (error) { process.stderr.write(`warning: block event unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
export async function publishDependentUnblocked(bus: EventBus | undefined, targets: readonly { repository: string; prNumber: number; jobId: string; taskId: string }[], reason: string): Promise<void> { if (!bus) return; for (const target of targets) { try { await bus.publish(eventFor(target.jobId, target.taskId, null, 'task.unblocked', 'unblocked', `Task ${target.taskId} unblocked: ${reason}`, 'orchestrator', { repository: target.repository, prNumber: target.prNumber, reason })); } catch (error) { process.stderr.write(`warning: dependent unblock event unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } } }
export async function requestManagedReconciliation(bus: EventBus | undefined, job: Job): Promise<void> {
  if (!bus) throw new Error('Managed GitHub reconciliation requires a reachable NATS event bus (auto-detected when available, or explicit with --events nats)');
  try {
    await bus.publish(eventFor(job.id, 'reconcile', null, 'job.wake', 'queued', `Reconcile requested for ${job.id}`, 'orchestrator', { repository: job.repository, prNumber: job.prNumber }));
  } catch (error) {
    throw new Error(`Unable to deliver managed reconciliation wake to agents-relayd: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export function priority(args: string[], fallback: Priority = 'P2'): Priority { const value = arg(args, '--priority', fallback); if (!['P0','P1','P2','P3'].includes(value)) throw new Error('--priority must be P0, P1, P2, or P3'); return value as Priority; }
export function storySize(args: string[], fallback: StorySize = 'M'): StorySize { const value = arg(args, '--story-size', fallback).toUpperCase(); if (!['S','M','L'].includes(value)) throw new Error('--story-size must be S, M, or L'); return value as StorySize; }
export function chatGptTabClosePolicy(args: string[]): ChatGptTabClosePolicy {
  const value = arg(args, '--chatgpt-tab-close-policy', process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY || 'after-terminal');
  if (!['after-start', 'never', 'after-terminal'].includes(value)) throw new Error('--chatgpt-tab-close-policy must be after-start, never, or after-terminal');
  return value as ChatGptTabClosePolicy;
}
export function jobTagFromArgs(args: string[]): Job['tag'] | undefined { return parseJobTagJson(arg(args, '--tag')); }
export function continuation(args: string[]): Job['continuation'] { const kind = arg(args, '--continue-kind'); const target = arg(args, '--continue-target'); return kind && target ? { kind: kind as NonNullable<Job['continuation']>['kind'], target, input: arg(args, '--continue-input') || undefined } : null; }
/** Removed Job options fail closed rather than silently accepting obsolete scheduling. */
export function rejectRemovedJobOptions(args: string[]): void {
  const obsolete = ['--mode','--execution-mode','--schedule','--schedule-next-run','--schedule-timezone','--missed-run-policy','--schedule-concurrency','--cron','--schedule-cron'].find(option => hasArg(args, option));
  if (obsolete) throw new Error(`Unsupported Job option ${obsolete}: every Job replans to objective satisfaction and scheduling is unavailable`);
}
