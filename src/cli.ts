#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { InMemoryStore, DurableStore, GhApiClient, GitHubClient, GitHubStore, PullRequest, resolvePullRequest, listManagedGitHubJobs, AgentRegistryScope, repositoryAgentScope } from './store.js';
import { EventRecord, Job, Task, AdapterName, RoutingDecision } from './types.js';
import { Reconciler } from './reconciler.js';
import { ShellAdapter, CodexAdapter, ChatGptAdapter } from './adapters.js';
import { CodexThreadContinuation, CommandContinuation, WebhookContinuation } from './continuation.js';
import { NatsEventBus, eventFor, EventBus } from './events.js';
import { serveDashboard } from './dashboard.js';
import { codexAndZaiUsageRegistry } from './usage.js';
import { Server } from 'node:http';
import { AgentRegistration } from './types.js';
import { discoverAgents, scoreAgentCapabilities } from './registry.js';
const usage = 'agents-relay <job create|job adopt|job repair|agent register|agent list|agent show|agent discover|agent eval|agent scores|init|submit|record|agent-register|agent-discover|status|reconcile|retry|cancel|serve> [options]';
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
async function githubRegistryStore(args: string[]): Promise<GitHubStore> { const client = new GhApiClient(); const login = await client.currentLogin(); const trusted = new Set([login, ...csv(args, '--trusted-authors')]); return new GitHubStore(client, repository(args), 0, trusted); }
function csv(args: string[], name: string): string[] { return [...new Set(arg(args, name).split(',').map(value => value.trim()).filter(Boolean))]; }
function capabilityArgs(args: string[]): string[] { return [...new Set([...csv(args, '--capabilities'), ...csv(args, '--capability')])]; }
function labels(args: string[]): Record<string, string> | undefined {
  const values = csv(args, '--labels');
  if (values.length === 0) return undefined;
  const output: Record<string, string> = {};
  for (const item of values) { const [key, value, ...rest] = item.split('='); if (!key || !value || rest.length > 0) throw new Error(`--labels entries must use key=value: ${item}`); output[key] = value; }
  return output;
}
function agentScopes(args: string[], forWrite = false): AgentRegistryScope[] {
  const scope = arg(args, '--scope', 'repository'); const registryRepo = arg(args, '--registry-repo');
  if (!['repository', 'global', 'both'].includes(scope)) throw new Error('--scope must be repository, global, or both');
  if (forWrite && scope === 'both') throw new Error('agent write commands require --scope repository or global');
  if ((scope === 'global' || scope === 'both') && !registryRepo) throw new Error('--registry-repo is required for global agent scope');
  const output: AgentRegistryScope[] = [];
  if (scope === 'repository' || scope === 'both') output.push(repositoryAgentScope());
  if (scope === 'global' || scope === 'both') output.push({ kind: 'global', repository: registryRepo });
  return output;
}
function availability(args: string[], defaultActive = false): AgentRegistration['availability'][] | undefined {
  const values = csv(args, '--availability');
  const selected = values.length > 0 ? values : defaultActive ? ['available', 'degraded'] : [];
  for (const value of selected) if (!['available', 'degraded', 'offline'].includes(value)) throw new Error(`Invalid availability: ${value}`);
  return selected.length > 0 ? selected as AgentRegistration['availability'][] : undefined;
}
function endpointKinds(args: string[]): AgentRegistration['endpoint']['kind'][] | undefined {
  const values = csv(args, '--endpoint-kinds');
  for (const value of values) if (!['adapter', 'command', 'http'].includes(value)) throw new Error(`Invalid endpoint kind: ${value}`);
  return values.length > 0 ? values as AgentRegistration['endpoint']['kind'][] : undefined;
}
function numericArg(args: string[], name: string): number | undefined {
  const value = arg(args, name);
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number`);
  return parsed;
}
function minScores(args: string[]): Record<string, number> | undefined {
  const output: Record<string, number> = {};
  for (const item of csv(args, '--min-scores')) {
    const [capability, raw, ...rest] = item.split('=');
    const score = Number(raw);
    if (!capability || rest.length > 0 || !Number.isFinite(score) || score < 0 || score > 100) throw new Error(`--min-scores entries must use capability=0..100: ${item}`);
    output[capability] = score;
  }
  const minimum = numericArg(args, '--min-score');
  if (minimum !== undefined) {
    if (minimum < 0 || minimum > 100) throw new Error('--min-score must be between 0 and 100');
    const capabilities = capabilityArgs(args);
    if (capabilities.length === 0) throw new Error('--min-score requires --capability or --capabilities');
    for (const capability of capabilities) output[capability] = minimum;
  }
  return Object.keys(output).length > 0 ? output : undefined;
}
async function agentStore(args: string[]): Promise<DurableStore> {
  if (arg(args, '--repo')) return githubRegistryStore(args);
  const file = arg(args, '--file'); if (!file) throw new Error('agent commands require --repo or explicit --file demo mode');
  return (await localStore(file)).store;
}
function registration(args: string[]): AgentRegistration {
  const name = arg(args, '--name'); const responsibility = arg(args, '--responsibility'); const role = arg(args, '--role'); const endpointTarget = arg(args, '--endpoint');
  if (!name || !responsibility || !role || !endpointTarget) throw new Error('--name, --responsibility, --role, and --endpoint are required');
  const endpointKind = arg(args, '--endpoint-kind', 'adapter'); if (!['adapter', 'command', 'http'].includes(endpointKind)) throw new Error('--endpoint-kind must be adapter, command, or http');
  const selectedAvailability = availability(args)?.[0] ?? 'available'; const now = new Date().toISOString();
  return { id: arg(args, '--agent-id', randomUUID()), name, responsibility, role, capabilities: capabilityArgs(args), boundaries: arg(args, '--boundaries').split('|').map(value => value.trim()).filter(Boolean), endpoint: { kind: endpointKind as AgentRegistration['endpoint']['kind'], target: endpointTarget, authEnv: arg(args, '--auth-env') || undefined }, runtime: { adapter: arg(args, '--runtime', arg(args, '--adapter', 'shell')), provider: arg(args, '--provider') || undefined, model: arg(args, '--model') || undefined }, availability: selectedAvailability, routing: { labels: labels(args), trustDomains: csv(args, '--trust-domains'), regions: csv(args, '--regions') }, evidence: { evaluations: [], outcomes: { succeeded: 0, failed: 0, timedOut: 0 }, lastObservedAt: null }, registeredAt: now, updatedAt: now };
}
function discoveryQuery(args: string[]): Parameters<typeof discoverAgents>[1] {
  const staleAfterDays = numericArg(args, '--stale-after-days');
  if (staleAfterDays !== undefined && staleAfterDays <= 0) throw new Error('--stale-after-days must be greater than 0');
  return { capabilities: capabilityArgs(args), runtime: arg(args, '--runtime') || undefined, endpointKinds: endpointKinds(args), availability: availability(args, true), labels: labels(args), trustDomains: csv(args, '--trust-domains'), regions: csv(args, '--regions'), requiredBoundaries: arg(args, '--required-boundaries').split('|').map(value => value.trim()).filter(Boolean), trustDomain: arg(args, '--trust-domain') || undefined, taskKind: arg(args, '--task-kind') || undefined, minScores: minScores(args), staleAfterMs: staleAfterDays === undefined ? undefined : staleAfterDays * 24 * 60 * 60 * 1000, explore: args.includes('--explore') };
}
function findAgent(agents: AgentRegistration[], args: string[]): AgentRegistration {
  const positional = args[0] && !args[0].startsWith('-') ? args[0] : '';
  const id = arg(args, '--agent-id'); const name = arg(args, '--name'); const selector = id || name || positional;
  if (!selector) throw new Error('agent command requires <agent>, --agent-id, or --name');
  const matches = agents.filter(agent => id ? agent.id === id : name ? agent.name === name : agent.id === positional || agent.name === positional);
  if (matches.length === 0) throw new Error(`Agent ${selector} not found`);
  if (matches.length > 1) throw new Error(`Agent ${selector} is ambiguous; use --agent-id`);
  return matches[0];
}
function evaluation(args: string[], agent: AgentRegistration): AgentRegistration['evidence']['evaluations'][number] {
  const suite = arg(args, '--suite'); const capabilities = capabilityArgs(args); const outcome = arg(args, '--outcome');
  if (!suite || capabilities.length === 0) throw new Error('agent eval requires --suite and --capability/--capabilities');
  if (!['success', 'failure', 'timeout'].includes(outcome)) throw new Error('agent eval --outcome must be success, failure, or timeout');
  const observedAt = arg(args, '--observed-at', new Date().toISOString());
  if (!Number.isFinite(Date.parse(observedAt))) throw new Error('--observed-at must be an ISO-compatible timestamp');
  const latencyMs = numericArg(args, '--latency-ms'); const cost = numericArg(args, '--cost');
  if (latencyMs !== undefined && latencyMs < 0) throw new Error('--latency-ms must be non-negative');
  if (cost !== undefined && cost < 0) throw new Error('--cost must be non-negative');
  return {
    source: 'suite', suite, taskId: arg(args, '--task-id', `eval:${suite}`), executionId: arg(args, '--execution-id', randomUUID()), attempt: 1,
    taskKind: arg(args, '--task-kind', suite), capabilities, outcome: outcome as 'success' | 'failure' | 'timeout', observedAt,
    version: arg(args, '--version', agent.runtime.model ?? agent.runtime.adapter), summary: arg(args, '--summary') || undefined, latencyMs, cost
  };
}
async function runAgentCommand(action: string, args: string[]): Promise<void> {
  if (!['register', 'list', 'show', 'discover', 'eval', 'scores'].includes(action)) throw new Error(usage);
  const writable = action === 'register' || action === 'eval';
  const store = await agentStore(args); const scopes = agentScopes(args, writable);
  if (action === 'register') { const agent = registration(args); await store.saveAgent(agent, scopes[0]); console.log(`Registered ${agent.id}`); return; }
  const agents = await store.listAgents(scopes);
  if (action === 'list') { console.log(JSON.stringify(agents, null, 2)); return; }
  if (action === 'show') { console.log(JSON.stringify(findAgent(agents, args), null, 2)); return; }
  if (action === 'eval') {
    const agent = findAgent(agents, args); const observation = evaluation(args, agent);
    const existing = agent.evidence.evaluations.find(item => item.executionId === observation.executionId);
    if (existing) { console.log(JSON.stringify({ agentId: agent.id, observation: existing, scores: scoreAgentCapabilities(agent) }, null, 2)); return; }
    agent.evidence.evaluations.push(observation); agent.evidence.lastObservedAt = observation.observedAt; agent.updatedAt = observation.observedAt;
    await store.saveAgent(agent, scopes[0]); console.log(JSON.stringify({ agentId: agent.id, observation, scores: scoreAgentCapabilities(agent) }, null, 2)); return;
  }
  if (action === 'scores') {
    const selected = arg(args, '--agent-id') || arg(args, '--name') || (args[0] && !args[0].startsWith('-')) ? [findAgent(agents, args)] : agents;
    const staleAfterDays = numericArg(args, '--stale-after-days');
    if (staleAfterDays !== undefined && staleAfterDays <= 0) throw new Error('--stale-after-days must be greater than 0');
    const staleAfterMs = staleAfterDays === undefined ? undefined : staleAfterDays * 24 * 60 * 60 * 1000;
    console.log(JSON.stringify(selected.map(agent => ({ agentId: agent.id, name: agent.name, scores: scoreAgentCapabilities(agent, { staleAfterMs }) })), null, 2)); return;
  }
  console.log(JSON.stringify(discoverAgents(agents, discoveryQuery(args)), null, 2));
}
async function storeFor(args: string[]): Promise<{ store: DurableStore; job: Job; localFile: string | null }> { const repo = arg(args, '--repo'); const pr = arg(args, '--pr'); if (repo && pr) { const store = await githubStore(args); const jobId = arg(args, '--id'); if (!jobId) throw new Error('--id is required for GitHub-backed operation'); return { store, job: await store.load(jobId), localFile: null }; } const file = arg(args, '--file'); if (!file) throw new Error('Local mode is demo/test only; pass --file explicitly'); const loaded = await localStore(file); return { store: loaded.store, job: loaded.job, localFile: file }; }
async function saveLocal(file: string | null, job: Job): Promise<void> { if (file) await writeFile(file, JSON.stringify(job, null, 2)); }
export function eventBus(args: string[]): EventBus | undefined { if (arg(args, '--events') !== 'nats') return undefined; return new NatsEventBus(arg(args, '--nats-url', 'nats://127.0.0.1:4222'), arg(args, '--subject-prefix', 'agents-relay.events.job')); }
async function publishWake(bus: EventBus | undefined, job: Job, taskId: string, message: string): Promise<void> { if (!bus) return; try { await bus.publish(eventFor(job.id, taskId, null, 'job.wake', 'queued', message, 'orchestrator')); } catch (error) { process.stderr.write(`warning: event wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`); } }
function continuation(args: string[]): Job['continuation'] { const kind = arg(args, '--continue-kind'); const target = arg(args, '--continue-target'); return kind && target ? { kind: kind as NonNullable<Job['continuation']>['kind'], target, input: arg(args, '--continue-input') || undefined } : null; }

export async function ensureManagedGitHubJob(
  client: GitHubClient,
  repositoryName: string,
  trustedAuthors: ReadonlySet<string>,
  options: { id: string; title?: string; continuation?: Job['continuation']; prNumber?: number; head?: string; base?: string; body?: string }
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
    job = { id: options.id, title: options.title || pr.title || 'Agents Relay job', description: pr.body || undefined, prNumber: pr.number, repository: repositoryName, state: 'OPEN', continuation: options.continuation ?? null, createdAt: now, updatedAt: now, tasks: [] };
  }
  if (!job.description && pr.body) job.description = pr.body;
  if (!job.title && pr.title) job.title = pr.title;
  await store.saveJob(job);
  return { job: await store.load(options.id), pr };
}

async function runJobCommand(action: string, args: string[]): Promise<void> {
  if (!['create', 'adopt', 'repair'].includes(action)) throw new Error(usage);
  const repo = repository(args);
  const id = arg(args, '--id');
  if (!id) throw new Error('--id is required for managed GitHub jobs');
  const client = new GhApiClient();
  const login = await client.currentLogin();
  const trustedAuthors = new Set([login, ...arg(args, '--trusted-authors').split(',').map(value => value.trim()).filter(Boolean)]);
  const prValue = arg(args, '--pr');
  const prNumber = prValue ? Number(prValue) : undefined;
  if (prValue && (!Number.isInteger(prNumber) || (prNumber ?? 0) <= 0)) throw new Error('--pr must be a positive integer');
  if ((action === 'adopt' || action === 'repair') && !prNumber) throw new Error(`job ${action} requires --pr`);
  const result = await ensureManagedGitHubJob(client, repo, trustedAuthors, {
    id,
    title: arg(args, '--title') || undefined,
    continuation: continuation(args),
    prNumber,
    head: arg(args, '--head') || undefined,
    base: arg(args, '--base', 'main'),
    body: arg(args, '--body') || undefined
  });
  console.log(JSON.stringify({ repository: repo, pr: result.pr.number, job: result.job.id, state: result.job.state }, null, 2));
}

export function runtime(store: DurableStore, args: string[], bus: EventBus | undefined): Reconciler { const emit = (event: ReturnType<typeof eventFor>): void => { process.stderr.write(`${JSON.stringify(event)}\n`); }; return new Reconciler(store, { owner: arg(args, '--owner', `cli-${process.pid}`), maxConcurrent: Number(arg(args, '--concurrency', '4')), leaseMs: Number(arg(args, '--lease-ms', '300000')), adapters: [new ShellAdapter(), new CodexAdapter(arg(args, '--codex', 'codex')), new ChatGptAdapter({ endpoint: arg(args, '--macbridge-url') || undefined, tokenFile: arg(args, '--macbridge-token-file') || undefined })], continuations: [new CodexThreadContinuation(arg(args, '--codex', 'codex')), new CommandContinuation(), new WebhookContinuation()], eventBus: bus, emit }); }
export interface Service { store: DurableStore; job: Job; reconciler: Reconciler; dashboardServer: Server; watchdogCleared: boolean; stop(): Promise<void>; }
export async function createService(args: string[]): Promise<Service> {
  const loaded = await storeFor(args); const upstream = eventBus(args); const bus = upstream ? new ServiceEventBus(upstream) : undefined; const reconciler = runtime(loaded.store, args, bus);
  const requestedUsageDays = Number(arg(args, '--usage-window-days', '1'));
  const usageWindowDays = Number.isInteger(requestedUsageDays) && requestedUsageDays > 0 ? requestedUsageDays : 1;
  const usageRegistry = codexAndZaiUsageRegistry(undefined, usageWindowDays);
  const repo = arg(args, '--repo');
  let overviewProvider: (() => Promise<Awaited<ReturnType<typeof listManagedGitHubJobs>>>) | undefined;
  if (repo) {
    const overviewClient = new GhApiClient(); const login = await overviewClient.currentLogin();
    const trusted = new Set([login, ...arg(args, '--trusted-authors').split(',').map(value => value.trim()).filter(Boolean)]);
    overviewProvider = () => listManagedGitHubJobs(overviewClient, repo, trusted);
  }
  const dashboardServer = serveDashboard(loaded.store, Number(arg(args, '--port', String(SERVICE_DEFAULTS.port))), bus, Number(arg(args, '--refresh-ms', String(SERVICE_DEFAULTS.dashboardRefreshMs))), loaded.job.id, usageRegistry, overviewProvider);
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
  if (command === 'job') { const [action, ...jobArgs] = args; await runJobCommand(action ?? '', jobArgs); return; }
  if (command === 'agent') { const [action, ...agentArgs] = args; await runAgentCommand(action ?? '', agentArgs); return; }
  if (command === 'agent-register') { await runAgentCommand('register', args); return; }
  if (command === 'agent-discover') { await runAgentCommand('discover', args); return; }
  if (command === 'init') { const now = new Date().toISOString(); const job: Job = { id: arg(args, '--id', randomUUID()), title: arg(args, '--title', 'Agents Relay job'), prNumber: Number(arg(args, '--pr', '0')), repository: arg(args, '--repo'), state: 'OPEN', continuation: continuation(args), createdAt: now, updatedAt: now, tasks: [] }; let store: DurableStore; let file: string | null = null; if (arg(args, '--repo') && arg(args, '--pr')) store = await githubStore(args); else { file = arg(args, '--file'); if (!file) throw new Error('init requires --repo/--pr or explicit --file demo mode'); store = new InMemoryStore(job); } await store.saveJob(job); await saveLocal(file, job); console.log(`Initialized ${job.id}`); return; }
  const loaded = await storeFor(args); const { store, job, localFile } = loaded; const bus = eventBus(args);
  if (command === 'record') {
    const now = new Date().toISOString(); const id = arg(args, '--task-id', randomUUID()); const summary = arg(args, '--summary');
    if (!summary) throw new Error('record requires --summary');
    const commit = arg(args, '--commit');
    const task: Task = { jobId: job.id, id, projectName: arg(args, '--project') || undefined, agentName: arg(args, '--agent', 'orchestrator'), parentTaskId: arg(args, '--parent') || null, dependencies: arg(args, '--deps').split(',').filter(Boolean), capabilities: [], adapter: 'orchestrator', input: arg(args, '--input', summary), continuation: null, continuationDeliveredAt: null, state: 'SUCCEEDED', attempt: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: commit || null, threadId: null, result: { summary, data: commit ? { commit } : undefined }, error: null, timeoutMs: 0, createdAt: now, updatedAt: now };
    await store.appendTask(task); job.tasks.push(task); await saveLocal(localFile, job); console.log(`Recorded ${id}`); return;
  }
  if (command === 'submit') {
    const now = new Date().toISOString();
    const selectedAgentId = arg(args, '--agent-id') || undefined;
    const selectedAgent = selectedAgentId ? (await store.listAgents()).find(agent => agent.id === selectedAgentId) : undefined;
    if (selectedAgentId && !selectedAgent) throw new Error(`Registered agent ${selectedAgentId} not found`);
    const model = arg(args, '--model') || selectedAgent?.runtime.model || '';
    const routing = model ? {
      provider: arg(args, '--provider') || selectedAgent?.runtime.provider || 'openai',
      model,
      profile: arg(args, '--profile') || undefined,
      reasoning: arg(args, '--reasoning') || undefined,
      cwd: arg(args, '--cwd') || undefined,
      projectId: arg(args, '--chatgpt-project') || undefined,
      decidedBy: 'cli',
      decidedAt: now,
    } satisfies RoutingDecision : undefined;
    const inferredAdapter = selectedAgent
      ? selectedAgent.endpoint.kind === 'adapter' ? selectedAgent.endpoint.target : selectedAgent.endpoint.kind
      : arg(args, '--adapter', 'shell');
    const task: Task = {
      jobId: job.id,
      id: arg(args, '--task-id', randomUUID()),
      projectName: arg(args, '--project') || undefined,
      agentName: arg(args, '--agent') || selectedAgent?.name,
      agentId: selectedAgentId,
      agentRequirements: selectedAgent ? {
        requiredBoundaries: arg(args, '--required-boundaries').split('|').map(value => value.trim()).filter(Boolean),
        trustDomains: csv(args, '--trust-domains'),
        regions: csv(args, '--regions'),
      } : undefined,
      parentTaskId: arg(args, '--parent') || null,
      dependencies: arg(args, '--deps').split(',').filter(Boolean),
      capabilities: arg(args, '--capabilities').split(',').filter(Boolean),
      adapter: inferredAdapter as AdapterName,
      input: arg(args, '--input', 'true'),
      routing,
      continuation: continuation(args),
      continuationDeliveredAt: null,
      state: 'QUEUED',
      attempt: 0,
      maxAttempts: Number(arg(args, '--max-attempts', '3')),
      leaseOwner: null,
      leaseExpiresAt: null,
      executionId: null,
      threadId: null,
      result: null,
      error: null,
      timeoutMs: Number(arg(args, '--timeout', '300000')),
      createdAt: now,
      updatedAt: now,
    };
    await store.appendTask(task); job.tasks.push(task); await saveLocal(localFile, job);
    await publishWake(bus, job, task.id, `Task ${task.id} submitted`);
    console.log(`Submitted ${task.id}`); return;
  }
  if (command === 'status') { console.log(JSON.stringify(await store.load(job.id), null, 2)); return; }
  if (command === 'retry' || command === 'cancel') { const id = arg(args, '--task-id'); const task = job.tasks.find(item => item.id === id); if (!task) throw new Error(`Task ${id} not found`); task.state = command === 'retry' ? 'READY' : 'CANCELLED'; task.error = command === 'retry' ? null : 'Cancelled by user'; task.updatedAt = new Date().toISOString(); await store.saveTask(task); await saveLocal(localFile, job); await publishWake(bus, job, task.id, `${task.id} ${command} requested`); console.log(`${id}: ${task.state}`); return; }
  const reconciler = runtime(store, args, bus);
  if (command === 'reconcile') { await reconciler.reconcile(job.id); await reconciler.idle(); const finalState = await store.load(job.id); await saveLocal(localFile, finalState); console.log(JSON.stringify(finalState, null, 2)); return; }
  if (command === 'serve') { await startService(args); return; }
  throw new Error(usage);
}
if (isEntrypoint(import.meta.url)) main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
