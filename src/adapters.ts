import { spawn, ChildProcess } from 'node:child_process';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Task, AdapterName, Result, RoutingDecision } from './types.js';

export type Execution = { id: string; promise: Promise<Result>; cancel: () => void; threadId?: string; onThreadStarted?: (threadId: string) => void };
export interface WorkerAdapter { readonly name: AdapterName; readonly id: string; readonly capabilities: readonly string[]; launch(task: Task, signal: AbortSignal): Execution; recover?(task: Task): Promise<Result | null>; deleteThread?(threadId: string): Promise<void>; }
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

function browserWorkerCandidates(explicit?: string): string[] {
  const roots = (process.env.AGENTS_RELAY_SKILL_ROOTS ?? '').split(':').filter(Boolean);
  return [explicit, ...roots, join(homedir(), '.codex', 'skills'), join(homedir(), '.agents', 'skills'), join(process.cwd(), 'skills')]
    .filter((value): value is string => Boolean(value))
    .map(value => value.endsWith('browser-worker.agent.md') ? value : join(value, 'chatgpt-browser-worker', 'agents', 'browser-worker.agent.md'));
}
async function loadBrowserWorkerDefinition(explicit?: string): Promise<string> {
  for (const candidate of browserWorkerCandidates(explicit)) {
    try { await access(candidate); return readFile(candidate, 'utf8'); } catch { /* try the next installed skill root */ }
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
function agentPrompt(definition: string, request: BrowserWorkerRequest): string {
  return `${definition}\n\nReturn only the machine-readable JSON response required by the agent contract.\nREQUEST_JSON:\n${JSON.stringify(request)}`;
}
function defaultChatGptAgentRunner(harness: string): ChatGptAgentRunner {
  return (definition, request, route, signal): AgentRun => {
    const child = spawn(harness, buildCodexArgs(route, agentPrompt(definition, request)), { shell: false, cwd: route.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk.toString()); });
    const promise = new Promise<string>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolve(parseCodexAgentMessage(stdout) ?? stdout.trim()) : reject(new Error(stderr.trim() || `browser-worker harness exited ${code}`)));
      if (signal.aborted) child.kill('SIGTERM'); else signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    return { promise, cancel: () => { child.kill('SIGTERM'); } };
  };
}
function parseCodexAgentMessage(output: string): string | undefined {
  let final: string | undefined;
  for (const line of output.split(/\r?\n/)) {
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      const payload = value.payload as Record<string, unknown> | undefined;
      const item = value.item as Record<string, unknown> | undefined;
      if (value.type === 'event_msg' && payload?.type === 'task_complete' && typeof payload.last_agent_message === 'string') final = payload.last_agent_message;
      if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') final = item.text;
    } catch { /* harness diagnostics are not the agent response */ }
  }
  return final;
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
  private readonly harness: string;
  private readonly runner?: ChatGptAgentRunner;
  private readonly deleted = new Set<string>();
  constructor(options: ChatGptAdapterOptions = {}) { this.agentPath = options.agentPath ?? process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT; this.harness = options.harness ?? process.env.AGENTS_RELAY_AGENT_HARNESS ?? 'codex'; this.runner = options.agentRunner; }
  private async run(request: BrowserWorkerRequest, route: RoutingDecision, signal: AbortSignal): Promise<BrowserWorkerResponse> {
    const definition = await loadBrowserWorkerDefinition(this.agentPath);
    if (signal.aborted) throw new Error('browser-worker execution aborted');
    const run = (this.runner ?? defaultChatGptAgentRunner(this.harness))(definition, request, route, signal);
    return parseBrowserWorkerResponse(await run.promise);
  }
  async deleteThread(threadId: string): Promise<void> {
    if (this.deleted.has(threadId)) return;
    const route: RoutingDecision = { provider: 'openai', model: 'gpt-5', decidedBy: 'adapter', decidedAt: new Date().toISOString() };
    const response = await this.run({ operation: 'delete', thread_id: threadId, project: { name: 'unknown' }, state: null }, route, new AbortController().signal);
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
    execution.promise = (async (): Promise<Result> => {
      const threadId = task.threadId;
      const request: BrowserWorkerRequest = {
        operation: threadId ? 'continue' : 'create', thread_id: threadId, project: { name: task.projectName ?? route.projectId ?? 'default', id: route.projectId }, prompt: task.input,
        thinking_level: thinkingLevel(route.reasoning), state: null,
      };
      const response = await this.run(request, route, controller.signal);
      if (response.thread_id) { execution.threadId = response.thread_id; execution.onThreadStarted?.(response.thread_id); }
      if (response.status !== 'completed' || response.operation !== 'result' || response.result?.verified !== true || !response.result.message_id || !response.result.text?.trim()) throw browserWorkerError(response);
      return { summary: response.result.text.trim(), data: { threadId: response.thread_id, messageId: response.result.message_id, verified: true, provider: route.provider, model: route.model } };
    })();
    return execution;
  }
}
