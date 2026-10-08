import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import { observability, type ObservabilityCorrelation } from './observability.js';

export type OwnedProcessTerminationReason =
  | 'abort'
  | 'cancel'
  | 'timeout'
  | 'leader-exit'
  | 'parent-shutdown'
  | 'retry'
  | 'reconcile';

export type OwnedProcessOptions = {
  invocation: string;
  spawn?: SpawnOptions;
  signal?: AbortSignal;
  timeoutMs?: number;
  graceMs?: number;
  correlation?: ObservabilityCorrelation;
};

type OwnedProcessRecord = {
  child: ChildProcess;
  invocationId: string;
  invocation: string;
  command: string;
  pid: number;
  processGroup: number | null;
  startedAt: number;
  graceMs: number;
  correlation?: ObservabilityCorrelation;
  terminating: boolean;
  terminationReason?: OwnedProcessTerminationReason;
  forceTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  abort?: () => void;
  supervisor?: ChildProcess;
};

const owned = new Map<number, OwnedProcessRecord>();
const byChild = new WeakMap<ChildProcess, OwnedProcessRecord>();
export function ownedProcessTerminationReason(child: ChildProcess): OwnedProcessTerminationReason | null {
  return byChild.get(child)?.terminationReason ?? null;
}
let exitHookInstalled = false;

function audit(record: OwnedProcessRecord, event: string, outcome: 'started' | 'succeeded' | 'failed', data: Record<string, unknown>): void {
  observability().record({
    stage: 'daemon',
    event,
    outcome,
    level: outcome === 'failed' ? 'warn' : 'info',
    message: `${record.invocation} process ${event.replace('process.', '')}`,
    correlation: record.correlation,
    data: {
      invocationId: record.invocationId,
      invocation: record.invocation,
      executable: basename(record.command),
      pid: record.pid,
      processGroup: record.processGroup,
      elapsedMs: Date.now() - record.startedAt,
      ...data,
    },
  });
}

function signalOwned(record: OwnedProcessRecord, signal: NodeJS.Signals): 'sent' | 'gone' | 'error' {
  try {
    if (record.processGroup !== null) process.kill(-record.processGroup, signal);
    else if (!record.child.kill(signal)) return 'gone';
    return 'sent';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone';
    audit(record, 'process.signal_failed', 'failed', { signal, error: error instanceof Error ? error.message : String(error) });
    return 'error';
  }
}

function forceOwned(record: OwnedProcessRecord, reason: OwnedProcessTerminationReason): void {
  if (!owned.has(record.pid)) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill', ['/pid', String(record.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    audit(record, 'process.signal', result.status === 0 ? 'succeeded' : 'failed', { reason, signal: 'taskkill-/t-/f', exitStatus: result.status });
    return;
  }
  const outcome = signalOwned(record, 'SIGKILL');
  audit(record, 'process.signal', outcome === 'error' ? 'failed' : 'succeeded', { reason, signal: 'SIGKILL', delivered: outcome === 'sent', alreadyGone: outcome === 'gone' });
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => {
    for (const record of owned.values()) forceOwned(record, 'parent-shutdown');
  });
}

function launchParentDeathSupervisor(pid: number, processGroup: number | null, graceMs: number): ChildProcess {
  const posix = process.platform !== 'win32';
  const script = posix ? [
    "const pgid=Number(process.argv[1]),grace=Number(process.argv[2]);",
    "const alive=()=>{try{process.kill(-pgid,0);return true}catch(e){return e&&e.code==='EPERM'}};",
    "const stop=()=>{try{process.kill(-pgid,'SIGTERM')}catch{}setTimeout(()=>{try{process.kill(-pgid,'SIGKILL')}catch{}process.exit(0)},grace).unref()};",
    "const timer=setInterval(()=>{if(!alive()){clearInterval(timer);process.exit(0);return}if(process.ppid===1){clearInterval(timer);stop()}},250);",
  ].join('') : [
    "const {spawnSync}=require('node:child_process'),owner=Number(process.argv[1]),pid=Number(process.argv[2]);",
    "const alive=p=>{try{process.kill(p,0);return true}catch{return false}};",
    "const timer=setInterval(()=>{if(!alive(pid)){clearInterval(timer);process.exit(0);return}if(!alive(owner)){clearInterval(timer);spawnSync('taskkill',['/pid',String(pid),'/t','/f'],{stdio:'ignore'});process.exit(0)}},250);",
  ].join('');
  const supervisorArgs = posix ? [String(processGroup), String(graceMs)] : [String(process.pid), String(pid)];
  const supervisor = spawn(process.execPath, ['-e', script, ...supervisorArgs], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  supervisor.unref();
  return supervisor;
}

/** Spawn one disposable Relay-owned process group. Arguments are intentionally excluded from audit logs. */
export function spawnOwnedProcess(command: string, args: readonly string[], options: OwnedProcessOptions): ChildProcess {
  installExitHook();
  if (options.signal?.aborted) throw new Error(`${options.invocation} aborted before launch`);
  const detached = process.platform !== 'win32';
  const child = spawn(command, [...args], { ...options.spawn, detached });
  if (!child.pid) return child;
  const record: OwnedProcessRecord = {
    child,
    invocationId: randomUUID(),
    invocation: options.invocation,
    command,
    pid: child.pid,
    processGroup: detached ? child.pid : null,
    startedAt: Date.now(),
    graceMs: options.graceMs ?? 750,
    correlation: options.correlation,
    terminating: false,
  };
  owned.set(record.pid, record);
  byChild.set(child, record);
  record.supervisor = launchParentDeathSupervisor(record.pid, record.processGroup, record.graceMs);
  audit(record, 'process.launched', 'started', {});

  const abort = (): void => { void terminateOwnedProcess(child, 'abort'); };
  record.abort = abort;
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.timeoutMs !== undefined) {
    record.timeoutTimer = setTimeout(() => { void terminateOwnedProcess(child, 'timeout'); }, options.timeoutMs);
    record.timeoutTimer.unref();
  }

  child.once('exit', (code, signal) => {
    audit(record, 'process.exited', code === 0 ? 'succeeded' : 'failed', { exitStatus: code, signal, terminationReason: record.terminationReason ?? null });
    // `close` waits for inherited stdio. End any descendants left behind by a
    // wrapper before they can keep the caller alive indefinitely.
    if (!record.terminating) void terminateOwnedProcess(child, 'leader-exit');
  });
  child.once('close', () => {
    if (record.timeoutTimer) clearTimeout(record.timeoutTimer);
    options.signal?.removeEventListener('abort', abort);
    // The leader closing is not proof that its process group is gone.
    // In particular, unref'd grandchildren need not inherit stdio.
    // Preserve ownership and the force-kill timer through the grace window.
    if (!record.terminating) void terminateOwnedProcess(child, 'leader-exit');
    setTimeout(() => {
      if (record.forceTimer) clearTimeout(record.forceTimer);
      record.supervisor?.kill('SIGTERM');
      owned.delete(record.pid);
    }, record.graceMs + 100).unref();
  });
  return child;
}

export async function terminateOwnedProcess(
  child: ChildProcess,
  reason: OwnedProcessTerminationReason,
  graceMs?: number,
): Promise<void> {
  const record = byChild.get(child);
  if (!record || !owned.has(record.pid)) return;
  if (!record.terminating) {
    record.terminating = true;
    record.terminationReason = reason;
    const outcome = signalOwned(record, 'SIGTERM');
    audit(record, 'process.signal', outcome === 'error' ? 'failed' : 'succeeded', { reason, signal: 'SIGTERM', delivered: outcome === 'sent', alreadyGone: outcome === 'gone' });
    record.forceTimer = setTimeout(() => forceOwned(record, reason), graceMs ?? record.graceMs);
    record.forceTimer.unref();
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const fallback = setTimeout(resolve, (graceMs ?? record.graceMs) + 1000);
    fallback.unref();
    child.once('close', () => { clearTimeout(fallback); resolve(); });
  });
}

export async function shutdownOwnedProcesses(reason: OwnedProcessTerminationReason = 'parent-shutdown'): Promise<void> {
  await Promise.allSettled([...owned.values()].map(record => terminateOwnedProcess(record.child, reason)));
}

export function ownedProcessSnapshot(): readonly Readonly<{
  invocationId: string;
  invocation: string;
  pid: number;
  processGroup: number | null;
  elapsedMs: number;
}>[] {
  return [...owned.values()].map(record => ({
    invocationId: record.invocationId,
    invocation: record.invocation,
    pid: record.pid,
    processGroup: record.processGroup,
    elapsedMs: Date.now() - record.startedAt,
  }));
}
