import { createServer, Server } from 'node:http';
import { subscribeLocalCommits } from './local-commit-events.js';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DurableStore, GitHubRateLimitBucket, GitHubRateLimitSnapshot, ManagedJobOverview } from './store.js';
import { EventBus } from './events.js';
import { readUsageSnapshot, UsageSnapshotProvider } from './usage.js';
import { Job, JobLifecycleState, Task, TaskState } from './types.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { DeliveryDeduper, parseGitHubWebhook, verifyGitHubWebhook } from './github-webhook.js';
import { loadExecutionRouterRules, saveExecutionRouterRules } from './routing-policy.js';
import { summarizeRuntime } from './runtime-summary.js';
import { GitHubRuntimeRateUsage } from './github-runtime-usage.js';
import { eventsBusHistory } from './events-bus-runtime.js';
import type { DecisionAuditRecord } from './decision-audit.js';

const GITHUB_REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;
const SSE_HEARTBEAT_MS = 15000;
const WORKFLOW_DIR = fileURLToPath(new URL('../workflow/', import.meta.url));

export type DashboardWorkflowGraph = { id: string; name: string; path: string; source: string };

export async function dashboardWorkflowGraphs(): Promise<DashboardWorkflowGraph[]> {
  const names = (await readdir(WORKFLOW_DIR)).filter(name => name.endsWith('.mmd')).sort();
  return Promise.all(names.map(async name => ({
    id: name.replace(/\.mmd$/, ''),
    name: name.replace(/\.mmd$/, '').split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
    path: `workflow/${name}`,
    source: await readFile(join(WORKFLOW_DIR, name), 'utf8'),
  })));
}
type DashboardTarget = { repository?: string; prNumber?: number };
type DashboardActions = { control?: (body: Record<string, unknown>) => Promise<unknown>; start?: (jobId: string) => Promise<Job>; reconcile?: (jobId: string) => Promise<Job>; cancel?: (jobId: string) => Promise<Job>; jobSetState?: (jobId: string, state: JobLifecycleState, target?: DashboardTarget) => Promise<Job>; taskCreate?: (jobId: string, task: Task, idempotencyKey?: string) => Promise<Job>; taskUpdate?: (jobId: string, taskId: string, task: Task, expectedUpdatedAt: string) => Promise<Job>; taskStart?: (jobId: string, taskId: string) => Promise<Job>; taskRetry?: (jobId: string, taskId: string) => Promise<Job>; taskCancel?: (jobId: string, taskId: string) => Promise<Job>; taskComplete?: (jobId: string, taskId: string, summary: string) => Promise<Job>; taskSetState?: (jobId: string, taskId: string, state: TaskState, target?: DashboardTarget) => Promise<Job> };

type EffectiveGitHubUsage = Pick<GitHubRateLimitBucket, 'limit' | 'remaining' | 'reset'>;

function effectiveGitHubUsage(snapshot: GitHubRateLimitSnapshot | null, runtime: GitHubRuntimeRateUsage | null): EffectiveGitHubUsage | null {
  const candidates = [snapshot?.resources.core, snapshot?.resources.graphql, snapshot?.resources.search, runtime?.resources.core, runtime?.resources.graphql, runtime?.resources.search]
    .filter((candidate): candidate is GitHubRateLimitBucket | NonNullable<GitHubRuntimeRateUsage['resources']['core']> => candidate !== undefined && candidate !== null)
    .filter(candidate => Number.isFinite(candidate.limit) && Number(candidate.limit) > 0 && Number.isFinite(candidate.remaining) && Number.isFinite(candidate.reset));
  const lowest = candidates.reduce<typeof candidates[number] | null>((current, candidate) => !current || Number(candidate.remaining) / Number(candidate.limit) < Number(current.remaining) / Number(current.limit) ? candidate : current, null);
  return lowest ? { limit: Number(lowest.limit), remaining: Number(lowest.remaining), reset: Number(lowest.reset) } : null;
}

function isPositiveInteger(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
}

function isTaskId(candidate: string): boolean {
  return candidate.length > 0;
}

function isSafeRepositorySegment(segment: string): boolean {
  return segment !== '.' && segment !== '..';
}

export function githubPrUrl(repository: unknown, prNumber: unknown): string | null {
  if (typeof repository !== 'string' || !isPositiveInteger(prNumber)) return null;
  const match = GITHUB_REPOSITORY_PATTERN.exec(repository);
  if (!match) return null;
  const [, owner, repo] = match;
  if (!isSafeRepositorySegment(owner) || !isSafeRepositorySegment(repo)) return null;
  return `https://github.com/${owner}/${repo}/pull/${prNumber}`;
}


async function eventHistory(jobId: string, taskId: string | null, limit: number): Promise<import('./types.js').EventRecord[]> {
  try { return await eventsBusHistory(jobId, taskId, limit); } catch { return []; }
}

export { dashboardHtml, dashboardVersion } from './dashboard-html.js';
import { dashboardHtml, dashboardVersion } from './dashboard-html.js';

export function serveDashboard(
  store: DurableStore,
  port = 8787,
  bus?: EventBus,
  refreshMs = 300000,
  jobId?: string,
  usageRegistry?: UsageSnapshotProvider,
  overviewProvider?: (forceRefresh?: boolean, trigger?: string) => Promise<ManagedJobOverview[]>,
  webhook?: { secret: string; repositories: ReadonlySet<string>; pullRequest?: number; jobId?: string; wake: (event: import('./github-webhook.js').GitHubWebhookWake) => void | Promise<void> },
  statusProvider?: () => { limited: boolean; cooldownUntil: string | null; [key: string]: unknown },
  githubUsageProvider?: () => Promise<unknown>,
  exactJobProvider?: (jobId: string, target?: { repository?: string; prNumber?: number }) => Promise<Job | null>,
  actions?: DashboardActions,
  routerTestProvider?: (selection: { jobId: string; taskId: string }) => Promise<Record<string, unknown>>,
  decisionAuditProvider?: () => Promise<DecisionAuditRecord[]>,
): Server {
  const legacyActions = typeof exactJobProvider === 'object' && exactJobProvider !== null ? exactJobProvider as DashboardActions : undefined;
  const legacyExactJobProvider = !exactJobProvider && githubUsageProvider ? githubUsageProvider as unknown as ((jobId: string, target?: { repository?: string; prNumber?: number }) => Promise<Job | null>) : undefined;
  const resolvedExactJobProvider = typeof exactJobProvider === 'function' ? exactJobProvider : legacyExactJobProvider;
  const resolvedGithubUsageProvider = legacyExactJobProvider ? undefined : githubUsageProvider;
  const resolvedActions = actions ?? legacyActions;
  const webhookDeliveries = new DeliveryDeduper();
  const clients = new Set<import('node:http').ServerResponse>();
  const subscribedJobs = new Set<string>();

  let lastKnownJobs: Array<Job & { githubState?: string; runtimeStatus?: string; mergedAt?: string | null; closedAt?: string | null; draft?: boolean; publication?: import('./github-webhook.js').PackagePublication | null; publicationFailure?: import('./github-webhook.js').PackagePublishFailure | null }> | null = null;
  const discoveredJobs = async (forceRefresh = false) => {
    try {
      const jobs = overviewProvider
        ? (await overviewProvider(forceRefresh, forceRefresh ? 'dashboard.jobs-refresh' : 'internal.unknown')).map(item => ({ ...item.job, githubState: item.githubState, runtimeStatus: deriveJobRuntimeStatus(item.job, item.githubState), mergedAt: item.mergedAt, closedAt: item.closedAt, draft: item.draft, publication: item.publication, publicationFailure: item.publicationFailure }))
        : jobId ? [await store.load(jobId)] : [];
      lastKnownJobs = jobs;
      return jobs;
    } catch (error) {
      if (lastKnownJobs) return lastKnownJobs;
      if (jobId) {
        try {
          const job = await store.load(jobId);
          lastKnownJobs = [job];
          return lastKnownJobs;
        } catch { /* durable backend unavailable too */ }
      }
      throw error;
    }
  };

  const subscribeDiscovered = async (): Promise<void> => {
    if (!bus) return;
    const jobs = await discoveredJobs().catch(() => []);
    for (const job of jobs) {
      if (subscribedJobs.has(job.id)) continue;
      subscribedJobs.add(job.id);
      try {
        await bus.subscribe(job.id, async event => {
          const payload = JSON.stringify({ event });
          for (const client of clients) client.write(`event: relay\ndata: ${payload}\n\n`);
        });
      } catch {
        subscribedJobs.delete(job.id);
      }
    }
  };

  const unsubscribeLocalCommits = subscribeLocalCommits(durable => {
    const known = lastKnownJobs?.find(job => job.id === durable.id && job.repository === durable.repository && job.prNumber === durable.prNumber);
    const githubState = known?.githubState as 'OPEN' | 'CLOSED' | 'MERGED' | undefined;
    const current = { ...durable, githubState, runtimeStatus: deriveJobRuntimeStatus(durable, githubState) };
    if (lastKnownJobs && known) Object.assign(known, current);
    const payload = JSON.stringify({ job: current });
    for (const client of clients) client.write(`data: ${payload}\n\n`);
  });

  const snapshot = async (requestedJobId = jobId, forceRefresh = false, target?: { repository?: string; prNumber?: number }): Promise<{ id: string; json: string }> => {
    await subscribeDiscovered();
    if (overviewProvider) {
      if (forceRefresh && requestedJobId && resolvedExactJobProvider) {
        const exact = await resolvedExactJobProvider(requestedJobId, target);
        if (exact) return { id: exact.id, json: JSON.stringify(exact) };
      }
      const candidates = await discoveredJobs();
      const job = requestedJobId ? candidates.find(candidate => candidate.id === requestedJobId) : candidates[0];
      if (!job) throw new Error(`Managed job ${requestedJobId ?? ''} not found`);
      return { id: job.id, json: JSON.stringify(job) };
    }
    if (!jobId) throw new Error('Dashboard requires a durable job id');
    if (requestedJobId !== jobId) throw new Error(`Managed job ${requestedJobId ?? ''} not found`);
    return { id: jobId, json: JSON.stringify(await store.load(jobId)) };
  };

  const broadcastSnapshots = async (jobIds: readonly string[] = []): Promise<void> => {
    const snapshots = await Promise.all((jobIds.length > 0 ? jobIds : [undefined]).map(requestedJobId => snapshot(requestedJobId)));
    for (const value of snapshots) for (const client of clients) client.write(`data: ${value.json}\n\n`);
  };

  const usage = async (): Promise<string> => {
    if (!usageRegistry) throw new Error('Account usage telemetry is unavailable');
    const account = await readUsageSnapshot(usageRegistry);
    const githubStatus = statusProvider ? statusProvider() : { limited: false, cooldownUntil: null };
    let github: GitHubRateLimitSnapshot | null = null;
    if (resolvedGithubUsageProvider) { try { github = await resolvedGithubUsageProvider() as GitHubRateLimitSnapshot; } catch { /* quota telemetry is best-effort during GitHub degradation */ } }
    const runtime = (githubStatus.runtimeRateUsage ?? null) as GitHubRuntimeRateUsage | null;
    const githubEffective = effectiveGitHubUsage(github, runtime);
    return JSON.stringify({ ...account, githubEffective, githubStatus });
  };

  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml);
      return;
    }
    if (req.url === '/api/version') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ version: dashboardVersion }));
      return;
    }
    if (req.url === '/api/graphs') {
      try {
        const graphs = await dashboardWorkflowGraphs();
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(graphs));
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/webhooks/github' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const signature = typeof req.headers['x-hub-signature-256'] === 'string' ? req.headers['x-hub-signature-256'] : undefined;
      if (!webhook || !verifyGitHubWebhook(webhook.secret, body, signature)) { res.writeHead(401); res.end('Invalid signature'); return; }
      const event = parseGitHubWebhook(req.headers, body);
      if (!event) { res.writeHead(202); res.end('Ignored'); return; }
      if (!event.repository || !webhook.repositories.has(event.repository) || (webhook.jobId !== undefined && event.jobId !== undefined && event.jobId !== null && event.jobId !== webhook.jobId) || (webhook.pullRequest !== undefined && event.pullRequest !== null && event.pullRequest !== webhook.pullRequest)) { res.writeHead(202); res.end('Ignored'); return; }
      if (!webhookDeliveries.accept(event.deliveryId)) { res.writeHead(202); res.end('Duplicate'); return; }
      res.writeHead(202); res.end('Accepted');
      queueMicrotask(() => {
        void Promise.resolve(webhook.wake(event))
          .catch(error => process.stderr.write(`warning: webhook wake unavailable: ${error instanceof Error ? error.message : String(error)}\n`));
      });
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/jobs') {
      try {
        await subscribeDiscovered();
        const forceRefresh = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('refresh') === '1';
        const jobs = await discoveredJobs(forceRefresh);
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(jobs));
      } catch (error) {
        if (!res.headersSent) res.writeHead(502);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/control') {
      if (req.method !== 'POST' || !resolvedActions?.control) { res.writeHead(404); res.end('Control API unavailable'); return; }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const result = await resolvedActions.control(body);
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) res.writeHead(409);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/job-action') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const action = url.searchParams.get('action') ?? '';
      const handler = action === 'start' ? resolvedActions?.start : action === 'reconcile' ? resolvedActions?.reconcile : action === 'cancel' ? resolvedActions?.cancel : undefined;
      if (req.method !== 'POST' || !/^[A-Za-z0-9_.-]+$/.test(requestedJobId) || !handler) { res.writeHead(404); res.end('Job action unavailable'); return; }
      try {
        const result = await handler(requestedJobId);
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) res.writeHead(409);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/task-command') {
      if (req.method !== 'POST') { res.writeHead(404); res.end('Task command unavailable'); return; }
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { jobId?: string; taskId?: string; action?: string; summary?: string; task?: Task; expectedUpdatedAt?: string; idempotencyKey?: string };
        const requestedJobId = typeof body.jobId === 'string' ? body.jobId : '';
        const requestedTaskId = typeof body.taskId === 'string' ? body.taskId : '';
        if (!/^[A-Za-z0-9_.-]+$/.test(requestedJobId)) throw new Error('Invalid job id');
        let result: Job;
        if (body.action === 'create' && body.task && resolvedActions?.taskCreate) result = await resolvedActions.taskCreate(requestedJobId, body.task, body.idempotencyKey);
        else if (body.action === 'update' && isTaskId(requestedTaskId) && body.task && body.expectedUpdatedAt && resolvedActions?.taskUpdate) result = await resolvedActions.taskUpdate(requestedJobId, requestedTaskId, body.task, body.expectedUpdatedAt);
        else if (body.action === 'start' && isTaskId(requestedTaskId) && resolvedActions?.taskStart) result = await resolvedActions.taskStart(requestedJobId, requestedTaskId);
        else if (body.action === 'retry' && isTaskId(requestedTaskId) && resolvedActions?.taskRetry) result = await resolvedActions.taskRetry(requestedJobId, requestedTaskId);
        else if (body.action === 'cancel' && isTaskId(requestedTaskId) && resolvedActions?.taskCancel) result = await resolvedActions.taskCancel(requestedJobId, requestedTaskId);
        else if (body.action === 'complete' && isTaskId(requestedTaskId) && typeof body.summary === 'string' && body.summary.trim() && resolvedActions?.taskComplete) result = await resolvedActions.taskComplete(requestedJobId, requestedTaskId, body.summary);
        else throw new Error('Task command unavailable');
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) res.writeHead(409);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/task-action') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const requestedTaskId = url.searchParams.get('task') ?? '';
      const action = url.searchParams.get('action') ?? '';
      const handler = action === 'retry' ? resolvedActions?.taskRetry : action === 'cancel' ? resolvedActions?.taskCancel : undefined;
      if (req.method !== 'POST' || !/^[A-Za-z0-9_.-]+$/.test(requestedJobId) || !isTaskId(requestedTaskId) || !handler) { res.writeHead(404); res.end('Task action unavailable'); return; }
      try {
        const result = await handler(requestedJobId, requestedTaskId);
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) res.writeHead(409);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/job-state') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const requestedState = url.searchParams.get('state') ?? '';
      const repository = url.searchParams.get('repo') ?? undefined;
      const parsedPr = Number(url.searchParams.get('pr'));
      const prNumber = Number.isInteger(parsedPr) && parsedPr > 0 ? parsedPr : undefined;
      const validState = ['DRAFT','ACTIVE','COMPLETED','CANCELLED'].includes(requestedState);
      if (req.method !== 'POST' || !/^[A-Za-z0-9_.-]+$/.test(requestedJobId) || !validState || !resolvedActions?.jobSetState) { res.writeHead(404); res.end('Job state override unavailable'); return; }
      try {
        const result = await resolvedActions.jobSetState(requestedJobId, requestedState as JobLifecycleState, { repository, prNumber });
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) res.writeHead(409);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/task-state') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const requestedTaskId = url.searchParams.get('task') ?? '';
      const requestedState = url.searchParams.get('state') ?? '';
      const repository = url.searchParams.get('repo') ?? undefined;
      const parsedPr = Number(url.searchParams.get('pr'));
      const prNumber = Number.isInteger(parsedPr) && parsedPr > 0 ? parsedPr : undefined;
      const validState = ['DRAFT','QUEUED','RUNNING','BLOCKED','SUCCEEDED','FAILED','CANCELLED'].includes(requestedState);
      if (req.method !== 'POST' || !/^[A-Za-z0-9_.-]+$/.test(requestedJobId) || !isTaskId(requestedTaskId) || !validState || !resolvedActions?.taskSetState) { res.writeHead(404); res.end('Task state override unavailable'); return; }
      try {
        const result = await resolvedActions.taskSetState(requestedJobId, requestedTaskId, requestedState as TaskState, { repository, prNumber });
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(JSON.stringify(result));
      } catch (error) {
        if (!res.headersSent) res.writeHead(409);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/job') {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const requestedJobId = url.searchParams.get('id') ?? undefined;
        const repository = url.searchParams.get('repo') ?? undefined;
        const parsedPr = Number(url.searchParams.get('pr'));
        const prNumber = Number.isInteger(parsedPr) && parsedPr > 0 ? parsedPr : undefined;
        const body = (await snapshot(requestedJobId, true, { repository, prNumber })).json;
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(body);
      } catch (error) {
        if (!res.headersSent) res.writeHead(404);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/events') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('job') ?? '';
      const requestedTaskId = url.searchParams.get('task');
      const requestedLimit = Number(url.searchParams.get('limit') ?? '60');
      if (!/^[A-Za-z0-9_.-]+$/.test(requestedJobId)) { res.writeHead(400); res.end('Invalid job id'); return; }
      const events = await eventHistory(requestedJobId, requestedTaskId, Number.isFinite(requestedLimit) ? requestedLimit : 60);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    if (req.url === '/api/execution-router-rules') {
      if (req.method === 'GET') {
        try {
          const rules = await loadExecutionRouterRules();
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(rules));
        } catch (error) {
          res.writeHead(500);
          res.end(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      if (req.method === 'PUT') {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          size += buffer.length;
          if (size > 64 * 1024) { res.writeHead(413); res.end('Execution router rules exceed 64 KiB'); return; }
          chunks.push(buffer);
        }
        try {
          const rules = await saveExecutionRouterRules(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(rules));
        } catch (error) {
          res.writeHead(500);
          res.end(error instanceof Error ? error.message : String(error));
        }
        return;
      }
      res.writeHead(405, { allow: 'GET, PUT' });
      res.end('Method not allowed');
      return;
    }
    if (req.url === '/api/router-test') {
      if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }); res.end('Method not allowed'); return; }
      if (!routerTestProvider) { res.writeHead(503); res.end('Router test unavailable'); return; }
      try {
        let body = '';
        for await (const chunk of req) body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        const parsed = JSON.parse(body || '{}') as { jobId?: string; taskId?: string };
        if (!parsed.jobId || !parsed.taskId) { res.writeHead(400); res.end('Select a Job and Task first'); return; }
        const result = await routerTestProvider({ jobId: parsed.jobId, taskId: parsed.taskId });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/api/decision-audit') {
      if (req.method !== 'GET') { res.writeHead(405, { allow: 'GET' }); res.end('Method not allowed'); return; }
      if (!decisionAuditProvider) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('[]'); return; }
      try {
        const records = await decisionAuditProvider();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(records.slice(-30).reverse()));
      } catch (error) {
        res.writeHead(500);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/api/runtime-summary') {
      try {
        const jobs = await discoveredJobs();
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(summarizeRuntime(jobs)));
      } catch (error) {
        res.writeHead(502);
        res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/api/status') {
      const status = statusProvider ? statusProvider() : { limited: false, cooldownUntil: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(status));
      return;
    }
    if (req.url === '/api/usage') {
      try {
        const body = await usage();
        if (!res.headersSent) res.writeHead(200, { 'content-type': 'application/json' });
        if (!res.writableEnded) res.end(body);
      } catch (error) {
        if (!res.headersSent) res.writeHead(503);
        if (!res.writableEnded) res.end(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    if (req.url === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      clients.add(res);
      res.flushHeaders();
      res.write(': connected\n\n');
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const heartbeat = setInterval(() => {
    if (clients.size === 0) return;
    for (const client of clients) client.write(': heartbeat\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => { unsubscribeLocalCommits(); clearInterval(heartbeat); clients.clear(); });
  server.listen(port, '127.0.0.1');
  return server;
}
