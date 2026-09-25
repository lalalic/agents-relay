import { readFile, writeFile } from 'node:fs/promises';
import { InMemoryStore, DurableStore, GitHubStore } from './store.js';
import { githubAuthContext } from './github-auth.js';
import { EventRecord, Job, ExecutionMode, ChatGptTabClosePolicy, StorySize, Priority } from './types.js';
import { NatsEventBus, eventFor, EventBus } from './events.js';
import { parseJobSchedule } from './scheduler.js';

export const SERVICE_DEFAULTS = { port: 8787, watchdogMs: 300000, webhookWatchdogMs: 1800000, dashboardRefreshMs: 300000 } as const;
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
export function repository(args: string[]): string { const value = arg(args, '--repo'); if (!value) throw new Error('--repo is required for GitHub-backed operation'); return value; }
export function pullRequest(args: string[]): number { const value = Number(arg(args, '--pr')); if (!Number.isInteger(value) || value <= 0) throw new Error('--pr is required for GitHub-backed operation'); return value; }
async function localStore(file: string): Promise<{ store: InMemoryStore; job: Job }> { const parsed = JSON.parse(await readFile(file, 'utf8')) as Job; const store = new InMemoryStore(parsed); return { store, job: await store.load(parsed.id) }; }
export async function githubStore(args: string[]): Promise<GitHubStore> { const auth = await githubAuthContext(args); return new GitHubStore(auth.client, repository(args), pullRequest(args), auth.trustedAuthors); }
export async function storeFor(args: string[]): Promise<{ store: DurableStore; job: Job; localFile: string | null }> { const repo = arg(args, '--repo'); const pr = arg(args, '--pr'); if (repo && pr) { const store = await githubStore(args); const jobId = arg(args, '--id'); if (!jobId) throw new Error('--id is required for GitHub-backed operation'); return { store, job: await store.load(jobId), localFile: null }; } const file = arg(args, '--file'); if (!file) throw new Error('Local mode is demo/test only; pass --file explicitly'); const loaded = await localStore(file); return { store: loaded.store, job: loaded.job, localFile: file }; }
export async function saveLocal(file: string | null, job: Job): Promise<void> { if (file) await writeFile(file, JSON.stringify(job, null, 2)); }
export function eventBus(args: string[]): EventBus | undefined { if (arg(args, '--events') !== 'nats') return undefined; return new NatsEventBus(arg(args, '--nats-url', 'nats://127.0.0.1:4222'), arg(args, '--subject-prefix', 'neo.events.job')); }
export async function publishWake(bus: EventBus | undefined, job: Job, taskId: string, message: string): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'job.wake', 'queued', message, 'orchestrator', { repository: job.repository, prNumber: job.prNumber })); } catch (error) { process.stderr.write(`warning: event wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
export async function requestManagedReconciliation(bus: EventBus | undefined, job: Job): Promise<void> {
  if (!bus) throw new Error('Managed GitHub reconciliation requires --events nats so agents-relayd can execute the job');
  try {
    await bus.publish(eventFor(job.id, 'reconcile', null, 'job.wake', 'queued', `Reconcile requested for ${job.id}`, 'orchestrator', { repository: job.repository, prNumber: job.prNumber }));
  } catch (error) {
    throw new Error(`Unable to deliver managed reconciliation wake to agents-relayd: ${error instanceof Error ? error.message : String(error)}`);
  }
}
export function priority(args: string[], fallback: Priority = 'P2'): Priority { const value = arg(args, '--priority', fallback); if (!['P0','P1','P2','P3'].includes(value)) throw new Error('--priority must be P0, P1, P2, or P3'); return value as Priority; }
export function storySize(args: string[], fallback: StorySize = 'M'): StorySize { const value = arg(args, '--story-size', fallback).toUpperCase(); if (!['S','M','L'].includes(value)) throw new Error('--story-size must be S, M, or L'); return value as StorySize; }
export function executionMode(args: string[], fallback: ExecutionMode = 'fixed'): ExecutionMode { const value = arg(args, '--mode', arg(args, '--execution-mode', fallback)); if (value !== 'fixed' && value !== 'autonomous') throw new Error('--mode must be fixed or autonomous'); return value; }
export function chatGptTabClosePolicy(args: string[]): ChatGptTabClosePolicy {
  const value = arg(args, '--chatgpt-tab-close-policy', process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY || 'after-start');
  if (!['after-start', 'never', 'after-terminal'].includes(value)) throw new Error('--chatgpt-tab-close-policy must be after-start, never, or after-terminal');
  return value as ChatGptTabClosePolicy;
}
export function requestedExecutionMode(args: string[]): ExecutionMode | undefined { const value = arg(args, '--mode', arg(args, '--execution-mode')); return value ? executionMode(args) : undefined; }
export function continuation(args: string[]): Job['continuation'] { const kind = arg(args, '--continue-kind'); const target = arg(args, '--continue-target'); return kind && target ? { kind: kind as NonNullable<Job['continuation']>['kind'], target, input: arg(args, '--continue-input') || undefined } : null; }
export function scheduleFromArgs(args: string[]): Job['schedule'] {
  const cron = arg(args, '--schedule');
  if (!cron) return undefined;
  const nextRunAt = arg(args, '--schedule-next-run') || undefined;
  return parseJobSchedule({
    cron,
    timezone: arg(args, '--schedule-timezone', 'UTC'),
    nextRunAt,
    missedRunPolicy: arg(args, '--missed-run-policy', 'skip') as 'run' | 'skip',
    concurrencyPolicy: arg(args, '--schedule-concurrency', 'skip') as 'skip' | 'queue',
  });
}
