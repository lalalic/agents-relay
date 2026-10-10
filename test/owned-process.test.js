import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from './test-runtime.js';
import { ownedProcessSnapshot, spawnOwnedProcess, terminateOwnedProcess } from '../dist/owned-process.js';

const posix = process.platform !== 'win32';
const descendantScript = `
  const {spawn}=require('node:child_process');
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  process.stdout.write(String(child.pid)+'\\n');
  setInterval(()=>{},1000);
`;

function exists(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

async function waitFor(check, timeoutMs = 3000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail('condition did not become true before timeout');
}

async function descendantPid(child) {
  let output = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', chunk => { output += chunk; });
  await waitFor(() => /^\d+/m.test(output));
  return Number(output.match(/^\d+/m)[0]);
}

test('owned process cancellation terminates a nested disposable child tree', { skip: !posix }, async () => {
  const child = spawnOwnedProcess(process.execPath, ['-e', descendantScript], {
    invocation: 'test.cancel',
    graceMs: 75,
    spawn: { stdio: ['ignore', 'pipe', 'ignore'] },
  });
  const nestedPid = await descendantPid(child);
  await terminateOwnedProcess(child, 'cancel', 75);
  await waitFor(() => !exists(nestedPid));
  await waitFor(() => !ownedProcessSnapshot().some(item => item.pid === child.pid));
});

test('owned process timeout kills descendants without touching a competing group', { skip: !posix }, async () => {
  const survivor = spawnOwnedProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { invocation: 'test.competitor', graceMs: 75, spawn: { stdio: 'ignore' } });
  const timed = spawnOwnedProcess(process.execPath, ['-e', descendantScript], {
    invocation: 'test.timeout',
    // Allow a loaded full-suite runner enough time to start Node and publish the nested PID.
    timeoutMs: 500,
    graceMs: 75,
    spawn: { stdio: ['ignore', 'pipe', 'ignore'] },
  });
  const nestedPid = await descendantPid(timed);
  await waitFor(() => !exists(nestedPid));
  assert.equal(exists(survivor.pid), true);
  await terminateOwnedProcess(survivor, 'cancel', 75);
});

test('direct leader completion cleans npm or shell-like descendants holding inherited pipes', { skip: !posix }, async () => {
  const wrapper = `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',process.stdout,'ignore']});child.unref();
    process.stdout.write(String(child.pid)+'\\n');
  `;
  const child = spawnOwnedProcess(process.execPath, ['-e', wrapper], { invocation: 'test.wrapper', graceMs: 75, spawn: { stdio: ['ignore', 'pipe', 'ignore'] } });
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const nestedPid = await descendantPid(child);
  await closed;
  await waitFor(() => !exists(nestedPid));
});

test('parent SIGKILL supervisor terminates its exact owned process group', { skip: !posix }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-owned-parent-'));
  const marker = join(root, 'nested.pid');
  const moduleUrl = new URL('../dist/owned-process.js', import.meta.url).href;
  const parentScript = `
    import {writeFileSync} from 'node:fs';
    import {spawnOwnedProcess} from ${JSON.stringify(moduleUrl)};
    const code=${JSON.stringify(`const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);`)};
    spawnOwnedProcess(process.execPath,['-e',code],{invocation:'test.parent-crash',graceMs:75,spawn:{stdio:'ignore'}});
    setInterval(()=>{},1000);
  `;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', parentScript], { stdio: 'ignore' });
  try {
    await waitFor(async () => { try { return /^\d+$/.test((await readFile(marker, 'utf8')).trim()); } catch { return false; } });
    const nestedPid = Number((await readFile(marker, 'utf8')).trim());
    process.kill(parent.pid, 'SIGKILL');
    await waitFor(() => !exists(nestedPid), 5000);
  } finally {
    if (exists(parent.pid)) process.kill(parent.pid, 'SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
});

test('leader close does not strand unref descendants without inherited pipes', { skip: !posix }, async () => {
  const wrapper = `
    const {spawn}=require('node:child_process');
    const c=spawn(process.execPath,['-e',${JSON.stringify("process.on('SIGTERM',()=>{});setInterval(()=>{},1000)")}],{stdio:'ignore'});
    c.unref();process.stdout.write(String(c.pid)+'\\n');
  `;
  const child = spawnOwnedProcess(process.execPath, ['-e', wrapper], {
    invocation: 'test.unref-leader-close', graceMs: 100,
    spawn: { stdio: ['ignore','pipe','ignore'] },
  });
  const closed = new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  const pid = await descendantPid(child);
  try {
    await closed;
    await waitFor(() => !exists(pid), 3500);
    await waitFor(() => !ownedProcessSnapshot().some(item => item.pid === child.pid));
  } finally {
    if (exists(pid)) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  }
});
