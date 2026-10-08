import { execFile } from 'node:child_process';
import { hostname } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** The OS launch identity is intentionally kept outside GitHub task markers. */
export type ExecutionProcessRecord = {
  jobId: string;
  taskId: string;
  executionId: string;
  leaseOwner: string;
  host: string;
  pid: number;
  pgid: number;
  startToken: string;
  observedAt: string;
  endedAt?: string | null;
};

export type ProcessProbe = 'alive' | 'gone' | 'reused' | 'unknown';

/** ps lstart and PGID together guard against PID reuse after daemon restart. */
export async function observeProcess(pid: number): Promise<{ pgid: number; startToken: string } | null> {
  if (!Number.isSafeInteger(pid) || pid < 2) return null;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='], { timeout: 1500, maxBuffer: 2048 });
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    return match && Number(match[1]) > 0 ? { pgid: Number(match[1]), startToken: match[2].trim() } : null;
  } catch {
    return null;
  }
}

export async function captureProcessRecord(
  jobId: string, taskId: string, executionId: string, leaseOwner: string, pid: number,
): Promise<ExecutionProcessRecord | null> {
  const snapshot = await observeProcess(pid);
  return snapshot && snapshot.pgid === pid ? {
    jobId, taskId, executionId, leaseOwner, host: hostname(), pid,
    pgid: snapshot.pgid, startToken: snapshot.startToken, observedAt: new Date().toISOString(),
  } : null;
}

export async function probeProcessRecord(record: ExecutionProcessRecord): Promise<ProcessProbe> {
  if (record.host !== hostname() || !record.startToken || record.pid !== record.pgid) return 'unknown';
  const current = await observeProcess(record.pid);
  if (current) return current.pgid === record.pgid && current.startToken === record.startToken ? 'alive' : 'reused';
  try {
    process.kill(record.pid, 0);
    return 'unknown';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'unknown';
  }
}

/** A separate still-running relay daemon must retain its live lease. */
export async function activeRelayLeaseOwner(owner: string): Promise<boolean> {
  const match = owner.match(/^relayd-(\d+)$/);
  if (!match || Number(match[1]) <= 1) return false;
  try {
    const { stdout } = await execFileAsync('ps', ['-p', match[1], '-o', 'command='], { timeout: 1500, maxBuffer: 4096 });
    return /(?:^|\/)agents-relayd(?:\s|$)/.test(stdout) || /\bagents-relayd\b/.test(stdout);
  } catch { return false; }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** Never signal another PID generation, remote host, or non-leader process group. */
export async function stopOrphanedProcessGroup(record: ExecutionProcessRecord, graceMs = 750): Promise<boolean> {
  let state = await probeProcessRecord(record);
  if (state === 'gone' || state === 'reused') return true;
  if (state !== 'alive' || process.platform === 'win32') return false;
  try { process.kill(-record.pgid, 'SIGTERM'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  await sleep(graceMs);
  state = await probeProcessRecord(record);
  if (state === 'gone' || state === 'reused') return true;
  if (state !== 'alive') return false;
  try { process.kill(-record.pgid, 'SIGKILL'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
  }
  await sleep(100);
  state = await probeProcessRecord(record);
  return state === 'gone' || state === 'reused';
}
