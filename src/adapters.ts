import { spawn } from 'node:child_process';
import { access, readFile, writeFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Task, AdapterName, Result, RoutingDecision, ChatGptTabClosePolicy } from './types.js';
import { ExecutionContext } from './execution-context.js';

export type Execution = {
  id: string;
  promise: Promise<Result>;
  cancel: () => void;
  threadId?: string;
  onThreadStarted?: (threadId: string) => void;
  launched?: Promise<void>;
};
export type LaunchContext = { waitForWorkerStart?: Promise<void>; waitForTerminal?: Promise<void>; executionContext?: ExecutionContext };
export interface WorkerAdapter {
  readonly name: AdapterName;
  readonly id: string;
  readonly capabilities: readonly string[];
  readonly tabClosePolicy?: ChatGptTabClosePolicy;
  launch(task: Task, signal: AbortSignal, context?: LaunchContext): Execution;
}

export function buildCodexArgs(
  route: Pick<RoutingDecision, 'provider' | 'model'> & Partial<Pick<RoutingDecision, 'profile' | 'reasoning' | 'cwd'>>,
  input: string,
): readonly string[] {
  const args: string[] = ['exec', '--json'];
  if (route.profile) args.push('-p', route.profile);
  if (route.model) args.push('-m', route.model);
  if (route.provider) args.push('-c', `model_provider=${route.provider}`);
  if (route.reasoning) args.push('-c', `model_reasoning_effort=${route.reasoning}`);
  if (route.cwd) args.push('-C', route.cwd);
  args.push('--', input);
  return args;
}

function parseThreadStarted(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    return value.type === 'thread.started' && typeof value.thread_id === 'string' ? value.thread_id : undefined;
  } catch {
    return undefined;
  }
}
function appendTail(current: string, chunk: string, maxBytes = 16384): string {
  const combined = current + chunk;
  return Buffer.byteLength(combined) <= maxBytes
    ? combined
    : Buffer.from(combined).subarray(-maxBytes).toString('utf8');
}

export class CodexAdapter implements WorkerAdapter {
  readonly name = 'codex' as const;
  readonly id = 'codex';
  readonly capabilities = ['model', 'codex'] as const;
  constructor(private readonly command = 'codex') {}

  launch(task: Task, signal: AbortSignal, context: LaunchContext = {}): Execution {
    if (!task.routing) throw new Error(`Task ${task.id} requires routing metadata before Codex launch`);
    const child = spawn(this.command, buildCodexArgs(task.routing, task.input), {
      shell: false,
      cwd: task.routing.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdoutBuffer = '';
    let stderrTail = '';
    let bufferedThreadId: string | undefined;
    let launchedResolve!: () => void;
    let launchedReject!: (error: Error) => void;
    const launched = new Promise<void>((resolve, reject) => { launchedResolve = resolve; launchedReject = reject; });
    launched.catch(() => {});
    let execution: Execution;
    const consumeLine = (line: string): void => {
      const threadId = parseThreadStarted(line);
      if (!threadId) return;
      bufferedThreadId = threadId;
      if (execution) {
        execution.threadId = threadId;
        execution.onThreadStarted?.(threadId);
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = appendTail(stderrTail, chunk.toString());
    });
    const promise = new Promise<Result>((resolve, reject) => {
      child.on('error', error => { launchedReject(error); reject(error); });
      child.once('spawn', launchedResolve);
      child.on('close', code => {
        if (stdoutBuffer) consumeLine(stdoutBuffer);
        if (code === 0) {
          resolve({ summary: 'Codex runtime exited after task execution; terminal task state is event-owned' });
        } else {
          reject(new Error(stderrTail.trim() || `Codex exited ${code}`));
        }
      });
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    execution = { id: randomUUID(), promise, launched, cancel: () => child.kill('SIGTERM') };
    execution.threadId = bufferedThreadId;
    return execution;
  }
}

export type BrowserWorkerRequest = { prompt: string; files?: string[]; tabClosePolicy?: ChatGptTabClosePolicy };
export type BrowserWorkerResponse = {
  operation: 'submit';
  status: 'submitted';
  temporary?: boolean;
  diagnostic_thread_id?: string | null;
  user_message_id?: string | null;
  verified?: boolean;
  error?: { code?: string; message?: string; retryable?: boolean } | null;
};
export type AgentRun = { promise: Promise<string>; cancel: () => void; submitted?: Promise<string>; release?: () => void };
export type ChatGptAgentRunner = (
  definition: string,
  request: BrowserWorkerRequest,
  route: RoutingDecision,
  signal: AbortSignal,
) => AgentRun;
export type ChatGptAdapterOptions = { agentPath?: string; agentRunner?: ChatGptAgentRunner; tabClosePolicy?: ChatGptTabClosePolicy };

export function chatGptTabClosePolicy(value: string | undefined, fallback: ChatGptTabClosePolicy = 'after-start'): ChatGptTabClosePolicy {
  const policy = value || fallback;
  if (!['after-start', 'never', 'after-terminal'].includes(policy)) throw new Error(`Invalid ChatGPT tab close policy: ${policy}`);
  return policy as ChatGptTabClosePolicy;
}

export class LaunchFailure extends Error {}
export class StartAckTimeout extends LaunchFailure {}

type BrowserWorkerRuntime = { definition: string; root: string };
async function loadBrowserWorkerRuntime(context: ExecutionContext | undefined, explicit?: string): Promise<BrowserWorkerRuntime> {
  const resolvedSkill = context?.skills.find(skill => skill.name === 'chatgpt-browser-worker');
  const candidate = explicit ?? (resolvedSkill ? join(dirname(resolvedSkill.path), 'agents', 'browser-worker.agent.md') : undefined);
  if (!candidate) throw new Error('chatgpt-browser-worker is not visible in the resolved execution context');
  try {
    await access(candidate);
    return { definition: await readFile(candidate, 'utf8'), root: dirname(dirname(candidate)) };
  } catch {
    throw new Error(`chatgpt-browser-worker agent definition not found at resolved path: ${candidate}`);
  }
}
function parseDriverJson(output: string): BrowserWorkerResponse {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const value = JSON.parse(lines[index]) as Record<string, unknown>;
      if (value.operation !== 'submit' || value.status !== 'submitted') continue;
      return value as BrowserWorkerResponse;
    } catch {
      // Browser-harness diagnostics may precede the final JSON observation.
    }
  }
  throw new Error('browser-worker driver returned no submitted receipt');
}
function directBrowserWorkerRunner(root: string): ChatGptAgentRunner {
  return (_definition, request, _route, signal): AgentRun => {
    const releaseFile = join(process.env.TMPDIR ?? '/tmp', `agents-relay-chatgpt-release-${randomUUID()}`);
    const args = [join(root, 'scripts', 'temporary_bh.py'), '--prompt', request.prompt, '--release-file', releaseFile, '--close-policy', request.tabClosePolicy ?? 'after-start'];
    for (const file of request.files ?? []) args.push('--file', file);
    const child = spawn('python3', args, { shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let submitted = false;
    let submittedResolve: ((value: string) => void) | undefined;
    let submittedReject: ((error: Error) => void) | undefined;
    const submittedPromise = new Promise<string>((resolve, reject) => { submittedResolve = resolve; submittedReject = reject; });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      if (!submitted) {
        try { const response = parseDriverJson(stdout); submitted = true; submittedResolve?.(JSON.stringify(response)); } catch { /* receipt may be split across chunks */ }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk.toString());
    });
    const promise = new Promise<string>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', code => {
        if (code !== 0) {
          const error = new Error(stderr.trim() || stdout.trim() || `browser-worker driver exited ${code}`);
          submittedReject?.(error); reject(error);
          return;
        }
        try {
          const result = JSON.stringify(parseDriverJson(stdout));
          if (!submitted) { submitted = true; submittedResolve?.(result); }
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      if (signal.aborted) child.kill('SIGTERM');
      else signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
    const release = (): void => { void writeFile(releaseFile, 'release').catch(() => {}); };
    promise.finally(() => { void unlink(releaseFile).catch(() => {}); }).catch(() => {});
    return { promise, submitted: submittedPromise, release, cancel: () => { release(); child.kill('SIGTERM'); } };
  };
}
function parseBrowserWorkerResponse(output: string): BrowserWorkerResponse {
  const text = output.trim().replace(/^\`\`\`(?:json)?\s*|\s*\`\`\`$/g, '').trim();
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('browser-worker returned non-JSON output');
  }
  if (!value || typeof value !== 'object') throw new Error('browser-worker returned an invalid JSON response');
  const response = value as BrowserWorkerResponse;
  if (response.operation !== 'submit' || response.status !== 'submitted') {
    throw new Error('browser-worker did not return a submitted receipt');
  }
  if (response.verified !== true) throw new Error('browser-worker submission was not verified');
  return response;
}

export class ChatGptAdapter implements WorkerAdapter {
  readonly name = 'chatgpt' as const;
  readonly id = 'chatgpt/browser-worker';
  readonly capabilities = ['model', 'chatgpt', 'browser-harness'] as const;
  private readonly agentPath?: string;
  private readonly runner?: ChatGptAgentRunner;
  readonly tabClosePolicy: ChatGptTabClosePolicy;

  constructor(options: ChatGptAdapterOptions = {}) {
    this.agentPath = options.agentPath ?? process.env.AGENTS_RELAY_CHATGPT_BROWSER_WORKER_AGENT;
    this.runner = options.agentRunner;
    this.tabClosePolicy = chatGptTabClosePolicy(options.tabClosePolicy ?? process.env.AGENTS_RELAY_CHATGPT_TAB_CLOSE_POLICY);
  }

  launch(task: Task, signal: AbortSignal, context: LaunchContext = {}): Execution {
    if (!task.routing) throw new Error(`Task ${task.id} requires routing metadata before ChatGPT launch`);
    const route = task.routing;
    const controller = new AbortController();
    const abort = (): void => controller.abort();
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    const execution: Execution = {
      id: randomUUID(),
      promise: Promise.resolve({ summary: '' }),
      cancel: abort,
    };
    let launchResolve!: () => void;
    let launchReject!: (error: unknown) => void;
    execution.launched = new Promise<void>((resolve, reject) => { launchResolve = resolve; launchReject = reject; });
    execution.launched.catch(() => {});
    execution.promise = (async (): Promise<Result> => {
      const runtime = await loadBrowserWorkerRuntime(context.executionContext, this.agentPath);
      if (controller.signal.aborted) throw new Error('browser-worker execution aborted');
      const policy = chatGptTabClosePolicy(task.chatgptTabClosePolicy, this.tabClosePolicy);
      const run = (this.runner ?? directBrowserWorkerRunner(runtime.root))(
        runtime.definition,
        { prompt: task.input, tabClosePolicy: policy },
        route,
        controller.signal,
      );
      try {
        const output = await (run.submitted ?? run.promise);
        const response = parseBrowserWorkerResponse(output);
        launchResolve();
        if (policy === 'after-start' && context.waitForWorkerStart) await context.waitForWorkerStart;
        else if (policy === 'after-terminal') {
          if (!context.waitForTerminal) throw new Error('ChatGPT after-terminal tab close policy requires a terminal event barrier');
          await context.waitForTerminal;
        }
        if (policy !== 'never') run.release?.();
        if (run.submitted) await run.promise;
        return {
          summary: 'ChatGPT task submitted; terminal task state is event-owned',
          data: {
            submitted: true,
            diagnosticThreadId: response.diagnostic_thread_id ?? null,
            userMessageId: response.user_message_id ?? null,
          },
        };
      } catch (error) {
        launchReject(error);
        if (policy !== 'never') run.release?.();
        if (controller.signal.aborted) throw error;
        if (error instanceof StartAckTimeout) throw error;
        throw new LaunchFailure(error instanceof Error ? error.message : String(error));
      }
    })();
    return execution;
  }
}
