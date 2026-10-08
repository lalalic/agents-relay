import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Task, AdapterName, Result, RoutingDecision, ChatGptTabClosePolicy, ChatGptThreadDelivery } from './types.js';
import { ExecutionContext } from './execution-context.js';
import { spawnOwnedProcess, terminateOwnedProcess, ownedProcessTerminationReason } from './owned-process.js';

export type Execution = {
  id: string;
  promise: Promise<Result>;
  cancel: () => void;
  threadId?: string;
  onThreadStarted?: (threadId: string) => void;
  launched?: Promise<void>;
  processExit?: { exitCode: number | null; signal: NodeJS.Signals | null; stderr: string; terminationReason: string | null };
  pid?: number;
  deliveryReceipt?: Record<string, unknown>;
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
    const child = spawnOwnedProcess(this.command, buildCodexArgs(task.routing, task.input), {
      invocation: `worker.codex:${task.id}`,
      signal,
      correlation: { jobId: task.jobId, taskId: task.id, executionId: task.executionId ?? undefined },
      spawn: { shell: false, cwd: task.routing.cwd, stdio: ['ignore', 'pipe', 'pipe'] },
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
      child.on('close', (code, signal) => {
        execution.processExit = { exitCode: code, signal, stderr: stderrTail, terminationReason: ownedProcessTerminationReason(child) };
        if (stdoutBuffer) consumeLine(stdoutBuffer);
        if (code === 0) {
          resolve({ summary: 'Codex runtime exited after task execution; terminal task state is event-owned' });
        } else {
          reject(new Error(stderrTail.trim() || `Codex exited ${code}`));
        }
      });
    });
    execution = { id: randomUUID(), promise, launched, pid: child.pid, cancel: () => { void terminateOwnedProcess(child, 'cancel'); } };
    execution.threadId = bufferedThreadId;
    return execution;
  }
}

export type BrowserWorkerRequest = { prompt: string; files?: string[]; tabClosePolicy?: ChatGptTabClosePolicy; thread?: ChatGptThreadDelivery };
export type BrowserWorkerResponse = {
  operation?: 'submit' | 'new-turn';
  status: 'submitted';
  mode?: 'new-turn';
  project_id?: string | null;
  thread_id?: string | null;
  temporary?: boolean;
  diagnostic_thread_id?: string | null;
  user_message_id?: string | null;
  verified_by?: 'user-turn' | 'composer-cleared' | 'existing-user-turn';
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

function findSubmittedReceipt(value: unknown): BrowserWorkerResponse | undefined {
  if (typeof value === 'string') {
    try { return findSubmittedReceipt(JSON.parse(value)); } catch { return undefined; }
  }
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  if ((record.operation === 'submit' || record.operation === 'new-turn' || record.mode === 'new-turn') && record.status === 'submitted') return record as BrowserWorkerResponse;
  for (const key of ['result', 'output', 'data', 'stdout']) {
    const nested = findSubmittedReceipt(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

export function parseDriverJson(output: string): BrowserWorkerResponse {
  const lines = output.trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const receipt = findSubmittedReceipt(JSON.parse(lines[index]));
      if (receipt) return receipt;
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
function browserWorkspaceCommand(cli: BrowserWorkspaceCli, args: readonly string[], stdin?: string, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnOwnedProcess(cli.command, [...cli.prefix, ...args], {
      invocation: 'browser-workspace.command',
      signal,
      spawn: { shell: false, stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'] },
    });
    let stdout = '';
    let stderr = '';
    const abort = (): void => { void terminateOwnedProcess(child, 'abort'); };
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr = appendTail(stderr, chunk.toString()); });
    child.on('error', reject);
    child.on('close', code => {
      signal?.removeEventListener('abort', abort);
      if (code === 0) resolve(stdout.trim());
      else if (signal?.aborted) reject(new Error('browser-worker execution aborted'));
      else reject(new Error(stderr.trim() || stdout.trim() || `browser-workspace exited ${code}`));
    });
    if (signal?.aborted) abort();
    else signal?.addEventListener('abort', abort, { once: true });
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

type BrowserWorkspaceStatus = { admin_helper?: unknown };
type BrowserWorkspaceAdminModule = { ensureWorkspace?: (name: string, size?: number) => Promise<unknown> | unknown };

export async function ensureChatGptBrowserWorkspace(command = process.env.AGENTS_RELAY_BROWSER_WORKSPACE_COMMAND): Promise<void> {
  const status = parseWorkspaceJson(await browserWorkspaceCommand(browserWorkspaceCli(command), ['status'])) as BrowserWorkspaceStatus;
  if (typeof status.admin_helper !== 'string' || !status.admin_helper.startsWith('/')) {
    throw new Error('browser-workspace status returned no absolute admin_helper path');
  }
  const admin = await import(pathToFileURL(status.admin_helper).href) as BrowserWorkspaceAdminModule;
  if (typeof admin.ensureWorkspace !== 'function') {
    throw new Error('browser-workspace admin helper does not export ensureWorkspace');
  }
  await admin.ensureWorkspace(CHATGPT_BROWSER_WORKSPACE, CHATGPT_BROWSER_WORKSPACE_POOL_SIZE);
}


/**
 * The upstream new-turn action accepts idempotency_key but does not enforce it.
 * Inspect the current thread before resubmitting after an ambiguous exit.
 * If the transcript is not observable, fail closed rather than duplicate.
 */
async function findExistingReviewTurn(cli: BrowserWorkspaceCli, sessionId: string, delivery: ChatGptThreadDelivery, signal: AbortSignal): Promise<BrowserWorkerResponse | null> {
  const pathname = delivery.projectId
    ? `/g/${encodeURIComponent(delivery.projectId)}/c/${encodeURIComponent(delivery.threadId)}`
    : `/c/${encodeURIComponent(delivery.threadId)}`;
  const marker = `Relay delivery ID: ${delivery.requestId}`;
  const inspectJs = `(() => {
    const legacy = [...document.querySelectorAll('[data-message-author-role="user"]')]
      .map(e => ({text: (e.innerText || '').trim(), id: e.getAttribute('data-message-id') || ''})).filter(x => x.text);
    if (legacy.length) return legacy;
    return [...document.querySelectorAll('h4')].filter(e => (e.innerText || '').trim() === 'You said:')
      .map((e,i) => ({text: (e.parentElement?.innerText || '').trim(), id: 'dom-user-' + i})).filter(x => x.text);
  })()`;
  const script = [
    'import json, time',
    'from urllib.parse import urlsplit',
    `url = ${JSON.stringify(`https://chatgpt.com${pathname}`)}`,
    `marker = ${JSON.stringify(marker)}`,
    'goto_url(url)',
    'wait_for_load()',
    'if urlsplit(page_info().get("url", "")).path.rstrip("/") != urlsplit(url).path.rstrip("/"): raise RuntimeError("review thread redirect mismatch")',
    'turns = []',
    'for attempt in range(30):',
    `    turns = js(${JSON.stringify(inspectJs)}) or []`,
    '    if turns: break',
    '    time.sleep(0.5)',
    'if not turns: raise RuntimeError("review thread transcript unavailable; refusing ambiguous resubmission")',
    'matches = [turn for turn in turns if marker in turn.get("text", "")]',
    'if len(matches) > 1: raise RuntimeError("duplicate review delivery detected; manual reconciliation required")',
    'print(json.dumps({"found": bool(matches), "user_message_id": matches[0].get("id") if matches else None}), flush=True)',
  ].join('\n');
  const envelope = parseWorkspaceJson(await browserWorkspaceCommand(cli, ['session', 'exec', sessionId], script, signal));
  if (envelope.ok !== true || typeof envelope.stdout !== 'string') throw new Error('review thread inspection returned no executable result');
  const observation = parseWorkspaceJson(envelope.stdout);
  if (typeof observation.found !== 'boolean') throw new Error('review thread inspection returned no authoritative result');
  if (!observation.found) return null;
  return { status: 'submitted', mode: 'new-turn', thread_id: delivery.threadId, project_id: delivery.projectId,
    verified_by: 'existing-user-turn', user_message_id: typeof observation.user_message_id === 'string' ? observation.user_message_id : null };
}

async function runBrowserWorker(cli: BrowserWorkspaceCli, configFile: string, signal: AbortSignal, action: 'temporary-submit' | 'new-turn' = 'temporary-submit', delivery?: ChatGptThreadDelivery): Promise<string> {
  const session = parseWorkspaceJson(await browserWorkspaceCommand(cli, ['session', 'start'], undefined, signal));
  const sessionId = session.session_id;
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('browser-workspace session start returned no session_id');
  try {
    if (delivery) {
      const existing = await findExistingReviewTurn(cli, sessionId, delivery, signal);
      if (existing) return JSON.stringify(existing);
    }
    return await browserWorkspaceCommand(
      cli,
      ['platform', 'run', 'chatgpt', action, '--session-id', sessionId, '--config', configFile],
      undefined,
      signal,
    );
  } finally {
    await browserWorkspaceCommand(cli, ['session', 'stop', sessionId]).catch(() => {});
  }
}

function browserWorkerRunner(): ChatGptAgentRunner {
  const cli = browserWorkspaceCli();
  return (_definition, request, _route, signal): AgentRun => {
    const promise = (async (): Promise<string> => {
      const configFile = join(process.env.TMPDIR ?? '/tmp', `agents-relay-chatgpt-${randomUUID()}.json`);
      try {
        const delivery = request.thread;
        await writeFile(configFile, JSON.stringify(delivery ? {
          project_id: delivery.projectId ?? _route.projectId ?? null,
          thread_id: delivery.threadId,
          message: `${request.prompt}\n\nRelay delivery ID: ${delivery.requestId}`,
          idempotency_key: delivery.requestId,
        } : {
          prompt: request.prompt,
          file: request.files ?? [],
        }));
        if (signal.aborted) throw new Error('browser-worker execution aborted');
        const action = delivery ? 'new-turn' : 'temporary-submit';
        const output = await runBrowserWorker(cli, configFile, signal, action, delivery);
        return JSON.stringify(parseDriverJson(output));
      } finally {
        await unlink(configFile).catch(() => {});
      }
    })();
    return { promise, submitted: promise, cancel: () => {} };
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
  const verified = response.verified === true || response.verified_by !== undefined;
  if (response.status !== 'submitted' || !verified) {
    throw new Error('browser-worker did not return a submitted receipt');
  }
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
      const run = (this.runner ?? browserWorkerRunner())(
        definition,
        {
          prompt: task.input,
          ...(task.attachments?.length ? { files: task.attachments } : {}),
          ...(task.chatgptThreadDelivery ? { thread: task.chatgptThreadDelivery } : {}),
          tabClosePolicy: policy,
        },
        route,
        controller.signal,
      );
      try {
        const output = await (run.submitted ?? run.promise);
        const response = parseBrowserWorkerResponse(output);
        if (task.chatgptThreadDelivery && (typeof response.thread_id !== 'string' || response.thread_id !== task.chatgptThreadDelivery.threadId)) {
          throw new Error('browser-worker submitted to an unexpected ChatGPT thread');
        }
        execution.deliveryReceipt = { ...response };
        launchResolve();
        if (policy === 'after-start' && context.waitForWorkerStart) await context.waitForWorkerStart;
        else if (policy === 'after-terminal') {
          if (!context.waitForTerminal) throw new Error('ChatGPT after-terminal compatibility policy requires a terminal event barrier');
          await context.waitForTerminal;
        }
        if (policy !== 'never') run.release?.();
        if (run.submitted) await run.promise;
        return {
          summary: 'ChatGPT task submitted; terminal task state is event-owned',
          data: {
            submitted: true,
            mode: response.mode ?? 'temporary-submit',
            threadId: response.thread_id ?? response.diagnostic_thread_id ?? null,
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
