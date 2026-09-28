import { createServer, Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DurableStore, ManagedJobOverview } from './store.js';
import { EventBus } from './events.js';
import { readUsageSnapshot, UsageSnapshotProvider } from './usage.js';
import { Job, TaskState } from './types.js';
import { deriveJobRuntimeStatus } from './runtime-status.js';
import { DeliveryDeduper, parseGitHubWebhook, verifyGitHubWebhook } from './github-webhook.js';
import { loadModelRouterRules, loadWorkerRouterRules, saveModelRouterRules, saveWorkerRouterRules } from './routing-policy.js';
import { summarizeRuntime } from './runtime-summary.js';

const GITHUB_REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,36}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;
const SSE_HEARTBEAT_MS = 15000;
const EVENTS_HISTORY_FILE = process.env.EVENTS_BUS_DATA_DIR ? join(process.env.EVENTS_BUS_DATA_DIR, 'events.jsonl') : join(homedir(), 'Library', 'Application Support', 'EventsBus', 'events.jsonl');
type DashboardActions = { start?: (jobId: string) => Promise<Job>; reconcile?: (jobId: string) => Promise<Job>; cancel?: (jobId: string) => Promise<Job>; taskRetry?: (jobId: string, taskId: string) => Promise<Job>; taskCancel?: (jobId: string, taskId: string) => Promise<Job>; taskSetState?: (jobId: string, taskId: string, state: TaskState) => Promise<Job> };

function isPositiveInteger(candidate: unknown): candidate is number {
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0;
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
  const boundedLimit = Math.max(1, Math.min(60, limit));
  let content = '';
  try { content = await readFile(EVENTS_HISTORY_FILE, 'utf8'); } catch { return []; }
  const output: import('./types.js').EventRecord[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0 && output.length < boundedLimit; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const row = JSON.parse(line) as { event?: import('./types.js').EventRecord };
      const event = row.event;
      if (!event || event.job_id !== jobId || (taskId && event.task_id !== taskId)) continue;
      output.push(event);
    } catch { /* ignore malformed historical rows */ }
  }
  return output;
}

export { dashboardHtml } from './dashboard-html.js';
import { dashboardHtml } from './dashboard-html.js';

export function serveDashboard(
  store: DurableStore,
  port = 8787,
  bus?: EventBus,
  refreshMs = 300000,
  jobId?: string,
  usageRegistry?: UsageSnapshotProvider,
  overviewProvider?: (forceRefresh?: boolean, trigger?: string) => Promise<ManagedJobOverview[]>,
  webhook?: { secret: string; repositories: ReadonlySet<string>; pullRequest?: number; refresh?: (event: import('./github-webhook.js').GitHubWebhookWake) => Promise<readonly string[]>; wake: (event: import('./github-webhook.js').GitHubWebhookWake) => void | Promise<void> },
  statusProvider?: () => { limited: boolean; cooldownUntil: string | null; [key: string]: unknown },
  githubUsageProvider?: () => Promise<unknown>,
  exactJobProvider?: (jobId: string) => Promise<Job | null>,
  actions?: DashboardActions,
): Server {
  const legacyActions = typeof exactJobProvider === 'object' && exactJobProvider !== null ? exactJobProvider as DashboardActions : undefined;
  const legacyExactJobProvider = !exactJobProvider && githubUsageProvider ? githubUsageProvider as unknown as ((jobId: string) => Promise<Job | null>) : undefined;
  const resolvedExactJobProvider = typeof exactJobProvider === 'function' ? exactJobProvider : legacyExactJobProvider;
  const resolvedGithubUsageProvider = legacyExactJobProvider ? undefined : githubUsageProvider;
  const resolvedActions = actions ?? legacyActions;
  const webhookDeliveries = new DeliveryDeduper();
  const clients = new Set<import('node:http').ServerResponse>();
  const subscribedJobs = new Set<string>();

  let lastKnownJobs: Array<Job & { githubState?: string; runtimeStatus?: string; mergedAt?: string | null; closedAt?: string | null; draft?: boolean; publication?: import('./github-webhook.js').PackagePublication | null }> | null = null;
  const discoveredJobs = async (forceRefresh = false) => {
    try {
      const jobs = overviewProvider
        ? (await overviewProvider(forceRefresh, forceRefresh ? 'dashboard.jobs-refresh' : 'internal.unknown')).map(item => ({ ...item.job, githubState: item.githubState, runtimeStatus: deriveJobRuntimeStatus(item.job, item.githubState), mergedAt: item.mergedAt, closedAt: item.closedAt, draft: item.draft, publication: item.publication }))
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
          const current = (await discoveredJobs()).find(candidate => candidate.id === job.id) ?? job;
          const payload = JSON.stringify({ event, job: current });
          for (const client of clients) client.write(`event: relay\ndata: ${payload}\n\n`);
        });
      } catch {
        subscribedJobs.delete(job.id);
      }
    }
  };

  const snapshot = async (requestedJobId = jobId, forceRefresh = false): Promise<{ id: string; json: string }> => {
    await subscribeDiscovered();
    if (overviewProvider) {
      if (forceRefresh && requestedJobId && resolvedExactJobProvider) {
        const exact = await resolvedExactJobProvider(requestedJobId);
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
    let github: unknown = null;
    if (resolvedGithubUsageProvider) { try { github = await resolvedGithubUsageProvider(); } catch { /* quota telemetry is best-effort during GitHub degradation */ } }
    return JSON.stringify({ ...account, github, githubStatus });
  };

  const server = createServer(async (req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(dashboardHtml);
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
      if (!event.repository || !webhook.repositories.has(event.repository) || (webhook.pullRequest !== undefined && event.pullRequest !== null && event.pullRequest !== webhook.pullRequest)) { res.writeHead(202); res.end('Ignored'); return; }
      if (!webhookDeliveries.accept(event.deliveryId)) { res.writeHead(202); res.end('Duplicate'); return; }
      res.writeHead(202); res.end('Accepted');
      queueMicrotask(() => {
        const refreshDashboard = webhook.refresh
          ? webhook.refresh(event)
            .then(jobIds => broadcastSnapshots(jobIds))
            .catch(error => process.stderr.write(`warning: webhook dashboard snapshot unavailable: ${error instanceof Error ? error.message : String(error)}\n`))
          : Promise.resolve();
        void refreshDashboard
          .then(() => webhook.wake(event))
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
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/job-action') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const action = url.searchParams.get('action') ?? '';
      const handler = action === 'start' ? resolvedActions?.start : action === 'reconcile' ? resolvedActions?.reconcile : action === 'cancel' ? resolvedActions?.cancel : undefined;
      if (req.method !== 'POST' || !/^[A-Za-z0-9_-]+$/.test(requestedJobId) || !handler) { res.writeHead(404); res.end('Job action unavailable'); return; }
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
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/task-action') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const requestedTaskId = url.searchParams.get('task') ?? '';
      const action = url.searchParams.get('action') ?? '';
      const handler = action === 'retry' ? resolvedActions?.taskRetry : action === 'cancel' ? resolvedActions?.taskCancel : undefined;
      if (req.method !== 'POST' || !/^[A-Za-z0-9_-]+$/.test(requestedJobId) || !/^[A-Za-z0-9_-]+$/.test(requestedTaskId) || !handler) { res.writeHead(404); res.end('Task action unavailable'); return; }
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
    if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname === '/api/task-state') {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const requestedJobId = url.searchParams.get('id') ?? '';
      const requestedTaskId = url.searchParams.get('task') ?? '';
      const requestedState = url.searchParams.get('state') ?? '';
      const validState = ['DRAFT','QUEUED','RUNNING','BLOCKED','SUCCEEDED','FAILED','CANCELLED'].includes(requestedState);
      if (req.method !== 'POST' || !/^[A-Za-z0-9_-]+$/.test(requestedJobId) || !/^[A-Za-z0-9_-]+$/.test(requestedTaskId) || !validState || !resolvedActions?.taskSetState) { res.writeHead(404); res.end('Task state override unavailable'); return; }
      try {
        const result = await resolvedActions.taskSetState(requestedJobId, requestedTaskId, requestedState as TaskState);
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
        const requestedJobId = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('id') ?? undefined;
        const body = (await snapshot(requestedJobId, true)).json;
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
      if (!/^[A-Za-z0-9_-]+$/.test(requestedJobId)) { res.writeHead(400); res.end('Invalid job id'); return; }
      const events = await eventHistory(requestedJobId, requestedTaskId, Number.isFinite(requestedLimit) ? requestedLimit : 60);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(events));
      return;
    }

    if (req.url === '/api/model-router-rules') {
      if (req.method === 'GET') {
        try {
          const rules = await loadModelRouterRules();
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
          if (size > 64 * 1024) { res.writeHead(413); res.end('Model router rules exceed 64 KiB'); return; }
          chunks.push(buffer);
        }
        try {
          const rules = await saveModelRouterRules(Buffer.concat(chunks).toString('utf8'));
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
    if (req.url === '/api/worker-router-rules') {
      if (req.method === 'GET') {
        try {
          const rules = await loadWorkerRouterRules();
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
          if (size > 64 * 1024) { res.writeHead(413); res.end('Worker router rules exceed 64 KiB'); return; }
          chunks.push(buffer);
        }
        try {
          const rules = await saveWorkerRouterRules(Buffer.concat(chunks).toString('utf8'));
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

  const interval = setInterval(() => {
    if (clients.size === 0) return;
    void snapshot().then(value => {
      for (const client of clients) client.write(`data: ${value.json}\n\n`);
    }).catch(() => undefined);
  }, Math.max(10000, refreshMs));
  interval.unref();
  const heartbeat = setInterval(() => {
    if (clients.size === 0) return;
    for (const client of clients) client.write(': heartbeat\n\n');
  }, SSE_HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => { clearInterval(interval); clearInterval(heartbeat); clients.clear(); });
  server.listen(port, '127.0.0.1');
  return server;
}
