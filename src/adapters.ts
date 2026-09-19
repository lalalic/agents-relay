import { spawn, ChildProcess } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Task, AdapterName, Result, RoutingDecision } from './types.js';

export type Execution = { id: string; promise: Promise<Result>; cancel: () => void; threadId?: string; onThreadStarted?: (threadId: string) => void };
export interface WorkerAdapter { readonly name: AdapterName; readonly id: string; readonly capabilities: readonly string[]; launch(task: Task, signal: AbortSignal): Execution; deleteThread?(threadId: string): Promise<void>; }
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
export class ShellAdapter implements WorkerAdapter {
  readonly name = 'shell' as const; readonly id = 'shell'; readonly capabilities = ['shell', 'command'] as const;
  constructor(private readonly shell = false) {}
  launch(task: Task, signal: AbortSignal): Execution { const parts = task.input.split(' ').filter(Boolean); const child = this.shell ? spawn(task.input, { shell: true }) : spawn(parts[0] ?? 'true', parts.slice(1)); let output = ''; child.stdout?.on('data', (x: Buffer) => { output += x.toString(); }); child.stderr?.on('data', (x: Buffer) => { output += x.toString(); }); return commandExecution(child, () => output, signal, randomUUID()); }
}
export class CodexAdapter implements WorkerAdapter {
  readonly name = 'codex' as const; readonly id = 'codex'; readonly capabilities = ['model', 'codex'] as const;
  constructor(private readonly command = 'codex') {}
  launch(task: Task, signal: AbortSignal): Execution { if (!task.routing) throw new Error(`Task ${task.id} requires routing metadata before Codex launch`); const route = task.routing; const args = buildCodexArgs(route, task.input); const child = spawn(this.command, args, { shell: false, cwd: route.cwd, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''; let bufferedThreadId: string | undefined; let execution: Execution; child.stdout?.on('data', (x: Buffer) => { const text = x.toString(); output += text; for (const line of text.split(/\r?\n/)) { const threadId = parseThreadStarted(line); if (threadId) { bufferedThreadId = threadId; if (execution) { execution.threadId = threadId; execution.onThreadStarted?.(threadId); } } } }); child.stderr?.on('data', (x: Buffer) => { output += x.toString(); }); execution = commandExecution(child, () => output, signal, randomUUID()); execution.threadId = bufferedThreadId; return execution; }
}


type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type ChatGptAdapterOptions = { endpoint?: string; tokenFile?: string; fetch?: FetchLike };
function chatGptThinkingEffort(reasoning?: string): 'minimal' | 'low' | 'standard' | 'high' | 'max' {
  if (reasoning === 'minimal' || reasoning === 'low' || reasoning === 'standard' || reasoning === 'high' || reasoning === 'max') return reasoning;
  if (reasoning === 'medium') return 'standard';
  if (reasoning === 'xhigh' || reasoning === 'extra-high') return 'max';
  return 'standard';
}
function chatGptEndpoint(base?: string): string {
  const configured = (base ?? process.env.AGENTS_RELAY_MACBRIDGE_URL ?? `http://127.0.0.1:${process.env.MAC_DEV_BRIDGE_HTTP_PORT ?? '8788'}`).replace(/\/+$/, '');
  const url = new URL(configured);
  if (url.pathname === '/experimental/chatgpt/conversation') return url.toString().replace(/\/$/, '');
  // --macbridge-url is a service origin. Do not inherit an unrelated API path
  // such as /v1/responses from a model-router endpoint.
  url.pathname = '/experimental/chatgpt/conversation';
  url.search = '';
  url.hash = '';
  return url.toString();
}
function chatGptTokenFile(file?: string): string {
  return file ?? process.env.AGENTS_RELAY_MACBRIDGE_TOKEN_FILE ?? process.env.MAC_DEV_BRIDGE_HTTP_TOKEN_FILE ?? join(homedir(), 'Library', 'Application Support', 'MacDeveloperBridge', 'http-token');
}
function chatGptConversationId(text: string): string | undefined {
  const match = /\"conversation_id\"\s*:\s*\"((?:\\.|[^\"\\])*)\"/.exec(text);
  if (!match) return undefined;
  try { const value = JSON.parse(`\"${match[1]}\"`) as unknown; return typeof value === 'string' ? value : undefined; } catch { return undefined; }
}
async function readChatGptResponse(response: Response, onConversationId: (conversationId: string) => void): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    const conversationId = chatGptConversationId(text);
    if (conversationId) onConversationId(conversationId);
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const conversationId = chatGptConversationId(text);
    if (conversationId) onConversationId(conversationId);
  }
  text += decoder.decode();
  const conversationId = chatGptConversationId(text);
  if (conversationId) onConversationId(conversationId);
  return text;
}

export class ChatGptAdapter implements WorkerAdapter {
  readonly name = 'chatgpt' as const;
  readonly id = 'chatgpt/macbridge';
  readonly capabilities = ['model', 'chatgpt', 'macbridge'] as const;
  private readonly endpoint: string;
  private readonly tokenFile: string;
  private readonly fetchImpl: FetchLike;
  constructor(options: ChatGptAdapterOptions = {}) {
    this.endpoint = chatGptEndpoint(options.endpoint);
    this.tokenFile = chatGptTokenFile(options.tokenFile);
    this.fetchImpl = options.fetch ?? fetch;
  }
  async deleteThread(threadId: string): Promise<void> {
    const token = (await readFile(this.tokenFile, 'utf8')).trim();
    if (!token) throw new Error(`MacBridge token file is empty: ${this.tokenFile}`);
    const response = await this.fetchImpl(this.endpoint, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ conversation_id: threadId }),
    });
    if (response.status === 404) return;
    if (!response.ok) {
      let detail = '';
      try { const payload = await response.json() as Record<string, unknown>; detail = typeof payload.error === 'string' ? payload.error : ''; } catch {}
      throw new Error(detail || `MacBridge ChatGPT conversation delete failed (${response.status})`);
    }
  }
  launch(task: Task, signal: AbortSignal): Execution {
    if (!task.routing) throw new Error(`Task ${task.id} requires routing metadata before ChatGPT launch`);
    const route = task.routing;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
    const execution: Execution = { id: randomUUID(), promise: Promise.resolve({ summary: '' }), cancel: abort };
    execution.promise = (async (): Promise<Result> => {
      const token = (await readFile(this.tokenFile, 'utf8')).trim();
      if (!token) throw new Error(`MacBridge token file is empty: ${this.tokenFile}`);
      const body: Record<string, unknown> = {
        prompt: task.input,
        model: route.model,
        thinking_effort: chatGptThinkingEffort(route.reasoning),
        max_runtime_seconds: Math.max(30, Math.min(3600, Math.ceil(task.timeoutMs / 1000))),
      };
      if (route.projectId) body.project_id = route.projectId;
      if (task.threadId) body.conversation_id = task.threadId;
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      let exposedConversationId: string | undefined;
      const exposeConversationId = (conversationId: string): void => {
        if (exposedConversationId === conversationId) return;
        exposedConversationId = conversationId;
        execution.threadId = conversationId;
        execution.onThreadStarted?.(conversationId);
      };
      const text = await readChatGptResponse(response, exposeConversationId);
      let payload: Record<string, unknown>;
      try { payload = JSON.parse(text) as Record<string, unknown>; } catch { throw new Error(`MacBridge returned unreadable ChatGPT response (${response.status})`); }
      const conversationId = typeof payload.conversation_id === 'string' ? payload.conversation_id : exposedConversationId;
      if (conversationId) exposeConversationId(conversationId);
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : `MacBridge ChatGPT request failed (${response.status})`);
      if (payload.complete !== true) throw new Error('MacBridge ChatGPT conversation did not complete');
      const assistantText = typeof payload.assistant_text === 'string' ? payload.assistant_text.trim() : '';
      return {
        summary: assistantText || 'ChatGPT conversation completed',
        data: { conversationId, provider: route.provider, model: route.model },
      };
    })();
    return execution;
  }
}
