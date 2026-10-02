import { spawn } from 'node:child_process';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
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
  else if (route.provider) args.push('-p', route.provider);
  if (route.model) args.push('-m', route.model);
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
function signalChildTree(child: import('node:child_process').ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid && process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  child.kill(signal);
}

function terminateChild(child: import('node:child_process').ChildProcess, graceMs = 750): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalChildTree(child, 'SIGTERM');
  const force = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalChildTree(child, 'SIGKILL');
  }, graceMs);
  force.unref();
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
      detached: process.platform !== 'win32',
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
      signal.addEventListener('abort', () => terminateChild(child), { once: true });
    });
    execution = { id: randomUUID(), promise, launched, cancel: () => terminateChild(child) };
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
  verified_by?: 'user-turn' | 'composer-cleared';
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
export const CHATGPT_BROWSER_WORKSPACE = 'Relay';
export const CHATGPT_BROWSER_WORKSPACE_POOL_SIZE = 6;

export function chatGptTabClosePolicy(value: string | undefined, fallback: ChatGptTabClosePolicy = 'after-start'): ChatGptTabClosePolicy {
  const policy = value || fallback;
  if (!['after-start', 'never', 'after-terminal'].includes(policy)) throw new Error(`Invalid ChatGPT tab close policy: ${policy}`);
  return policy as ChatGptTabClosePolicy;
}

export class LaunchFailure extends Error {}
export class StartAckTimeout extends LaunchFailure {}

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
type BrowserWorkspaceCli = { command: string; prefix: readonly string[] };
function browserWorkspaceCli(override = process.env.AGENTS_RELAY_BROWSER_WORKSPACE_COMMAND): BrowserWorkspaceCli {
  return override ? { command: override, prefix: [] } : { command: 'npx', prefix: ['browser-workspace'] };
}
function browserWorkspaceCommand(cli: BrowserWorkspaceCli, args: readonly string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli.command, [...cli.prefix, ...args], { shell: false, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk.toString()); });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || stdout.trim() || `browser-workspace exited ${code}`));
    });
    if (stdin !== undefined) {
      child.stdin?.end(stdin);
    }
  });
}

function parseWorkspaceJson(output: string): Record<string, unknown> {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try { return JSON.parse(lines[index]) as Record<string, unknown>; } catch { /* diagnostics may precede JSON */ }
  }
  throw new Error('browser-workspace returned no JSON result');
}

export async function ensureChatGptBrowserWorkspace(command = process.env.AGENTS_RELAY_BROWSER_WORKSPACE_COMMAND): Promise<void> {
  try {
    await browserWorkspaceCommand(browserWorkspaceCli(command), ['create', CHATGPT_BROWSER_WORKSPACE, String(CHATGPT_BROWSER_WORKSPACE_POOL_SIZE)]);
  } catch (error) {
    console.warn(`[agents-relay] browser workspace ensure skipped: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function sessionBrowserWorkerRunner(): ChatGptAgentRunner {
  const cli = browserWorkspaceCli();
  return (_definition, request, _route, signal): AgentRun => {
    const policy = request.tabClosePolicy ?? 'after-start';
    let activeSessionId: string | undefined;
    let released = false;
    let releaseResolve!: () => void;
    const releaseBarrier = new Promise<void>(resolve => { releaseResolve = resolve; });
    const release = (): void => {
      if (released) return;
      released = true;
      releaseResolve();
    };

    let submittedResolve!: (value: string) => void;
    let submittedReject!: (error: Error) => void;
    const submitted = new Promise<string>((resolve, reject) => {
      submittedResolve = resolve;
      submittedReject = reject;
    });
    const promise = (async (): Promise<string> => {
      const configFile = join(process.env.TMPDIR ?? '/tmp', `agents-relay-chatgpt-${randomUUID()}.json`);
      try {
        await writeFile(configFile, JSON.stringify({
          prompt: request.prompt,
          file: request.files ?? [],
          close_policy: 'never',
        }));

        const startOutput = await browserWorkspaceCommand(
          cli,
          ['session', 'start', '--workspace', CHATGPT_BROWSER_WORKSPACE],
        );
        const started = parseWorkspaceJson(startOutput);
        if (typeof started.session_id !== 'string') {
          throw new Error('browser-workspace session start returned no session_id');
        }
        activeSessionId = started.session_id;
        if (signal.aborted) throw new Error('browser-worker execution aborted');

        const source = await browserWorkspaceCommand(
          cli,
          ['platform', 'source', 'chatgpt', 'temporary-submit', '--config', configFile],
        );

        const execOutput = await browserWorkspaceCommand(
          cli,
          ['session', 'exec', activeSessionId],
          source,
        );
        const wrapper = parseWorkspaceJson(execOutput);
        if (wrapper.ok !== true) {
          throw new Error(typeof wrapper.error === 'string' ? wrapper.error : 'browser-workspace session exec failed');
        }
        const receipt = parseDriverJson(typeof wrapper.stdout === 'string' ? wrapper.stdout : '');
        const result = JSON.stringify(receipt);
        submittedResolve(result);

        if (policy === 'never') {
          await unlink(configFile).catch(() => {});
          activeSessionId = undefined;
          return result;
        }
        await releaseBarrier;
        if (activeSessionId) {
          await browserWorkspaceCommand(cli, ['session', 'stop', activeSessionId]);
          activeSessionId = undefined;
        }
        return result;

      } catch (failure) {
        if (activeSessionId) {
          await browserWorkspaceCommand(cli, ['session', 'stop', activeSessionId]).catch(() => {});
          activeSessionId = undefined;
        }
        await unlink(configFile).catch(() => {});
        const error = failure instanceof Error ? failure : new Error(String(failure));
        submittedReject(error);
        throw error;
      }
    })();

    const cancel = (): void => {
      release();
      if (activeSessionId) {
        void browserWorkspaceCommand(cli, ['session', 'stop', activeSessionId]);
        activeSessionId = undefined;
      }
    };
    if (signal.aborted) cancel();
    else signal.addEventListener('abort', cancel, { once: true });
    return { promise, submitted, release, cancel };
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
  readonly capabilities = ['model', 'chatgpt', 'browser-workspace'] as const;
  private readonly runner?: ChatGptAgentRunner;
  readonly tabClosePolicy: ChatGptTabClosePolicy;

  constructor(options: ChatGptAdapterOptions = {}) {
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
      const definition = await readFile(new URL('../agents/chatgpt-worker.agent.md', import.meta.url), 'utf8');
      if (controller.signal.aborted) throw new Error('browser-worker execution aborted');
      const policy = chatGptTabClosePolicy(task.chatgptTabClosePolicy, this.tabClosePolicy);
      const run = (this.runner ?? sessionBrowserWorkerRunner())(
        definition,
        { prompt: task.input, ...(task.attachments?.length ? { files: task.attachments } : {}), tabClosePolicy: policy },
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
            verifiedBy: response.verified_by ?? null,
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
