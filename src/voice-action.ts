import { createHmac, timingSafeEqual } from 'node:crypto';
import { AdapterName, RoutingDecision, Task } from './types.js';
import { GitHubClient, GitHubStore } from './store.js';
import { ensureManagedGitHubJob } from './cli.js';

export type VoiceActionPayload =
  | {
      action: 'job.create';
      repository: string;
      head: string;
      base?: string;
      id: string;
      title: string;
      body?: string;
      priority?: 'P0' | 'P1' | 'P2' | 'P3';
    }
  | {
      action: 'task.create';
      repository: string;
      pr: number;
      jobId: string;
      taskId: string;
      input: string;
      adapter?: AdapterName;
      priority?: 'P0' | 'P1' | 'P2' | 'P3';
      parentTaskId?: string | null;
      capabilities?: string[];
      provider?: string;
      model?: string;
      profile?: string;
      reasoning?: string;
      timeoutMs?: number;
      maxAttempts?: number;
    };

export interface VoiceActionResponse {
  status: number;
  body: Record<string, unknown>;
}

function encoded(payload: VoiceActionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function signature(secret: string, expiresAt: number, payload: string): string {
  return createHmac('sha256', secret).update(`${expiresAt}.${payload}`).digest('base64url');
}

export function buildVoiceActionUrl(baseUrl: string, secret: string, payload: VoiceActionPayload, ttlSeconds = 300, now = Date.now()): string {
  const expiresAt = Math.floor(now / 1000) + Math.max(1, Math.min(900, Math.floor(ttlSeconds)));
  const packed = encoded(payload);
  const url = new URL('/voice/actions/v1/execute', baseUrl);
  url.searchParams.set('exp', String(expiresAt));
  url.searchParams.set('payload', packed);
  url.searchParams.set('sig', signature(secret, expiresAt, packed));
  return url.toString();
}

export function verifyVoiceActionUrl(url: URL, secret: string, allowedRepositories: ReadonlySet<string>, now = Date.now()): VoiceActionPayload {
  const expiresAt = Number(url.searchParams.get('exp'));
  const packed = url.searchParams.get('payload') ?? '';
  const supplied = url.searchParams.get('sig') ?? '';
  if (!Number.isInteger(expiresAt) || !packed || !supplied) throw new Error('Invalid signed action');
  const nowSeconds = Math.floor(now / 1000);
  if (expiresAt < nowSeconds || expiresAt > nowSeconds + 900) throw new Error('Expired signed action');
  const expected = signature(secret, expiresAt, packed);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) throw new Error('Invalid signed action');
  let payload: VoiceActionPayload;
  try {
    payload = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8')) as VoiceActionPayload;
  } catch {
    throw new Error('Invalid signed action payload');
  }
  if (!payload || (payload.action !== 'job.create' && payload.action !== 'task.create')) throw new Error('Unsupported signed action');
  if (!allowedRepositories.has(payload.repository)) throw new Error('Repository is not allowed');
  return payload;
}

export class VoiceActionGateway {
  private readonly requests = new Map<string, number[]>();

  constructor(
    private readonly client: GitHubClient,
    private readonly trustedAuthors: ReadonlySet<string>,
    private readonly secret: string,
    private readonly allowedRepositories: ReadonlySet<string>,
    private readonly maxRequestsPerMinute = 10,
  ) {}

  async execute(url: URL, clientId: string): Promise<VoiceActionResponse> {
    if (!this.accept(clientId)) return { status: 429, body: { ok: false, error: 'Rate limit exceeded' } };
    let payload: VoiceActionPayload;
    try {
      payload = verifyVoiceActionUrl(url, this.secret, this.allowedRepositories);
    } catch (error) {
      return { status: 401, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
    try {
      return payload.action === 'job.create' ? await this.createJob(payload) : await this.createTask(payload);
    } catch (error) {
      return { status: 400, body: { ok: false, error: error instanceof Error ? error.message : String(error) } };
    }
  }

  private accept(clientId: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (this.requests.get(clientId) ?? []).filter(timestamp => timestamp >= cutoff);
    if (recent.length >= this.maxRequestsPerMinute) {
      this.requests.set(clientId, recent);
      return false;
    }
    recent.push(now);
    this.requests.set(clientId, recent);
    return true;
  }

  private async createJob(payload: Extract<VoiceActionPayload, { action: 'job.create' }>): Promise<VoiceActionResponse> {
    if (!payload.id || !payload.head || !payload.title) throw new Error('job.create requires id, head, and title');
    const result = await ensureManagedGitHubJob(this.client, payload.repository, this.trustedAuthors, {
      id: payload.id,
      title: payload.title,
      body: payload.body,
      priority: payload.priority ?? 'P2',
      head: payload.head,
      base: payload.base ?? 'main',
    });
    return {
      status: 200,
      body: {
        ok: true,
        action: payload.action,
        repository: payload.repository,
        pr: result.pr.number,
        job_id: result.job.id,
        state: result.job.state,
        url: `https://github.com/${payload.repository}/pull/${result.pr.number}`,
      },
    };
  }

  private async createTask(payload: Extract<VoiceActionPayload, { action: 'task.create' }>): Promise<VoiceActionResponse> {
    if (!Number.isInteger(payload.pr) || payload.pr <= 0 || !payload.jobId || !payload.taskId || !payload.input) throw new Error('task.create requires pr, jobId, taskId, and input');
    const store = new GitHubStore(this.client, payload.repository, payload.pr, this.trustedAuthors);
    const job = await store.load(payload.jobId);
    const existing = job.tasks.find(task => task.id === payload.taskId);
    if (existing) {
      return { status: 200, body: { ok: true, action: payload.action, repository: payload.repository, pr: payload.pr, job_id: payload.jobId, task_id: existing.id, state: existing.state, idempotent: true } };
    }
    const adapter = payload.adapter ?? 'shell';
    if (adapter !== 'shell' && !payload.model) throw new Error('model-backed task.create requires model');
    const now = new Date().toISOString();
    const routing: RoutingDecision | undefined = payload.model ? {
      provider: payload.provider ?? 'openai',
      model: payload.model,
      profile: payload.profile,
      reasoning: payload.reasoning,
      decidedBy: 'voice-action-gateway',
      decidedAt: now,
    } : undefined;
    const task: Task = {
      jobId: job.id,
      id: payload.taskId,
      priority: payload.priority ?? job.priority ?? 'P2',
      parentTaskId: payload.parentTaskId ?? null,
      dependencies: [],
      capabilities: payload.capabilities ?? [],
      adapter,
      input: payload.input,
      routing,
      continuation: null,
      continuationDeliveredAt: null,
      state: 'QUEUED',
      attempt: 0,
      maxAttempts: payload.maxAttempts ?? 3,
      leaseOwner: null,
      leaseExpiresAt: null,
      executionId: null,
      threadId: null,
      result: null,
      error: null,
      timeoutMs: payload.timeoutMs ?? 300000,
      createdAt: now,
      updatedAt: now,
    };
    await store.appendTask(task);
    if (job.state === 'COMPLETED') {
      job.state = 'OPEN';
      job.updatedAt = now;
      await store.saveJob(job);
    }
    return { status: 200, body: { ok: true, action: payload.action, repository: payload.repository, pr: payload.pr, job_id: payload.jobId, task_id: payload.taskId, state: task.state, idempotent: false } };
  }
}
