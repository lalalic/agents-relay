import { spawn } from 'node:child_process';

const live = process.env.AGENTS_RELAY_RUN_CHATGPT_TEMP_QUALITY === '1';
const timeoutMs = live ? 75_000 : 15_000;
const child = spawn(process.execPath, ['--test', 'test/quality/temporary-chat.test.js'], {
  stdio: 'inherit',
  env: process.env,
  detached: process.platform !== 'win32',
});

let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (process.platform === 'win32') child.kill('SIGKILL');
  else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
}, timeoutMs);

child.on('exit', (code, signal) => {
  clearTimeout(timer);
  if (timedOut) {
    console.error(`Temporary Chat quality suite exceeded ${timeoutMs}ms and was killed`);
    process.exitCode = 124;
    return;
  }
  if (signal) {
    console.error(`Temporary Chat quality suite exited from signal ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
