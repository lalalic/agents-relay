import { spawn, ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Task, AdapterName, Result, RoutingDecision } from './types.js';

export type Execution = { id: string; promise: Promise<Result>; cancel: () => void; threadId?: string; onThreadStarted?: (threadId: string) => void };
export interface WorkerAdapter { readonly name: AdapterName; readonly id: string; readonly capabilities: readonly string[]; launch(task: Task, signal: AbortSignal): Execution; }
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
