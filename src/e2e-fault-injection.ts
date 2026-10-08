// Deliberate, scoped E2E faults; disabled unless explicit environment opt-in.
import { mkdirSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import type { Task } from './types.js';
import type { Execution } from './adapters.js';

export function injectedE2EExecution(task: Task): Execution | null {
  const expected = process.env.AGENTS_RELAY_E2E_FAULT_JOB;
  if (!expected || expected !== task.jobId || !process.env.AGENTS_RELAY_E2E_FAULT_DIR) return null;
  const role = task.agentName === 'reviewer' ? 'reviewer' : task.agentName === 'implementation' ? 'implementation' : null;
  if (!role || task.attempt !== 1 || !task.executionId) return null;
  const dir = process.env.AGENTS_RELAY_E2E_FAULT_DIR;
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${role}.consumed`);
  let fd: number;
  try { fd = openSync(file, 'wx', 0o600); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
  try { writeFileSync(fd, JSON.stringify({jobId: task.jobId, taskId: task.id, executionId: task.executionId, role, at: new Date().toISOString()})); }
  finally { closeSync(fd); }
  // Spawn an actual isolated test child; its nonzero process exit is observed
  // by Relay's ordinary execution settlement path. Never kill shared workers.
  const exitCode = role === 'reviewer' ? 42 : 137;
  const message = role === 'reviewer' ? 'E2E injected reviewer exit code 42' : 'E2E injected worker exit without terminal event';
  const child = spawn(process.execPath, ['-e', `process.stderr.write(${JSON.stringify(message)}); process.exit(${exitCode})`], {stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr += chunk.toString(); });
  let execution: Execution;
  const promise = new Promise<never>((_resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {
      execution.processExit = {exitCode: code, signal, stderr, terminationReason: 'e2e-fault-injection'};
      reject(new Error(stderr || `E2E test child exited ${code}`));
    });
  });
  execution = { id: task.executionId, launched: Promise.resolve(), promise, pid: child.pid, cancel: () => {child.kill('SIGTERM');} };
  return execution;
}
