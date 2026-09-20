#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { dashboardManagedJobs, InMemoryStore, DurableStore, GitHubClient, GitHubStore, PullRequest, resolvePullRequest, listManagedGitHubJobs } from './store.js';
import { githubAuthContext } from './github-auth.js';
import { EventRecord, Job, Task, AdapterName, RoutingDecision, ExecutionMode } from './types.js';
import { Reconciler } from './reconciler.js';
import { ShellAdapter, CodexAdapter, ChatGptAdapter } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { NatsEventBus, eventFor, EventBus } from './events.js';
import { serveDashboard } from './dashboard.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { Server } from 'node:http';
import { AgentRegistration, Priority } from './types.js';
import { discoverAgents } from './registry.js';
import { AgentObjectivePlanner, CommandObjectivePlanner } from './planner.js';
import { extendRetryBudget } from './scheduler.js';
const usage = 'agents-relay <job|task|init|submit|record|agent-register|agent-discover|status|reconcile|retry|cancel|serve> [options]';
const help = {
  root: `Agents Relay coordinates durable asynchronous agent jobs through GitHub pull requests.

Usage:
  npx agents-relay <command> [options]

Commands:
  job create|adopt|repair  Create or repair a durable GitHub-backed job
  task update              Update mutable durable task fields in place
  init                     Create a local demo job or initialize a GitHub job
  submit                   Queue a task for a managed job
  record                   Backfill a completed task into durable history
  agent-register           Register an agent role and its capabilities
  agent-discover           Find registered agents matching hard filters
  status                   Show the durable job state
  reconcile                Run reconciliation once
  retry|cancel             Change a task state
  serve                    Run the dashboard and reconciliation service

Run 'npx agents-relay <command> --help' for command options and examples.
Use 'node dist/cli.js' only for explicit local development/demo mode.`,
  job: `Manage a GitHub-backed durable job.

Usage:
  npx agents-relay job <create|adopt|repair> [options]

Actions:
  create  Find or create an open PR, then persist its job marker
  adopt   Attach a job marker to an existing PR
  repair  Repair duplicate markers for the same job

Common options:
  --repo OWNER/REPO       GitHub repository (required)
  --id JOB_ID              Durable job identifier (required)
  --pr NUMBER              Existing PR number (required for adopt/repair)
  --title TEXT             Job title
  --objective TEXT         Objective for autonomous mode
  --mode fixed|autonomous  Execution mode (default: fixed)

Example:
  npx agents-relay job create --repo OWNER/REPO --head feat/example --base main --id job-1`,
  'job create': `Create or reuse an open PR and persist one durable job marker.

Required: --repo OWNER/REPO, --id JOB_ID, and --head BRANCH.
Common: --base BRANCH (default: main), --title TEXT, --body TEXT, --mode fixed|autonomous.

Example:
  npx agents-relay job create --repo OWNER/REPO --head feat/example --base main --id job-1 --title "Objective"`,
  'job adopt': `Adopt an existing PR as a durable job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID.
Common: --title TEXT, --objective TEXT, --mode fixed|autonomous.

Example:
  npx agents-relay job adopt --repo OWNER/REPO --pr 12 --id job-12 --title "Objective"`,
  'job repair': `Repair duplicate durable markers for an existing job.

Required: --repo OWNER/REPO, --pr NUMBER, and --id JOB_ID.

Example:
  npx agents-relay job repair --repo OWNER/REPO --pr 12 --id job-12`,
  task: `Manage a durable task.

Usage:
  npx agents-relay task update [options]

Actions:
  update  Update mutable task fields without changing task identity/history`,
  'task update': `Update mutable durable task fields in place.

Required: --task-id ID and the normal job storage options.
Mutable while not RUNNING/SUCCEEDED/CANCELLED: --adapter, --priority, --input, --project, --agent, --parent, --deps, --capabilities, --timeout, --max-attempts, --provider, --model, --profile, --reasoning, --cwd, --chatgpt-project.
Use --clear-routing to remove routing metadata. A model update requires --model; provider defaults to the existing provider or openai.

Example:
  npx agents-relay task update --repo OWNER/REPO --pr 12 --id job-1 --task-id build --adapter chatgpt --provider chatgpt --model gpt-5.6-sol --reasoning high`,
  submit: `Queue a task for a managed job.

Required: --repo OWNER/REPO, --pr NUMBER, --id JOB_ID, and --input TEXT.
Common: --task-id ID, --adapter shell|codex|chatgpt, --priority P0|P1|P2|P3, --max-attempts N.

Example:
  npx agents-relay submit --repo OWNER/REPO --pr 12 --id job-1 --task-id build --input "npm test"`,
  record: `Backfill work completed outside the relay into durable history.

Required: --file PATH or --repo/--pr/--id, plus --summary TEXT.
Common: --task-id ID, --commit SHA, --project NAME.

Example:
  npx agents-relay record --file .agents-relay.json --summary "Built release" --commit abc123`,
  status: `Show the durable state for a job.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --pr NUMBER --id JOB_ID.

Example:
  npx agents-relay status --repo OWNER/REPO --pr 12 --id job-1`,
  reconcile: `Reconcile a job once, launching ready tasks and persisting results.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --pr NUMBER --id JOB_ID.

Example:
  npx agents-relay reconcile --repo OWNER/REPO --pr 12 --id job-1`,
  init: `Initialize a new job. GitHub mode requires --repo and --pr; local mode requires explicit --file.

Common: --id ID, --title TEXT, --objective TEXT, --mode fixed|autonomous, --priority P0|P1|P2|P3.

Example:
  npx agents-relay init --repo OWNER/REPO --pr 12 --id job-1 --title "Objective"`,
  serve: `Run the dashboard and reconciliation service for a managed job.

Required: --file PATH for local demo mode, or --repo OWNER/REPO --pr NUMBER --id JOB_ID.
Common: --port PORT, --interval MS, --events nats.

Example:
  npx agents-relay serve --repo OWNER/REPO --pr 12 --id job-1`,
  'agent-register': `Register an agent role and its execution endpoint.

Required: --file PATH or managed GitHub options, plus --name NAME --responsibility TEXT --role ROLE --endpoint TARGET.
Common: --capabilities a,b, --runtime shell|codex|chatgpt, --provider NAME, --model NAME.

Example:
  npx agents-relay agent-register --file .agents-relay.json --name builder --responsibility "Build code" --role engineer --endpoint shell`,
  'agent-discover': `Find registered agents using hard filters.

Required: --file PATH or managed GitHub options.
Common: --capabilities a,b, --runtime NAME, --availability available,busy, --task-kind NAME, --explore.

Example:
  npx agents-relay agent-discover --file .agents-relay.json --capabilities shell`,
  retry: `Retry a task by setting it READY.

Required: --task-id ID and the normal job storage options.

Example:
  npx agents-relay retry --repo OWNER/REPO --pr 12 --id job-1 --task-id build`,
  cancel: `Cancel a task.

Required: --task-id ID and the normal job storage options.

Example:
  npx agents-relay cancel --repo OWNER/REPO --pr 12 --id job-1 --task-id build`
} as const;

export function helpText(command?: string, action?: string): string {
  if (command === 'job') return action ? help[`job ${action}` as keyof typeof help] ?? help.job : help.job;
  if (command === 'task') return action ? help[`task ${action}` as keyof typeof help] ?? help.task : help.task;
  return command ? help[command as keyof typeof help] ?? help.root : help.root;
}
export const SERVICE_DEFAULTS = { port: 8787, watchdogMs: 300000, webhookWatchdogMs: 1800000, dashboardRefreshMs: 300000 } as const;
class ServiceEventBus implements EventBus {
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
function arg(args: string[], name: string, fallback = ''): string { const index = args.indexOf(name); return index >= 0 ? args[index + 1] ?? fallback : fallback; }
function hasArg(args: string[], name: string): boolean { return args.includes(name); }
function integerArg(args: string[], name: string, fallback: number): number { if (!hasArg(args, name)) return fallback; const value = Number(arg(args, name)); if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`); return value; }
function repository(args: string[]): string { const value = arg(args, '--repo'); if (!value) throw new Error('--repo is required for GitHub-backed operation'); return value; }
function pullRequest(args: string[]): number { const value = Number(arg(args, '--pr')); if (!Number.isInteger(value) || value <= 0) throw new Error('--pr is required for GitHub-backed operation'); return value; }
async function localStore(file: string): Promise<{ store: InMemoryStore; job: Job }> { const parsed = JSON.parse(await readFile(file, 'utf8')) as Job; const store = new InMemoryStore(parsed); return { store, job: await store.load(parsed.id) }; }
async function githubStore(args: string[]): Promise<GitHubStore> { const auth = await githubAuthContext(args); return new GitHubStore(auth.client, repository(args), pullRequest(args), auth.trustedAuthors); }
async function storeFor(args: string[]): Promise<{ store: DurableStore; job: Job; localFile: string | null }> { const repo = arg(args, '--repo'); const pr = arg(args, '--pr'); if (repo && pr) { const store = await githubStore(args); const jobId = arg(args, '--id'); if (!jobId) throw new Error('--id is required for GitHub-backed operation'); return { store, job: await store.load(jobId), localFile: null }; } const file = arg(args, '--file'); if (!file) throw new Error('Local mode is demo/test only; pass --file explicitly'); const loaded = await localStore(file); return { store: loaded.store, job: loaded.job, localFile: file }; }
async function saveLocal(file: string | null, job: Job): Promise<void> { if (file) await writeFile(file, JSON.stringify(job, null, 2)); }
export function eventBus(args: string[]): EventBus | undefined { if (arg(args, '--events') !== 'nats') return undefined; return new NatsEventBus(arg(args, '--nats-url', 'nats://127.0.0.1:4222'), arg(args, '--subject-prefix', 'agents-relay.events.job')); }
async function publishWake(bus: EventBus | undefined, job: Job, taskId: string, message: string): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'job.wake', 'queued', message, 'orchestrator', { repository: job.repository, prNumber: job.prNumber })); } catch (error) { process.stderr.write(`warning: event wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
function priority(args: string[], fallback: Priority = 'P2'): Priority { const value = arg(args, '--priority', fallback); if (!['P0','P1','P2','P3'].includes(value)) throw new Error('--priority must be P0, P1, P2, or P3'); return value as Priority; }
export function executionMode(args: string[], fallback: ExecutionMode = 'fixed'): ExecutionMode { const value = arg(args, '--mode', arg(args, '--execution-mode', fallback)); if (value !== 'fixed' && value !== 'autonomous') throw new Error('--mode must be fixed or autonomous'); return value; }
function requestedExecutionMode(args: string[]): ExecutionMode | undefined { const value = arg(args, '--mode', arg(args, '--execution-mode')); return value ? executionMode(args) : undefined; }
function continuation(args: string[]): Job['continuation'] { const kind = arg(args, '--continue-kind'); const target = arg(args, '--continue-target'); return kind && target ? { kind: kind as NonNullable<Job['continuation']>['kind'], target, input: arg(args, '--continue-input') || undefined } : null; }

export async function ensureManagedGitHubJob(
  client: GitHubClient,
  repositoryName: string,
  trustedAuthors: ReadonlySet<string>,
  options: { id: string; title?: string; objective?: string; priority?: Priority; executionMode?: ExecutionMode; continuation?: Job['continuation']; prNumber?: number; head?: string; base?: string; body?: string }
): Promise<{ job: Job; pr: PullRequest }> {
  if (!options.id) throw new Error('--id is required for managed GitHub jobs');
  const pr = await resolvePullRequest(client, repositoryName, { prNumber: options.prNumber, head: options.head, base: options.base, title: options.title, body: options.body });
  const store = new GitHubStore(client, repositoryName, pr.number, trustedAuthors);
  let job: Job;
  try {
    job = await store.load(options.id);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('has no durable')) throw error;
    const now = new Date().toISOString();
    job = { id: options.id, title: options.title || pr.title || 'Agents Relay job', objective: options.objective || pr.body || undefined, description: pr.body || undefined, priority: options.priority ?? 'P2', executionMode: options.executionMode ?? 'fixed', prNumber: pr.number, repository: repositoryName, state: 'OPEN', continuation: options.continuation ?? null, createdAt: now, updatedAt: now, tasks: [] };
  }
  if (!job.description && pr.body) job.description = pr.body;
  if (options.objective) job.objective = options.objective;
  if (options.executionMode) job.executionMode = options.executionMode;
  if (options.priority) job.priority = options.priority;
  else if (!job.priority) job.priority = 'P2';
  if (!job.title && pr.title) job.title = pr.title;
  await store.saveJob(job);
  return { job: await store.load(options.id), pr };
}

async function runTaskCommand(action: string, args: string[]): Promise<void> {
  if (action !== 'update') throw new Error(usage);
  const { store, job, localFile } = await storeFor(args);
  const id = arg(args, '--task-id');
  if (!id) throw new Error('task update requires --task-id');
  const task = job.tasks.find(item => item.id === id);
  if (!task) throw new Error(`Task ${id} not found`);
  if (['RUNNING', 'SUCCEEDED', 'CANCELLED'].includes(task.state)) throw new Error(`Task ${id} is ${task.state}; durable execution fields are immutable in this state`);

  if (hasArg(args, '--adapter')) {
    const adapter = arg(args, '--adapter') as AdapterName;
    if (!['shell', 'codex', 'chatgpt', 'orchestrator'].includes(adapter)) throw new Error('--adapter must be shell, codex, chatgpt, or orchestrator');
    task.adapter = adapter;
  }
  if (hasArg(args, '--priority')) task.priority = priority(args, task.priority ?? job.priority ?? 'P2');
  if (hasArg(args, '--input')) task.input = arg(args, '--input');
  if (hasArg(args, '--project')) task.projectName = arg(args, '--project') || undefined;
  if (hasArg(args, '--agent')) task.agentName = arg(args, '--agent') || undefined;
  if (hasArg(args, '--parent')) task.parentTaskId = arg(args, '--parent') || null;
  if (hasArg(args, '--deps')) task.dependencies = arg(args, '--deps').split(',').filter(Boolean);
  if (hasArg(args, '--capabilities')) task.capabilities = arg(args, '--capabilities').split(',').filter(Boolean);
  task.timeoutMs = integerArg(args, '--timeout', task.timeoutMs);
  task.maxAttempts = integerArg(args, '--max-attempts', task.maxAttempts);
  if (hasArg(args, '--max-attempts') && task.maxAttempts < task.attempt) throw new Error('--max-attempts cannot be less than the current attempt count');

  const routingFlags = ['--provider','--model','--profile','--reasoning','--cwd','--chatgpt-project'];
  if (args.includes('--clear-routing')) task.routing = undefined;
  else if (routingFlags.some(flag => hasArg(args, flag))) {
    const current = task.routing;
    const model = hasArg(args, '--model') ? arg(args, '--model') : current?.model;
    if (!model) throw new Error('task routing update requires --model when no existing routing is present');
    task.routing = {
      provider: hasArg(args, '--provider') ? arg(args, '--provider') : current?.provider ?? 'openai',
      model,
      profile: hasArg(args, '--profile') ? arg(args, '--profile') || undefined : current?.profile,
      reasoning: hasArg(args, '--reasoning') ? arg(args, '--reasoning') || undefined : current?.reasoning,
      cwd: hasArg(args, '--cwd') ? arg(args, '--cwd') || undefined : current?.cwd,
      projectId: hasArg(args, '--chatgpt-project') ? arg(args, '--chatgpt-project') || undefined : current?.projectId,
      decidedBy: 'cli:update',
      decidedAt: new Date().toISOString()
    };
  }
  task.updatedAt = new Date().toISOString();
  await store.saveTask(task);
  await saveLocal(localFile, job);
  console.log(JSON.stringify(task, null, 2));
}

async function runJobCommand(action: string, args: string[]): Promise<void> {
  if (!['create', 'adopt', 'repair'].includes(action)) throw new Error(usage);
  const repo = repository(args);
  const id = arg(args, '--id');
  if (!id) throw new Error('--id is required for managed GitHub jobs');
  const auth = await githubAuthContext(args);
  const client = auth.client;
  const trustedAuthors = auth.trustedAuthors;
  const prValue = arg(args, '--pr');
  const prNumber = prValue ? Number(prValue) : undefined;
  if (prValue && (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0)) throw new Error('--pr must be a positive integer');
  if ((action === 'adopt' || action === 'repair') && !prNumber) throw new Error(`job ${action} requires --pr`);
  const result = await ensureManagedGitHubJob(client, repo, trustedAuthors, {
    id,
    title: arg(args, '--title') || undefined,
    objective: arg(args, '--objective') || undefined,
    priority: priority(args),
    executionMode: requestedExecutionMode(args),
    continuation: continuation(args),
    prNumber,
    head: arg(args, '--head') || undefined,
    base: arg(args, '--base', 'main'),
    body: arg(args, '--body') || undefined
  });
  console.log(JSON.stringify({ repository: repo, pr: result.pr.number, job: result.job.id, executionMode: result.job.executionMode, state: result.job.state }, null, 2));
}

export function runtimePlanner(args: readonly string[]): AgentObjectivePlanner | CommandObjectivePlanner { const plannerCommand = arg([...args], '--planner-command'); const modelRuntime = arg([...args], '--codex', 'codex'); return plannerCommand ? new CommandObjectivePlanner(plannerCommand) : new AgentObjectivePlanner(modelRuntime); }
export function runtime(store: DurableStore, args: string[], bus: EventBus | undefined): Reconciler { const emit = (event: ReturnType<typeof eventFor>): void => { process.stderr.write(`${JSON.stringify(event)}\n`); }; const modelRuntime = arg(args, '--codex', 'codex'); const planner = runtimePlanner(args); return new Reconciler(store, { owner: arg(args, '--owner', `cli-${process.pid}`), maxConcurrent: Number(arg(args, '--concurrency', '4')), leaseMs: Number(arg(args, '--lease-ms', '300000')), adapters: [new ShellAdapter(), new CodexAdapter(modelRuntime), new ChatGptAdapter()], continuations: [new CodexThreadContinuation(modelRuntime), new CommandContinuation(), new WebhookContinuation()], planner, eventBus: bus, emit }); }
export interface Service { store: DurableStore; job: Job; reconciler: Reconciler; dashboardServer: Server; watchdogCleared: boolean; stop(): Promise<void>; }
export async function createService(args: string[]): Promise<Service> {
  const loaded = await storeFor(args); const upstream = eventBus(args); const bus = upstream ? new ServiceEventBus(upstream) : undefined; const reconciler = runtime(loaded.store, args, bus);
  const requestedUsageDays = Number(arg(args, '--usage-window-days', '1'));
  const usageWindowDays = Number.isInteger(requestedUsageDays) && requestedUsageDays > 0 ? requestedUsageDays : 1;
  const usageRegistry = codexAndZaiUsageRegistry(undefined, usageWindowDays);
  const repo = arg(args, '--repo');
  let overviewProvider: (() => Promise<Awaited<ReturnType<typeof listManagedGitHubJobs>>>) | undefined;
  if (repo) {
    const overviewAuth = await githubAuthContext(args);
    overviewProvider = async () => dashboardManagedJobs(await listManagedGitHubJobs(overviewAuth.client, repo, overviewAuth.trustedAuthors));
  }
  const webhookSecret = arg(args, '--github-webhook-secret') || process.env.AGENTS_RELAY_GITHUB_WEBHOOK_SECRET || '';
  const webhook = repo && webhookSecret ? { secret: webhookSecret, repositories: new Set([repo]), pullRequest: loaded.job.prNumber, wake: (event: import('./github-webhook.js').GitHubWebhookWake): void => { const wakeEvent = eventFor(loaded.job.id, 'github', null, 'github.webhook', 'queued', 'GitHub webhook ' + event.event + (event.action ? ':' + event.action : ''), 'orchestrator', { deliveryId: event.deliveryId, event: event.event, action: event.action, repository: event.repository, prNumber: event.pullRequest }); if (bus) void bus.publish(wakeEvent); else void reconciler.reconcile(loaded.job.id); } } : undefined;
  const dashboardServer = serveDashboard(loaded.store, Number(arg(args, '--port', String(SERVICE_DEFAULTS.port))), bus, Number(arg(args, '--refresh-ms', String(SERVICE_DEFAULTS.dashboardRefreshMs))), loaded.job.id, usageRegistry, overviewProvider, webhook);
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
  console.log('Dashboard listening');
  try {
    await service.reconciler.reconcile(service.job.id);
  } catch (error) {
    console.error(`Initial reconciliation failed; dashboard remains available: ${error instanceof Error ? error.message : String(error)}`);
  }
  return service;
}
export function isEntrypoint(moduleUrl: string): boolean {
  const invoked = process.argv[1]; if (!invoked) return false;
  try { return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(invoked); } catch { return moduleUrl === `file://${invoked}`; }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === '--help' || command === '-h') { console.log(helpText()); return; }
  if (args.includes('--help') || args.includes('-h')) { console.log(helpText(command, command === 'job' || command === 'task' ? args[0] : undefined)); return; }
  if (command === 'job') { const [action, ...jobArgs] = args; await runJobCommand(action ?? '', jobArgs); return; }
  if (command === 'task') { const [action, ...taskArgs] = args; await runTaskCommand(action ?? '', taskArgs); return; }
  if (command === 'init') { const now = new Date().toISOString(); const job: Job = { id: arg(args, '--id', randomUUID()), title: arg(args, '--title', 'Agents Relay job'), objective: arg(args, '--objective') || undefined, priority: priority(args), executionMode: executionMode(args), prNumber: Number(arg(args, '--pr', '0')), repository: arg(args, '--repo'), state: 'OPEN', continuation: continuation(args), createdAt: now, updatedAt: now, tasks: [] }; let store: DurableStore; let file: string | null = null; if (arg(args, '--repo') && arg(args, '--pr')) store = await githubStore(args); else { file = arg(args, '--file'); if (!file) throw new Error('init requires --repo/--pr or explicit --file demo mode'); store = new InMemoryStore(job); } await store.saveJob(job); await saveLocal(file, job); console.log(`Initialized ${job.id}`); return; }
  const loaded = await storeFor(args); const { store, job, localFile } = loaded; const bus = eventBus(args);
  if (command === 'agent-register') {
    const now = new Date().toISOString();
    const agent: AgentRegistration = { id: arg(args, '--agent-id', randomUUID()), name: arg(args, '--name'), responsibility: arg(args, '--responsibility'), role: arg(args, '--role'), capabilities: arg(args, '--capabilities').split(',').filter(Boolean), boundaries: arg(args, '--boundaries').split('|').filter(Boolean), endpoint: { kind: arg(args, '--endpoint-kind', 'adapter') as 'adapter' | 'command' | 'http', target: arg(args, '--endpoint') }, runtime: { adapter: arg(args, '--runtime', arg(args, '--adapter', 'shell')), provider: arg(args, '--provider') || undefined, model: arg(args, '--model') || undefined }, availability: arg(args, '--availability', 'available') as AgentRegistration['availability'], routing: { labels: arg(args, '--labels').split(',').filter(Boolean).reduce<Record<string, string>>((out, item) => { const [key, value] = item.split('=', 2); if (key && value) out[key] = value; return out; }, {}), trustDomains: arg(args, '--trust-domains').split(',').filter(Boolean), regions: arg(args, '--regions').split(',').filter(Boolean) }, evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: null }, registeredAt: now, updatedAt: now };
    if (!agent.name || !agent.responsibility || !agent.role || !agent.endpoint.target) throw new Error('--name, --responsibility, --role, and --endpoint are required');
    await store.saveAgent(agent); console.log(`Registered ${agent.id}`); return;
  }
  if (command === 'agent-discover') { const candidates = discoverAgents(await store.listAgents(), { capabilities: arg(args, '--capabilities').split(',').filter(Boolean), runtime: arg(args, '--runtime') || undefined, availability: arg(args, '--availability').split(',').filter(Boolean) as AgentRegistration['availability'][], trustDomain: arg(args, '--trust-domain') || undefined, taskKind: arg(args, '--task-kind') || undefined, explore: args.includes('--explore') }); console.log(JSON.stringify(candidates, null, 2)); return; }
  if (command === 'record') {
    const now = new Date().toISOString(); const id = arg(args, '--task-id', randomUUID()); const summary = arg(args, '--summary');
    if (!summary) throw new Error('record requires --summary');
    const commit = arg(args, '--commit');
    const task: Task = { jobId: job.id, id, projectName: arg(args, '--project') || undefined, agentName: arg(args, '--agent', 'orchestrator'), parentTaskId: arg(args, '--parent') || null, dependencies: arg(args, '--deps').split(',').filter(Boolean), capabilities: [], adapter: 'orchestrator', input: arg(args, '--input', summary), continuation: null, continuationDeliveredAt: null, state: 'SUCCEEDED', attempt: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: commit || null, threadId: null, result: { summary, data: commit ? { commit } : undefined }, error: null, timeoutMs: 0, createdAt: now, updatedAt: now };
    await store.appendTask(task); job.tasks.push(task); await saveLocal(localFile, job); console.log(`Recorded ${id}`); return;
  }
  if (command === 'submit') { const now = new Date().toISOString(); const model = arg(args, '--model'); const routing = model ? { provider: arg(args, '--provider', 'openai'), model, profile: arg(args, '--profile') || undefined, reasoning: arg(args, '--reasoning') || undefined, cwd: arg(args, '--cwd') || undefined, projectId: arg(args, '--chatgpt-project') || undefined, decidedBy: 'cli', decidedAt: now } satisfies RoutingDecision : undefined; const task: Task = { jobId: job.id, id: arg(args, '--task-id', randomUUID()), priority: priority(args, job.priority ?? 'P2'), projectName: arg(args, '--project') || undefined, agentName: arg(args, '--agent') || undefined, parentTaskId: arg(args, '--parent') || null, dependencies: arg(args, '--deps').split(',').filter(Boolean), capabilities: arg(args, '--capabilities').split(',').filter(Boolean), adapter: arg(args, '--adapter', 'shell') as AdapterName, input: arg(args, '--input', 'true'), routing, continuation: continuation(args), continuationDeliveredAt: null, state: 'QUEUED', attempt: 0, maxAttempts: Number(arg(args, '--max-attempts', '3')), leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: Number(arg(args, '--timeout', '300000')), createdAt: now, updatedAt: now }; await store.appendTask(task); job.tasks.push(task); if (job.state === 'COMPLETED') { job.state = 'OPEN'; job.updatedAt = now; await store.saveJob(job); } await saveLocal(localFile, job); await publishWake(bus, job, task.id, `Task ${task.id} submitted`); console.log(`Submitted ${task.id}`); return; }
  if (command === 'status') { console.log(JSON.stringify(await store.load(job.id), null, 2)); return; }
  if (command === 'retry' || command === 'cancel') { const id = arg(args, '--task-id'); const task = job.tasks.find(item => item.id === id); if (!task) throw new Error(`Task ${id} not found`); if (command === 'retry') task.maxAttempts = extendRetryBudget(task); task.state = command === 'retry' ? 'READY' : 'CANCELLED'; task.error = command === 'retry' ? null : 'Cancelled by user'; task.updatedAt = new Date().toISOString(); await store.saveTask(task); await saveLocal(localFile, job); await publishWake(bus, job, task.id, `${task.id} ${command} requested`); console.log(`${id}: ${task.state}`); return; }
  const reconciler = runtime(store, args, bus);
  if (command === 'reconcile') { await reconciler.reconcile(job.id); await reconciler.idle(); const finalState = await store.load(job.id); await saveLocal(localFile, finalState); console.log(JSON.stringify(finalState, null, 2)); return; }
  if (command === 'serve') { await startService(args); return; }
  throw new Error(usage);
}
if (isEntrypoint(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
