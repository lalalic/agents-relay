#!/usr/bin/env node
// Configured Codex provider adapter. Prompt bytes come from Relay's shared
// prompt Action through the matching read-only CLI; this file never assembles
// a second Worker prompt. The owning Rust Worker supervises this process group.
import { spawn } from 'node:child_process';
import { open, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;
const fail = message => { process.stderr.write(`${message}\n`); process.exitCode = 1; };

async function boundedJson(path) {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Task request exceeds 1 MiB');
    return JSON.parse(await file.readFile('utf8'));
  } finally { await file.close(); }
}

function collect(command, args, options, input = '', captureStdout = true) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, shell: false, stdio: ['pipe', captureStdout ? 'pipe' : 'ignore', 'pipe'] });
    const stdout = [];
    let size = 0;
    let stderr = '';
    if (captureStdout) child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BYTES) child.kill('SIGKILL');
      else stdout.push(chunk);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16384); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `child exited ${code}`));
      else if (size > MAX_BYTES) reject(new Error('child output exceeds 1 MiB'));
      else resolvePromise(Buffer.concat(stdout));
    });
    child.stdin.end(input);
  });
}

async function main() {
  const requestPath = process.env.RELAY_TASK_REQUEST_PATH;
  const resultPath = process.env.RELAY_RESULT_PATH;
  if (!requestPath || !resultPath) throw new Error('Relay request/result paths are required');
  const request = await boundedJson(requestPath);
  const promptAction = request.promptAction;
  const route = request.routing;
  const selection = request.workerSelection;
  if (request.adapter !== 'codex' || typeof request.jobId !== 'string' || typeof request.taskId !== 'string'
      || typeof request.executionId !== 'string' || typeof request.leaseOwner !== 'string'
      || !Number.isInteger(request.attempt) || !request.executionContext
      || !promptAction || typeof promptAction.cli !== 'string' || typeof promptAction.jobFile !== 'string'
      || typeof promptAction.nodeExecutable !== 'string' || typeof promptAction.modelRoutingModule !== 'string'
      || !route || typeof route.provider !== 'string'
      || typeof route.model !== 'string' || !route.model.trim()
      || !selection || selection.adapter !== 'codex' || typeof selection.workerId !== 'string') {
    throw new Error('Invalid execution-bound Codex request or shared prompt Action reference');
  }
  const executable = process.env.CODEX_EXECUTABLE;
  if (!executable || !isAbsolute(executable)) throw new Error('Absolute CODEX_EXECUTABLE is required');
  const { discoverModelCandidates } = await import(pathToFileURL(promptAction.modelRoutingModule).href);
  const candidates = await discoverModelCandidates({
    workerId: selection.workerId, adapter: 'codex', capabilities: selection.capabilities ?? [],
  }, []);
  if (!candidates.some(candidate => candidate.provider === route.provider && candidate.model === route.model
      && (route.profile === undefined || candidate.profile === route.profile)
      && (route.reasoning === undefined || candidate.reasoning === route.reasoning))) {
    throw new Error('Durable Model route is no longer supported by maintained Codex capabilities');
  }
  const prompt = await collect(promptAction.nodeExecutable, [promptAction.cli, 'prompt', '--id', request.jobId,
    '--task-id', request.taskId, '--adapter', 'codex', '--file', promptAction.jobFile], {
    cwd: request.executionContext.projectPath,
    env: { PATH: process.env.PATH || '/usr/bin:/bin' },
  });
  if (!prompt.length) throw new Error('Relay shared prompt Action returned an empty prompt');
  const answerPath = resolve(dirname(resultPath), 'codex-answer.txt');
  const args = ['exec', '--json', '--ephemeral', '--sandbox', 'read-only'];
  if (typeof route.profile === 'string' && route.profile.trim()) args.push('--profile', route.profile);
  args.push('--model', route.model);
  if (typeof route.reasoning === 'string' && route.reasoning.trim()) args.push('--config', `model_reasoning_effort=${route.reasoning}`);
  args.push('--cd', request.executionContext.projectPath, '--output-last-message', answerPath, '-');
  await collect(executable, args, { cwd: request.executionContext.projectPath, env: process.env }, prompt, false);
  const answer = (await readFile(answerPath, 'utf8')).trim();
  if (!answer || Buffer.byteLength(answer, 'utf8') > MAX_BYTES) throw new Error('Codex returned no bounded final response');
  const receipt = {
    type: 'task.completed', jobId: request.jobId, taskId: request.taskId,
    executionId: request.executionId, leaseOwner: request.leaseOwner, attempt: request.attempt,
    adapter: 'codex', routing: route, workerSelection: selection, status: 'COMPLETED',
    summary: answer.slice(0, 2048), output: { text: answer },
  };
  await writeFile(resultPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
