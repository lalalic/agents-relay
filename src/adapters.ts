import { spawn, ChildProcess } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Task, AdapterName, Result, RoutingDecision } from './types.js';

export type Execution = { id: string; promise: Promise<Result>; cancel: () => void; threadId?: string; onThreadStarted?: (threadId: string) => void };
export interface WorkerAdapter { readonly name: AdapterName; readonly id: string; readonly capabilities: readonly string[]; launch(task: Task, signal: AbortSignal): Execution; recover?(task: Task): Promise<Result | null>; deleteThread?(threadId: string, task?: Pick<Task, 'projectName' | 'routing'>): Promise<void>; }
function commandExecution(child: ChildProcess, output: () => string, signal: AbortSignal, id: string): Execution { const promise = new Promise<Result>((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve({ summary: output().trim() || 'Command completed' }) : reject(new Error(output().trim() || `Command exited ${code}`))); signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true }); }); return { id, promise, cancel: () => { child.kill('SIGTERM'); } }; }
export function buildCodexArgs(route: Pick<RoutingDecision, 'provider' | 'model'> & Partial<Pick<RoutingDecision, 'profile' | 'reasoning' | 'cwd'>>, input: string): readonly string[] {
  const args: string[] = ['exec', '--json'];
  if (route.profile) args.push('-p', route.profile);
  if (route.model) args.push('-m', route.model);
  if (route.provider) args.push('-c', `model_provider=${route.provider}`);
  if (route.reasoning) args.push('-c', `model_reasoning_effort=${route.reasoning}`);
  if (route.cwd) args.push('-C', route.cwd);
  args.push('--', input);
  return args;
}
function parseThreadStarted(line: string): string | undefined { try { const value = JSON.parse(line) as Record<string, unknown>; return value.type === 'thread.started' && typeof value.thread_id === 'string' ? value.thread_id : undefined; } catch { return undefined; } }
function parseCodexAssistantMessage(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const payload = value.payload as Record<string, unknown> | undefined;
    if (value.type === 'event_msg' && payload?.type === 'task_complete' && typeof payload.last_agent_message === 'string') return payload.last_agent_message.trim() || undefined;
    const item = value.item as Record<string, unknown> | undefined;
    if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return item.text.trim() || undefined;
  } catch { /* non-JSON diagnostic output is ignored on successful Codex runs */ }
  return undefined;
}
function appendTail(current: string, chunk: string, maxBytes = 16384): string {
  const combined = current + chunk;
  return Buffer.byteLength(combined) <= maxBytes ? combined : Buffer.from(combined).subarray(-maxBytes).toString('utf8');
}
export class ShellAdapter implements WorkerAdapter {
  readonly name = 'shell' as const; readonly id = 'shell'; readonly capabilities = ['shell', 'command'] as const;
  constructor(private readonly shell = false) {}
  launch(task: Task, signal: AbortSignal): Execution { const parts = task.input.split(' ').filter(Boolean); const child = this.shell ? spawn(task.input, { shell: true }) : spawn(parts[0] ?? 'true', parts.slice(1)); let output = ''; child.stdout?.on('data', (x: Buffer) => { output += x.toString(); }); child.stderr?.on('data', (x: Buffer) => { output += x.toString(); }); return commandExecution(child, () => output, signal, randomUUID()); }
}
export class CodexAdapter implements WorkerAdapter {
  readonly name = 'codex' as const; readonly id = 'codex'; readonly capabilities = ['model', 'codex'] as const;
  constructor(private readonly command = 'codex', private readonly sessionsRoot = join(homedir(), '.codex', 'sessions')) {}
  launch(task: Task, signal: AbortSignal): Execution {
    if (!task.routing) throw new Error(`Task ${task.id} requires routing metadata before Codex launch`);
    const route = task.routing;
    const args = buildCodexArgs(route, task.input);
    const child = spawn(this.command, args, { shell: false, cwd: route.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let finalAssistantMessage = '';
    let stderrTail = '';
    let bufferedThreadId: string | undefined;
    let execution: Execution;
    const consumeLine = (line: string): void => {
      const threadId = parseThreadStarted(line);
      if (threadId) {
        bufferedThreadId = threadId;
        if (execution) { execution.threadId = threadId; execution.onThreadStarted?.(threadId); }
      }
      const assistantMessage = parseCodexAssistantMessage(line);
      if (assistantMessage) finalAssistantMessage = assistantMessage;
    };
    child.stdout?.on('data', (x: Buffer) => {
      stdoutBuffer += x.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr?.on('data', (x: Buffer) => { stderrTail = appendTail(stderrTail, x.toString()); });
    const id = randomUUID();
    const promise = new Promise<Result>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        if (stdoutBuffer) consumeLine(stdoutBuffer);
        if (code === 0) resolve({ summary: finalAssistantMessage || 'Codex task completed' });
        else reject(new Error(stderrTail.trim() || `Codex exited ${code}`));
      });
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    execution = { id, promise, cancel: () => { child.kill('SIGTERM'); } };
    execution.threadId = bufferedThreadId;
    return execution;
  }
  async recover(task: Task): Promise<Result | null> {
    if (!task.threadId) return null;
    let entries: string[];
    try { entries = await readdir(this.sessionsRoot, { recursive: true, encoding: 'utf8' }); } catch { return null; }
    const filename = entries.find(entry => entry.endsWith(`${task.threadId}.jsonl`));
    if (!filename) return null;
    let lines: string[];
    try { lines = (await readFile(join(this.sessionsRoot, filename), 'utf8')).split(/\r?\n/); } catch { return null; }
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index]; if (!line) continue;
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        if (value.type !== 'event_msg') continue;
        const payload = value.payload as Record<string, unknown> | undefined;
        if (payload?.type !== 'task_complete') continue;
        const summary = typeof payload.last_agent_message === 'string' ? payload.last_agent_message.trim() : '';
        return { summary: summary || 'Codex task completed', data: { recoveredFromThread: task.threadId } };
      } catch { /* ignore malformed session rows */ }
    }
    return null;
  }
}


export type BrowserWorkerOperation = 'create' | 'resume' | 'continue' | 'status' | 'result' | 'delete';
export type BrowserWorkerRequest = {
  operation: BrowserWorkerOperation;
  thread_id: string | null;
  project: { name: string; id?: string };
  prompt?: string;
  thinking_level?: 'default' | 'low' | 'medium' | 'high';
  state: Record<string, unknown> | null;
};
export type BrowserWorkerResponse = {
  operation: BrowserWorkerOperation;
  status: string;
  thread_id?: string | null;
  result?: { message_id?: string; text?: string; verified?: boolean; observed_at?: string };
  error?: { code?: string; message?: string; retryable?: boolean } | null;
  state?: Record<string, unknown>;
};
export type AgentRun = { promise: Promise<string>; cancel: () => void };
export type ChatGptAgentRunner = (definition: string, request: BrowserWorkerRequest, route: RoutingDecision, signal: AbortSignal) => AgentRun;
export type ChatGptAdapterOptions = { agentPath?: string; harness?: string; agentRunner?: ChatGptAgentRunner };

export class LaunchFailure extends Error {}

type BrowserWorkerRuntime = { definition: string; root: string };
function browserWorkerCandidates(explicit?: string): string[] {
  const roots = (process.env.AGENTS_RELAY_SKILL_ROOTS ?? '').split(':').filter(Boolean);
  const packageSkills = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');
  return [explicit, ...roots, packageSkills, join(homedir(), '.codex', 'skills'), join(homedir(), '.agents', 'skills'), join(process.cwd(), 'skills')]
    .filter((value): value is string => Boolean(value))
    .map(value => value.endsWith('browser-worker.agent.md') ? value : join(value, 'chatgpt-browser-worker', 'agents', 'browser-worker.agent.md'));
}
async function loadBrowserWorkerRuntime(explicit?: string): Promise<BrowserWorkerRuntime> {
  for (const candidate of browserWorkerCandidates(explicit)) {
    try {
      await access(candidate);
      return { definition: await readFile(candidate, 'utf8'), root: dirname(dirname(candidate)) };
    } catch { /* try the next installed skill root */ }
  }
  throw new Error('chatgpt-browser-worker agent definition not found; set AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT');
}
function thinkingLevel(reasoning?: string): 'default' | 'low' | 'medium' | 'high' {
  if (reasoning === 'low' || reasoning === 'medium' || reasoning === 'high') return reasoning;
  if (reasoning === 'minimal') return 'low';
  return 'default';
}
function parseBrowserWorkerResponse(output: string): BrowserWorkerResponse {
  const text = output.trim().replace(/^```(?:json)?\s*|\s*```$/g, '').trim();
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('browser-worker returned non-JSON output'); }
  if (!value || typeof value !== 'object') throw new Error('browser-worker returned an invalid JSON response');
  const response = value as BrowserWorkerResponse;
  if (!response.operation || !response.status) throw new Error('browser-worker response omitted operation or status');
  return response;
}
function parseDriverJson(output: string): Record<string, unknown> {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
    } catch { /* browser-harness diagnostics may precede the final JSON observation */ }
  }
  throw new Error('browser-worker driver returned no JSON observation');
}
function directBrowserWorkerRunner(root: string): ChatGptAgentRunner {
  return (_definition, request, _route, signal): AgentRun => {
    const scripts = join(root, 'scripts');
    const project = request.project.name;
    const args = request.operation === 'create'
      ? [join(scripts, 'create_bh.py'), '--project', project, '--prompt', request.prompt ?? '', '--thinking-level', request.thinking_level ?? 'default']
      : [join(scripts, 'operate_bh.py'), request.operation, '--thread-id', request.thread_id ?? '', '--project', project,
          ...(request.operation === 'continue' ? ['--prompt', request.prompt ?? ''] : [])];
    const child = spawn('python3', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk.toString()); });
    const promise = new Promise<string>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) { reject(new Error(stderr.trim() || stdout.trim() || `browser-worker driver exited ${code}`)); return; }
        try {
          const observed = parseDriverJson(stdout);
          const threadId = typeof observed.thread_id === 'string' ? observed.thread_id : request.thread_id;
          const response: BrowserWorkerResponse = { operation: request.operation, status: 'running', thread_id: threadId ?? null };
          if (request.operation === 'create') response.status = 'running';
          else if (request.operation === 'continue') response.status = 'running';
          else if (request.operation === 'resume') response.status = typeof observed.status === 'string' ? observed.status : 'awaiting_result';
          else if (request.operation === 'status') response.status = typeof observed.status === 'string' ? observed.status : 'awaiting_result';
          else if (request.operation === 'result') {
            response.status = typeof observed.status === 'string' ? observed.status : 'completed';
            response.result = {
              message_id: typeof observed.message_id === 'string' ? observed.message_id : undefined,
              text: typeof observed.text === 'string' ? observed.text : undefined,
              verified: Boolean(observed.message_id && observed.text),
              observed_at: new Date().toISOString()
            };
          } else if (request.operation === 'delete') {
            const outcome = typeof observed.outcome === 'string' ? observed.outcome : '';
            response.status = outcome === 'deleted' || outcome === 'not_found' ? outcome : 'failed';
            if (response.status === 'failed') response.error = { code: 'cleanup_not_verified', message: 'browser-worker did not verify thread cleanup', retryable: true };
          }
          resolve(JSON.stringify(response));
        } catch (error) { reject(error); }
      });
      if (signal.aborted) child.kill('SIGTERM'); else signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    return { promise, cancel: () => { child.kill('SIGTERM'); } };
  };
}
function browserWorkerError(response: BrowserWorkerResponse): Error {
  const detail = response.error?.message || `browser-worker ${response.status}`;
  return new Error(response.error?.code ? `${response.error.code}: ${detail}` : detail);
}

export class ChatGptAdapter implements WorkerAdapter {
  readonly name = 'chatgpt' as const;
  readonly id = 'chatgpt/browser-worker';
  readonly capabilities = ['model', 'chatgpt', 'browser-harness'] as const;
  private readonly agentPath?: string;
  private readonly runner?: ChatGptAgentRunner;
  private readonly deleted = new Set<string>();
  private readonly routes = new Map<string, RoutingDecision>();
  constructor(options: ChatGptAdapterOptions = {}) { this.agentPath = options.agentPath ?? process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT; this.runner = options.agentRunner; }
  private async run(request: BrowserWorkerRequest, route: RoutingDecision, signal: AbortSignal): Promise<BrowserWorkerResponse> {
    const runtime = await loadBrowserWorkerRuntime(this.agentPath);
    if (signal.aborted) throw new Error('browser-worker execution aborted');
    const run = (this.runner ?? directBrowserWorkerRunner(runtime.root))(runtime.definition, request, route, signal);
    const output = await new Promise<string>((resolve, reject) => {
      const abort = (): void => { run.cancel(); reject(new Error('browser-worker execution aborted')); };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      run.promise.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => { signal.removeEventListener('abort', abort); reject(error); });
    });
    return parseBrowserWorkerResponse(output);
  }
  private project(task: Pick<Task, 'projectName' | 'routing'> | undefined, route: RoutingDecision): { name: string; id?: string } {
    return { name: task?.projectName ?? route.projectId ?? 'default', id: route.projectId };
  }
  private exposeThread(execution: Execution, expected: string | null, response: BrowserWorkerResponse): string {
    const threadId = typeof response.thread_id === 'string' && response.thread_id.trim() ? response.thread_id : undefined;
    if (!threadId) throw new Error('browser-worker response omitted thread_id');
    if (expected && threadId !== expected) throw new Error('browser-worker returned a different thread_id');
    execution.threadId = threadId;
    execution.onThreadStarted?.(threadId);
    return threadId;
  }
  private validateOperation(response: BrowserWorkerResponse, operation: BrowserWorkerOperation): void {
    if (response.operation !== operation) throw new Error(`browser-worker response operation mismatch: expected ${operation}, got ${response.operation}`);
    if (response.status === 'blocked' || response.status === 'failed') throw browserWorkerError(response);
  }
  async deleteThread(threadId: string, task?: Pick<Task, 'projectName' | 'routing'>): Promise<void> {
    if (this.deleted.has(threadId)) return;
    const route = task?.routing ?? this.routes.get(threadId);
    if (!route) throw new Error(`Task routing metadata is required to delete browser-worker thread ${threadId}`);
    const response = await this.run({ operation: 'delete', thread_id: threadId, project: this.project(task, route), state: null }, route, new AbortController().signal);
    if (response.operation !== 'delete') throw new Error(`browser-worker response operation mismatch: expected delete, got ${response.operation}`);
    if (response.thread_id && response.thread_id !== threadId) throw new Error('browser-worker returned a different thread_id');
    if (response.status !== 'deleted' && response.status !== 'not_found') throw browserWorkerError(response);
    this.deleted.add(threadId);
  }
  launch(task: Task, signal: AbortSignal): Execution {
    if (!task.routing) throw new Error(`Task ${task.id} requires routing metadata before ChatGPT launch`);
    const route = task.routing;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    const execution: Execution = { id: randomUUID(), promise: Promise.resolve({ summary: '' }), cancel: abort };
    const timeout = setTimeout(abort, Math.max(1, task.timeoutMs));
    execution.promise = (async (): Promise<Result> => {
      try {
        const expectedThreadId = task.threadId;
        const hasPrompt = Boolean(task.input.trim());
        const operation: BrowserWorkerOperation = expectedThreadId ? (hasPrompt ? 'continue' : 'resume') : 'create';
        const request: BrowserWorkerRequest = {
          operation, thread_id: expectedThreadId, project: this.project(task, route), prompt: hasPrompt ? task.input : undefined,
          thinking_level: thinkingLevel(route.reasoning), state: null,
        };
        let response: BrowserWorkerResponse;
        try { response = await this.run(request, route, controller.signal); }
        catch (error) {
          if (controller.signal.aborted) throw error;
          if (operation === 'create') throw new LaunchFailure(error instanceof Error ? error.message : String(error));
          throw error;
        }
        const threadId = this.exposeThread(execution, expectedThreadId, response);
        this.routes.set(threadId, route);
        this.validateOperation(response, operation);
        let status = response.status;
        while (status !== 'awaiting_result' && status !== 'completed') {
          if (controller.signal.aborted) throw new Error('browser-worker execution aborted');
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 25);
            controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('browser-worker execution aborted')); }, { once: true });
          });
          const statusResponse = await this.run({ operation: 'status', thread_id: threadId, project: this.project(task, route), state: null }, route, controller.signal);
          if (statusResponse.thread_id && statusResponse.thread_id !== threadId) throw new Error('browser-worker returned a different thread_id');
          this.validateOperation(statusResponse, 'status');
          status = statusResponse.status;
        }
        const resultResponse = await this.run({ operation: 'result', thread_id: threadId, project: this.project(task, route), state: null }, route, controller.signal);
        if (resultResponse.thread_id && resultResponse.thread_id !== threadId) throw new Error('browser-worker returned a different thread_id');
        this.validateOperation(resultResponse, 'result');
        if (resultResponse.status !== 'completed' || resultResponse.result?.verified !== true || !resultResponse.result.message_id || !resultResponse.result.text?.trim()) throw browserWorkerError(resultResponse);
        return { summary: resultResponse.result.text.trim(), data: { threadId, messageId: resultResponse.result.message_id, verified: true, provider: route.provider, model: route.model } };
      } finally { clearTimeout(timeout); }
    })();
    return execution;
  }
}
