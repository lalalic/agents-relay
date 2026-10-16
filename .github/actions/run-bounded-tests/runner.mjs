#!/usr/bin/env node
import { spawn } from 'node:child_process';

// A CI step timeout does not guarantee that grandchildren release their handles.
// Launch the test command in its own process group and reclaim the whole group.
const timeoutMs = Number(process.env.RELAY_TEST_TIMEOUT_MS || 480_000);
const graceMs = Number(process.env.RELAY_TEST_KILL_GRACE_MS || 5_000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(graceMs) || graceMs < 1) {
  console.error('Invalid bounded test timeout configuration');
  process.exit(2);
}
const command = process.argv.slice(2);
if (!command.length) {
  console.error('Usage: node scripts/run-bounded-tests.mjs COMMAND [ARG ...]');
  process.exit(2);
}
const child = spawn(command[0], command.slice(1), { stdio: 'inherit', detached: true, env: process.env });
let timedOut = false;
let stopping = false;
let forceTimer;
const signalGroup = signal => {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') console.error(`Cannot send ${signal} to test group:`, error); }
};
const stop = reason => {
  if (stopping) return;
  stopping = true;
  console.error(`::error::${reason}; terminating test process group ${child.pid ?? 'unknown'}`);
  signalGroup('SIGTERM');
  forceTimer = setTimeout(() => signalGroup('SIGKILL'), graceMs);
  forceTimer.unref();
};
const deadline = setTimeout(() => { timedOut = true; stop(`Tests did not exit within ${timeoutMs}ms`); }, timeoutMs);
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => { stop(`Bounded test runner received ${signal}`); });
}
child.once('error', error => {
  clearTimeout(deadline);
  console.error('::error::Unable to launch test process:', error);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  clearTimeout(deadline);
  // A test command can exit while an inherited child is still alive; reclaim the group.
  signalGroup('SIGKILL');
  if (forceTimer) clearTimeout(forceTimer);
  if (timedOut) console.error('::error::Test suite timed out; marking CI failure');
  else if (signal) console.error(`::error::Test process terminated by ${signal}`);
  process.exitCode = timedOut || stopping || signal ? 124 : code ?? 1;
});
