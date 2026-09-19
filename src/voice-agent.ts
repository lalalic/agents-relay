import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

export type VoiceAgentRequestState = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type VoiceAgentAuthMode = 'token' | 'none';

export interface VoiceAgentWorkerRequest {
  request: string;
  project?: string;
  workspaceRoot?: string;
  conversationId?: string;
}

export interface VoiceAgentWorkerResult {
  summary: string;
  conversationId?: string;
}

export interface VoiceAgentWorker {
  run(input: VoiceAgentWorkerRequest): Promise<VoiceAgentWorkerResult>;
}

export interface VoiceAgentSessionClaims {
  exp: number;
  projects: string[];
}

export interface VoiceAgentResponse {
  status: number;
  body: Record<string, unknown>;
}

interface SessionState {
  id: string;
  conversationId?: string;
  tail: Promise<void>;
}

interface RequestState {
  id: string;
  sessionId: string;
  state: VoiceAgentRequestState;
  project?: string;
  summary?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

function sign(secret: string, encodedClaims: string): string {
  return createHmac('sha256', secret).update(encodedClaims).digest('base64url');
}

export function createVoiceAgentToken(secret: string, projects: readonly string[], ttlSeconds = 7200, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + Math.max(60, Math.min(8 * 60 * 60, Math.floor(ttlSeconds)));
  const claims = Buffer.from(JSON.stringify({ exp, projects: [...new Set(projects)] }), 'utf8').toString('base64url');
  return `${claims}.${sign(secret, claims)}`;
}

export function verifyVoiceAgentToken(token: string, secret: string, project: string | undefined, now = Date.now()): VoiceAgentSessionClaims {
  const [encodedClaims, supplied] = token.split('.', 2);
  if (!encodedClaims || !supplied) throw new Error('Invalid voice agent token');
  const expected = sign(secret, encodedClaims);
  const expectedBuffer = Buffer.from(expected);
  const suppliedBuffer = Buffer.from(supplied);
  if (expectedBuffer.length !== suppliedBuffer.length || !timingSafeEqual(expectedBuffer, suppliedBuffer)) throw new Error('Invalid voice agent token');
  let claims: VoiceAgentSessionClaims;
  try {
    claims = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8')) as VoiceAgentSessionClaims;
  } catch {
    throw new Error('Invalid voice agent token');
  }
  if (!Number.isInteger(claims.exp) || !Array.isArray(claims.projects) || claims.exp < Math.floor(now / 1000)) throw new Error('Expired voice agent token');
  if (project && !claims.projects.includes(project)) throw new Error('Project is not allowed');
  return claims;
}

export function buildVoiceAgentUrl(baseUrl: string, secret: string, projects: readonly string[], ttlSeconds = 7200, now = Date.now()): string {
  const url = new URL('/voice/agent/v1/message', baseUrl);
  url.searchParams.set('token', createVoiceAgentToken(secret, projects, ttlSeconds, now));
  return url.toString();
}

function voiceAgentPrompt(input: VoiceAgentWorkerRequest): string {
  const projectLine = input.project ? `Project: ${input.project}\n` : '';
  const workspaceLine = input.workspaceRoot ? `Workspace root: ${input.workspaceRoot}\n` : '';
  return 'You are the server-side orchestrator for a Voice request. Carry the request to completion instead of only explaining what to do. ' +
    'Use the existing local tools, project instructions, skills, and Agents Relay CLI. For repository work, preserve the durable managed job/task workflow and follow the project AGENTS.md/bootstrap contracts. ' +
    'Do not invent a second control-plane API when existing CLI/tools already provide the operation.\n\n' +
    workspaceLine + projectLine + `Voice request:\n${input.request}`;
}

function codexSummary(output: string): { summary: string; conversationId?: string } {
  let conversationId: string | undefined;
  let summary = '';
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === 'thread.started' && typeof value.thread_id === 'string') conversationId = value.thread_id;
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') summary = item.text.trim();
      const payload = value.payload as Record<string, unknown> | undefined;
      if (value.type === 'event_msg' && payload?.type === 'task_complete' && typeof payload.last_agent_message === 'string') summary = payload.last_agent_message.trim();
    } catch { /* ignore non-JSON output */ }
  }
  return { summary: summary || 'Voice Agent request completed', conversationId };
}

export class CodexVoiceAgentWorker implements VoiceAgentWorker {
  constructor(private readonly command = 'codex') {}

  async run(input: VoiceAgentWorkerRequest): Promise<VoiceAgentWorkerResult> {
    if (!input.project || !input.workspaceRoot) throw new Error('Voice Agent worker requires project and workspace root');
    const cwd = resolve(input.workspaceRoot, input.project);
    const prompt = voiceAgentPrompt(input);
    const args = input.conversationId
      ? ['exec', 'resume', input.conversationId, prompt, '--json']
      : ['exec', '--json', '-C', cwd, '--', prompt];
    const output = await new Promise<string>((resolvePromise, reject) => {
      const child = spawn(this.command, args, { cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolvePromise(stdout) : reject(new Error((stderr || stdout || `Codex exited ${code}`).trim())));
    });
    const parsed = codexSummary(output);
    return { summary: parsed.summary, conversationId: parsed.conversationId ?? input.conversationId };
  }
}

export class MacBridgeVoiceAgentWorker implements VoiceAgentWorker {
  constructor(
    private readonly endpoint: string,
    private readonly tokenFile: string,
    private readonly thinkingEffort = 'high',
    private readonly maxRuntimeSeconds = 3600,
  ) {}

  async run(input: VoiceAgentWorkerRequest): Promise<VoiceAgentWorkerResult> {
    const token = (await readFile(this.tokenFile, 'utf8')).trim();
    if (!token) throw new Error(`MacBridge token file is empty: ${this.tokenFile}`);
    const base = this.endpoint.replace(/\/+$/, '');
    const url = new URL(base);
    url.pathname = '/experimental/chatgpt/conversation';
    url.search = '';
    url.hash = '';
    const prompt = voiceAgentPrompt(input);
    const body: Record<string, unknown> = {
      prompt,
      thinking_effort: this.thinkingEffort,
      max_runtime_seconds: this.maxRuntimeSeconds,
    };
    if (input.conversationId) body.conversation_id = input.conversationId;
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    let payload: Record<string, unknown>;
    try { payload = JSON.parse(text) as Record<string, unknown>; }
    catch { throw new Error(`MacBridge returned unreadable Voice Agent response (${response.status})`); }
    if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `MacBridge Voice Agent request failed (${response.status})`);
    if (payload.complete !== true) throw new Error('MacBridge Voice Agent conversation did not complete');
    return {
      summary: typeof payload.assistant_text === 'string' ? payload.assistant_text.trim() : 'Voice Agent request completed',
      conversationId: typeof payload.conversation_id === 'string' ? payload.conversation_id : input.conversationId,
    };
  }
}

export class VoiceAgentGateway {
  private readonly sessions = new Map<string, SessionState>();
  private readonly requests = new Map<string, RequestState>();
  private readonly rateLimits = new Map<string, number[]>();

  constructor(
    private readonly worker: VoiceAgentWorker,
    private readonly secret: string,
    private readonly workspaceRoot: string,
    private readonly allowedProjects: ReadonlySet<string>,
    private readonly authMode: VoiceAgentAuthMode = 'token',
    private readonly maxRequestsPerMinute = 20,
  ) {}

  submit(input: { token: string; request: string; project?: string; sessionId?: string; clientId: string }): VoiceAgentResponse {
    if (!this.accept(input.clientId)) return { status: 429, body: { ok: false, error: 'Rate limit exceeded' } };
    if (!input.request.trim()) return { status: 400, body: { ok: false, error: 'request is required' } };
    let claims: VoiceAgentSessionClaims | null = null;
    if (this.authMode === 'token') {
      try { claims = verifyVoiceAgentToken(input.token, this.secret, input.project); }
      catch (error) { return { status: 401, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }; }
    }
    const project = input.project ?? (claims?.projects.length === 1 ? claims.projects[0] : undefined);
    if (!project) return { status: 400, body: { ok: false, error: 'project is required' } };
    if (!this.allowedProjects.has(project) || (claims !== null && !claims.projects.includes(project))) return { status: 401, body: { ok: false, error: 'Project is not allowed' } };

    const sessionId = input.sessionId?.trim() || randomUUID();
    const session = this.sessions.get(sessionId) ?? { id: sessionId, tail: Promise.resolve() };
    this.sessions.set(sessionId, session);
    const requestId = randomUUID();
    const now = new Date().toISOString();
    const state: RequestState = { id: requestId, sessionId, state: 'QUEUED', project, createdAt: now, updatedAt: now };
    this.requests.set(requestId, state);

    session.tail = session.tail.then(async () => {
      state.state = 'RUNNING';
      state.updatedAt = new Date().toISOString();
      try {
        const result = await this.worker.run({
          request: input.request,
          project,
          workspaceRoot: this.workspaceRoot,
          conversationId: session.conversationId,
        });
        if (result.conversationId) session.conversationId = result.conversationId;
        state.state = 'SUCCEEDED';
        state.summary = result.summary;
      } catch (error) {
        state.state = 'FAILED';
        state.error = error instanceof Error ? error.message : String(error);
      }
      state.updatedAt = new Date().toISOString();
    });

    return {
      status: 202,
      body: {
        ok: true,
        accepted: true,
        session_id: sessionId,
        request_id: requestId,
        state: state.state,
      },
    };
  }

  status(token: string, requestId: string, project?: string): VoiceAgentResponse {
    let claims: VoiceAgentSessionClaims | null = null;
    if (this.authMode === 'token') {
      try { claims = verifyVoiceAgentToken(token, this.secret, project); }
      catch (error) { return { status: 401, body: { ok: false, error: error instanceof Error ? error.message : String(error) } }; }
    }
    const state = this.requests.get(requestId);
    if (!state) return { status: 404, body: { ok: false, error: 'Request not found' } };
    if (!state.project || !this.allowedProjects.has(state.project) || (claims !== null && !claims.projects.includes(state.project))) return { status: 401, body: { ok: false, error: 'Project is not allowed' } };
    return {
      status: 200,
      body: {
        ok: true,
        request_id: state.id,
        session_id: state.sessionId,
        state: state.state,
        project: state.project,
        summary: state.summary,
        error: state.error,
        created_at: state.createdAt,
        updated_at: state.updatedAt,
      },
    };
  }

  private accept(clientId: string): boolean {
    const now = Date.now();
    const cutoff = now - 60_000;
    const recent = (this.rateLimits.get(clientId) ?? []).filter(timestamp => timestamp >= cutoff);
    if (recent.length >= this.maxRequestsPerMinute) {
      this.rateLimits.set(clientId, recent);
      return false;
    }
    recent.push(now);
    this.rateLimits.set(clientId, recent);
    return true;
  }
}
