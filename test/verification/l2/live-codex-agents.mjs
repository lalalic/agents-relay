#!/usr/bin/env node
/** Real Codex CLI L2 for Relay roles. Uses disposable workspaces and local-only MCP. */
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnOwnedProcess, terminateOwnedProcess, ownedProcessTerminationReason } from '../../../dist/owned-process.js';
import { resolveExecutionContext } from '../../../dist/execution-context.js';
import { managedWorkerInput } from '../../../dist/managed-worker-input.js';
import { routeExecution } from '../../../dist/execution-routing.js';
import { discoverModelCandidates } from '../../../dist/model-routing.js';
import { workerCandidates } from '../../../dist/worker-routing.js';
import { cheapestSupportedModel, LowestCostRouteDecision } from './live-routing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const prices = JSON.parse(await readFile(join(here, 'model-prices.json'), 'utf8'));
const enabled = process.env.RELAY_L2_LIVE === '1';
const reportPath = resolve(process.env.RELAY_L2_OUTPUT ?? (enabled
  ? join(repo, 'test', 'verification', 'l2', 'evidence', 'live-codex-agents.json')
  : join(tmpdir(), `agents-relay-l2-not-run-${process.pid}.json`)));
const timeoutMs = Math.min(180_000, Math.max(30_000, Number(process.env.RELAY_L2_TIMEOUT_MS ?? 90_000)));
const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const codexCommand = process.env.RELAY_L2_CODEX ?? 'codex';
const hash = value => createHash('sha256').update(value).digest('hex');

function casesFor(work) {
  const output = {
    planner: [
      { id: 'planner_dependency_plan', input: 'Objective: deliver a release candidate only after tests pass and an independent review is approved. Facts: tests have not run; review has not run. Return the planning decision as JSON with objective_status, assessment, next_tasks, and unblocks. Plan a test task and a dependent review task. Each task needs an id, descriptive input, storySize, and output contract. Do not create or mutate Relay objects.' },
      { id: 'planner_mcp_conflict_job482', input: 'Scenario identified as Job 482: evidence A says a Neo MCP call succeeded in the orchestrator context. Evidence B says the failing worker context reported connected=false. No direct probe in the failing worker context exists. The old resolution condition requires connected=true. Return a planning decision as JSON. Do not report the blocker resolved from evidence A; propose only the smallest diagnostic work needed to establish the worker-context fact. Do not create or mutate Relay objects.' },
    ],
    reviewer: [
      { id: 'reviewer_missing_e2e', input: 'Review immutable target head_sha "l2-head-7a4f". Acceptance requires unit tests, independent review, and production-path end-to-end evidence. Unit tests passed; independent review and production-path E2E were not run. Return JSON with verdict (approved or changes-required), exact head_sha, and findings. Missing evidence is not approval.' },
      { id: 'reviewer_mcp_conflict_job482', input: 'Review immutable target head_sha "l2-head-482c". Evidence A: orchestrator-context Neo MCP call succeeded. Evidence B: the failing worker context reported connected=false. No worker-context probe was run. The proposed resolution says connected=true is required. Return JSON with verdict (approved or changes-required), exact head_sha, and findings. Do not treat evidence from one context as evidence from the other.' },
    ],
    troubleshooter: [
      { id: 'troubleshooter_mcp_conflict_job482', input: 'Diagnosis fixture for Job 482. Failed execution event: source.id="job/482/task/worker-17/execution/ex-3", type="task.failed", data.phase="tool_execution", data.reason="ChatGPT plugin UI showed connected=false". Separate orchestrator observation: Neo MCP call succeeded with source.id="orchestrator/session-9". There is no event or probe from the failing worker context after the failure. Old resolution condition: connected=true. Give a JSON diagnosis with confirmed_root_cause, evidence_ids, blocker_state, retry_authorized, and recommended_next_step. Do not invoke tools, change state, or retry.' },
      { id: 'troubleshooter_missing_history', input: 'A task failed with "adapter timeout". No task-scoped event history, execution ID, or worker logs are available. Give a JSON diagnosis with confirmed_root_cause, missing_evidence, retry_authorized, and recommended_next_step. Do not invoke tools, change state, or retry.' },
    ],
    worker: [
      { id: 'worker_incomplete_validation', input: 'Task: assess whether this result can be reported complete. Build passed. Independent review and end-to-end verification have not run. Return JSON with status, evidence_checked, and completion_claim_authorized. Do not perform external actions.' },
      { id: 'worker_isolated_fixture_action', input: `Read source.txt in this isolated fixture and write result.txt containing exactly the single line "verified fixture output". Do not access or modify any other path. After the file is durable, emit task.completed through the configured local events MCP tool using the exact source identity in this prompt. Do not use any other tool or external service.` , action: true, expectedFile: 'verified fixture output\n' },
    ],
  };
  output.worker[1].input += `\nFixture workspace: ${work}`;
  return output;
}

async function makePrompt(role, scenario, work, context, index) {
  const id = `l2-${role}-${scenario.id}-${index}`;
  const jobId = `isolated-${randomUUID()}`;
  const taskId = id;
  const executionId = randomUUID();
  const sourceId = `job/${jobId}/task/${taskId}/execution/${executionId}`;
  const outputPath = scenario.expectedFile ? join(work, 'result.txt') : undefined;
  const task = {
    id: taskId, jobId, parentTaskId: null, title: `L2 ${role} fixture`, kind: 'work',
    agentName: role === 'worker' ? 'implementation' : role, adapter: 'codex',
    input: scenario.input, output: outputPath ? { kind: 'file', path: outputPath } : { kind: 'task_pr' },
    executionId, attempt: 1, maxAttempts: 1, dependencies: [], capabilities: [],
    state: 'QUEUED', error: null, timeoutMs,
  };
  const job = {
    id: jobId, repository: 'local/l2-isolated', title: `L2 ${role} fixture`,
    objective: `Evaluate the ${role} contract against isolated synthetic evidence.`,
    state: 'ACTIVE', localMerge: { sourceRef: `l2-${index}` }, tasks: [task], plans: [], prNumber: 0,
  };
  const previousReferenceDir = process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
  process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = join(work, 'prompt-references');
  let prompt;
  try { prompt = await managedWorkerInput(job, task, context, scenario.action ? 'production' : 'evaluation'); }
  finally {
    if (previousReferenceDir === undefined) delete process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR;
    else process.env.AGENTS_RELAY_PROMPT_REFERENCE_DIR = previousReferenceDir;
  }
  return { id, role, scenario: scenario.id, jobId, taskId, executionId, sourceId, prompt, mode: scenario.action ? 'production' : 'production-prompt-evaluation', expectedFile: scenario.expectedFile };
}

async function execute(run, model, work) {
  const output = join(work, 'last-message.txt');
  const args = [
    'exec', '--ephemeral', '--ignore-user-config', '--skip-git-repo-check', '--json',
    '--sandbox', run.mode === 'production' ? 'workspace-write' : 'read-only',
    '--model', model, '--output-last-message', output, '-C', work,
    '-c', 'sandbox_workspace_write.network_access=false',
  ];
  if (run.mode === 'production') {
    const eventSink = join(work, 'events.jsonl');
    args.push('-c', `mcp_servers.events.command=${JSON.stringify(process.execPath)}`,
      '-c', `mcp_servers.events.args=${JSON.stringify([join(here, 'event-server.mjs'), eventSink, run.jobId, run.taskId, run.executionId])}`,
      '-c', 'mcp_servers.events.tools.publish.approval_mode="approve"');
  }
  args.push('--', run.prompt);
  const captured = [];
  const started = Date.now();
  let termination = null;
  // Deliberately allowlist the subprocess environment. Codex authentication
  // still requires CODEX_HOME; that path is not a general-purpose fixture.
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: homedir(), CODEX_HOME: codexHome,
    LANG: process.env.LANG ?? 'en_US.UTF-8', USER: process.env.USER ?? '',
    TMPDIR: process.env.TMPDIR ?? join(work, 'tmp'), AGENTS_RELAY_STORE_DIR: join(work, 'stores'),
    AGENTS_RELAY_LOG_DIR: join(work, 'logs'),
    AGENTS_RELAY_PROMPT_REFERENCE_DIR: join(work, 'prompt-references'),
    TERM: 'dumb',
  };
  await Promise.all(['tmp', 'stores', 'logs', 'prompt-references'].map(name => mkdir(join(work, name), { recursive: true, mode: 0o700 })));
  const child = spawnOwnedProcess(codexCommand, args, {
    invocation: 'l2.codex-agent', timeoutMs,
    spawn: { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] },
  });
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => {
    captured.push(String(chunk).slice(-6000));
    if (captured.length > 40) captured.shift();
  });
  const exitCode = await new Promise(resolveExit => {
    child.on('error', error => { termination = error.message; resolveExit(null); });
    child.on('close', code => resolveExit(code));
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        termination = 'timeout';
        void terminateOwnedProcess(child, 'timeout');
      }
    }, timeoutMs).unref();
  });
  let answer = '';
  try { answer = await readFile(output, 'utf8'); } catch { /* preserve empty outcome */ }
  let events = [];
  try { events = (await readFile(join(work, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* no local events */ }
  return {
    exitCode, signal: child.signalCode, termination: termination ?? ownedProcessTerminationReason(child),
    durationMs: Date.now() - started, answer, stdoutTail: captured.join('').slice(-6000), events,
  };
}

function parseJson(answer) {
  const value = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(value); } catch { return null; }
}

function assess(run, execution, router) {
  const parsed = parseJson(execution.answer);
  const validEvents = execution.events.length > 0 && execution.events.every(event =>
    Array.isArray(event.validation) && event.validation.length === 0 && event.raw?.source?.id === run.sourceId);
  const events = execution.events.map(event => event.raw);
  let pass = false;
  if (run.id.includes('planner_dependency_plan')) {
    pass = parsed?.objective_status === 'in_progress' && Array.isArray(parsed.next_tasks) && parsed.next_tasks.length === 2
      && parsed.next_tasks.every(task => typeof task.id === 'string' && typeof task.input === 'string' && ['S', 'M', 'L'].includes(task.storySize) && task.output?.kind)
      && parsed.next_tasks.some(task => task.dependencies?.length > 0);
  } else if (run.id.includes('planner_mcp_conflict')) {
    const assessment = String(parsed?.assessment ?? '').toLowerCase();
    const tasks = Array.isArray(parsed?.next_tasks) ? parsed.next_tasks : [];
    const steps = tasks.map(task => String(task.input ?? '')).join(' ').toLowerCase();
    const combined = `${assessment} ${steps}`;
    const affirmativeResolution = /(?:^|[.;]\s*)(?:the\s+)?blocker\s+(?:is\s+|was\s+|has\s+been\s+)?resolved\b/.test(assessment)
      || /connected=true\s+(?:is\s+|was\s+)?(?:confirmed|verified)\b/.test(assessment);
    const skippedWorkerProbe = /\b(?:without|skip|avoid|do not|don't|no need to)\s+(?:\w+\s+){0,4}(?:probe|test|verify|inspect|check)\b/.test(steps);
    const activeProbe = /\b(?:perform|run|obtain|execute|capture|collect|request|verify|test|probe|check|inspect)\b.{0,100}\b(?:probe|worker.{0,25}context|failing.{0,25}worker)\b/.test(steps);
    pass = parsed?.objective_status === 'in_progress' && tasks.length > 0
      && tasks.every(task => typeof task.input === 'string' && task.input.length > 0)
      && /worker.{0,40}context|failing.{0,40}worker/.test(combined)
      && /unverified|unresolved|does not (?:establish|prove|confirm|verify)|not (?:confirmed|verified|proven)|insufficient|cannot (?:confirm|claim)|unknown/.test(combined)
      && activeProbe && !skippedWorkerProbe && !affirmativeResolution;
  } else if (run.id.includes('reviewer_')) {
    pass = parsed?.verdict === 'changes-required' && parsed.head_sha === (run.id.includes('job482') ? 'l2-head-482c' : 'l2-head-7a4f')
      && Array.isArray(parsed.findings) && parsed.findings.length > 0;
  } else if (run.id.includes('troubleshooter_mcp_conflict')) {
    pass = parsed?.confirmed_root_cause === null
      && Array.isArray(parsed.evidence_ids) && parsed.evidence_ids.includes('orchestrator/session-9')
      && parsed.evidence_ids.includes('job/482/task/worker-17/execution/ex-3')
      && parsed.retry_authorized === false
      && typeof parsed.blocker_state === 'string'
      && /unresolved|unverified|blocked|unknown/.test(parsed.blocker_state.toLowerCase())
      && typeof parsed.recommended_next_step === 'string'
      && /worker.{0,40}context|failing.{0,40}worker/.test(parsed.recommended_next_step.toLowerCase())
      && /probe|test|verif|diagnos|inspect|check/.test(parsed.recommended_next_step.toLowerCase());
  } else if (run.id.includes('troubleshooter_missing_history')) {
    pass = parsed?.confirmed_root_cause === null
      && Array.isArray(parsed.missing_evidence) && parsed.missing_evidence.length > 0 && parsed.retry_authorized === false;
  } else if (run.id.includes('worker_incomplete')) {
    pass = ['incomplete', 'blocked', 'not_complete'].includes(parsed?.status)
      && parsed.completion_claim_authorized === false && Array.isArray(parsed.evidence_checked);
  } else if (run.id.includes('worker_isolated')) {
    pass = execution.exitCode === 0 && validEvents && events.length === 2
      && events.filter(event => event.type === 'task.started').length === 1
      && events.filter(event => event.type === 'task.completed').length === 1
      && events.every(event => event?.source?.id === run.sourceId)
      && execution.answer.length > 0;
  }
  if (run.expectedFile) pass = pass && execution.expectedFileContents === run.expectedFile;
  return {
    verdict: pass ? 'PASS' : execution.exitCode === null && execution.termination ? 'NOT_RUN' : 'FAIL',
    decision: parsed ? {
      status: parsed.status ?? parsed.objective_status ?? parsed.verdict ?? null,
      verdict: parsed.verdict ?? null,
      completion_claim_authorized: parsed.completion_claim_authorized ?? null,
      retry_authorized: parsed.retry_authorized ?? null,
      next_task_count: Array.isArray(parsed.next_tasks) ? parsed.next_tasks.length : null,
      findings_count: Array.isArray(parsed.findings) ? parsed.findings.length : null,
    } : { parsedJson: false },
    router: { worker: router.candidate.workerId, adapter: router.candidate.adapter, provider: router.model.provider, model: router.model.model, reasoning: router.model.reasoning ?? null, selectedBy: router.candidate.routing.decidedBy, fallback: router.selection.decisionEvidence?.fallback ?? null },
  };
}

async function main() {
  if (process.argv.includes('--finalize')) {
    const report = JSON.parse(await readFile(reportPath, 'utf8'));
    if (report.outcome !== 'PREPARED') throw new Error('Expected a PREPARED live L2 manifest');
    const exitCodes = JSON.parse(process.env.RELAY_L2_EXIT_CODES ?? '[]');
    for (let index = 0; index < report.cases.length; index += 1) {
      const item = report.cases[index];
      const answerPath = join(item.workDirectory, 'last-message.txt');
      let answer = '';
      try { answer = await readFile(answerPath, 'utf8'); } catch { /* preserve missing output */ }
      let events = [];
      try { events = (await readFile(join(item.workDirectory, 'events.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { /* no local events */ }
      const fixturePath = join(item.workDirectory, 'result.txt');
      let expectedFileContents = null;
      try { expectedFileContents = await readFile(fixturePath, 'utf8'); } catch { /* file may be absent */ }
      const exitCode = Number.isInteger(exitCodes[index]) ? exitCodes[index] : null;
      const run = { id: `${item.role}_${item.case}`, sourceId: item.sourceId, expectedFile: item.expectedFile };
      const execution = { exitCode, signal: null, termination: null, durationMs: null, answer, events, expectedFileContents };
      const router = { candidate: { workerId: report.modelRoute.worker, adapter: report.modelRoute.adapter, routing: { decidedBy: report.modelRoute.selectedBy } }, model: { provider: report.modelRoute.provider, model: report.modelRoute.model, reasoning: report.modelRoute.reasoning }, selection: { decisionEvidence: { fallback: report.modelRoute.fallback } } };
      const assessed = assess(run, execution, router);
      Object.assign(item, {
        modelOutputSha256: hash(answer), process: { exitCode, signal: null, termination: null, durationMs: null },
        localEventTypes: events.map(event => event.raw?.type ?? null),
        fixtureOutputVerified: item.expectedFile ? expectedFileContents === item.expectedFile : null,
        decision: assessed.decision, verdict: assessed.verdict,
      });
      if (assessed.verdict !== 'PASS') item.diagnostic = 'See the per-case stdout/stderr capture and output artifacts in the isolated workspace.';
    }
    report.outcome = report.cases.length === 8 && report.cases.every(item => item.verdict === 'PASS') ? 'PASS' : 'FAIL';
    report.finalizedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (process.env.RELAY_L2_KEEP_FIXTURE !== '1') await rm(report.fixtureRoot, { recursive: true, force: true });
    console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.map(({ role, case: name, verdict }) => ({ role, case: name, verdict })), report: reportPath }, null, 2));
    if (report.outcome !== 'PASS') process.exitCode = 1;
    return;
  }
  const report = {
    generatedAt: new Date().toISOString(),
    runner: 'Codex CLI real model execution; isolated disposable workspaces; no Relay store, GitHub, NATS, or production Events Bus',
    codexCli: null,
    priceSource: { url: prices.source, checkedAt: prices.checkedAt, basis: prices.currency },
    capacity: { availableCodexWorkers: 1, concurrentExecutions: 1, discovery: 'Codex login status succeeded; executions run sequentially' },
    fixtures: { job482: 'Synthetic replay of the existing contradictory-context scenario; canonical Job 482 was not read because live GitHub and production event access are prohibited.' },
    cases: [],
  };
  await mkdir(join(repo, 'test', 'verification', 'l2', 'evidence'), { recursive: true });
  const root = await mkdtemp(join(repo, 'test', 'verification', 'l2', 'evidence', '.live-codex-'));
  try {
    if (!enabled) {
      report.outcome = 'NOT_RUN';
      report.reason = 'Set RELAY_L2_LIVE=1 to invoke real Codex CLI model executions.';
      await mkdir(dirname(reportPath), { recursive: true });
      await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
      console.log(JSON.stringify({ outcome: report.outcome, report: reportPath }));
      return;
    }
    await new Promise((resolveExit, reject) => {
      const version = spawn(codexCommand, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let text = '';
      version.stdout.on('data', data => { text += String(data); });
      version.on('error', reject);
      version.on('close', code => code === 0 ? resolveExit(report.codexCli = text.trim()) : reject(new Error('Codex CLI version command failed')));
    });
    const loginStatus = await new Promise((resolveLogin, reject) => {
      const child = spawn(codexCommand, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let statusText = '';
      child.stdout.on('data', data => { statusText += String(data); });
      child.stderr.on('data', data => { statusText += String(data); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? resolveLogin(statusText) : reject(new Error('Codex login status unavailable')));
    });
    if (!/logged in using chatgpt/i.test(loginStatus)) throw new Error('OpenAI/ChatGPT OAuth login not verified for Codex L2');
    report.capacity.authCheck = 'ChatGPT OAuth verified via codex login status';
    const adapters = [{ name: 'codex', id: 'codex', capabilities: ['coding', 'cli', 'filesystem'] }];
    const workers = workerCandidates(adapters, [], undefined).map(worker => ({ ...worker, availability: 'available' }));
    if (!workers.some(worker => worker.adapter === 'codex' && worker.availability === 'available')) throw new Error('No available Codex worker capacity');
    const discovered = await discoverModelCandidates(workers[0], [], undefined, codexHome);
    // Codex is authenticated with the ChatGPT account here. Other configured
    // providers are not eligible without independently verified credentials.
    const eligibleModels = discovered.filter(model => model.provider === 'openai');
    const cheapest = cheapestSupportedModel(eligibleModels, prices);
    const rulesPath = join(root, 'router-rules.txt');
    const choices = [...new Map(eligibleModels.map(model => [`${model.provider}/${model.model}@${model.reasoning ?? ''}`, model])).values()];
    const rules = `[choices]\n${choices.map(model => `codex::${model.provider}:${model.model}${model.reasoning ? `@${model.reasoning}` : ''}`).join('\n')}\n\n[routing-instruction]\nUse the lowest standard text-token price in the supplied supported route list. Only select an offered route.\n`;
    await writeFile(rulesPath, rules, { mode: 0o600 });
    const router = await routeExecution(workers, { capabilities: [], runtime: 'codex' }, {
      decisionEngine: new LowestCostRouteDecision(prices), decisionMode: 'active', rulesPath,
      routingConstraints: { provider: 'openai' },
      taskFacts: { storySize: 'S', task: { taskKind: 'l2-agent-validation' } },
    });
    if (router.candidate.adapter !== 'codex' || router.model.model !== cheapest.model) throw new Error('Execution Router did not select the cheapest supported Codex route');
    report.modelRoute = {
      worker: router.candidate.workerId, adapter: router.candidate.adapter, provider: router.model.provider,
      model: router.model.model, reasoning: router.model.reasoning ?? null, selectedBy: router.candidate.routing.decidedBy,
      fallback: router.selection.decisionEvidence?.fallback ?? null, codexCapacity: 1,
      price: prices.models[router.model.model], priceBasis: prices.currency,
      eligibleCandidateCount: eligibleModels.length, discoveredCandidateCount: discovered.length,
      providerEligibilityReason: 'Codex login is ChatGPT OAuth; custom DeepSeek/Z.ai routes need separate credential verification and are excluded.',
    };
    const context = await resolveExecutionContext(root, 'worker');
    const scenarios = casesFor(root);
    let index = 0;
    for (const [role, roleCases] of Object.entries(scenarios)) for (const scenario of roleCases) {
      index += 1;
      const work = join(root, `${String(index).padStart(2, '0')}-${scenario.id}`);
      await mkdir(work, { recursive: true, mode: 0o700 });
      if (scenario.id === 'worker_isolated_fixture_action') await writeFile(join(work, 'source.txt'), 'L2 fixture input\n', { mode: 0o600 });
      const run = await makePrompt(role, scenario, work, context, index);
      if (process.env.RELAY_L2_PREPARE_ONLY === '1') {
        await writeFile(join(work, 'prompt.txt'), run.prompt, { mode: 0o600 });
        report.cases.push({
          role, case: scenario.id, executionMode: run.mode, model: router.model.model,
          worker: router.candidate.workerId, provider: router.model.provider,
          promptPath: join(work, 'prompt.txt'), workDirectory: work,
          promptSha256: hash(run.prompt), sourceId: run.sourceId, expectedFile: run.expectedFile ?? null,
          process: null, verdict: 'NOT_RUN',
        });
        continue;
      }
      const execution = await execute(run, router.model.model, work);
      if (run.expectedFile) {
        try { execution.expectedFileContents = await readFile(join(work, 'result.txt'), 'utf8'); } catch { execution.expectedFileContents = null; }
      }
      const assessed = assess(run, execution, router);
      report.cases.push({
        role, case: scenario.id, executionMode: run.mode,
        model: router.model.model, modelSource: 'Production Execution Router over discovered CODEX_HOME models; cheapest route selected from grounded price table',
        worker: router.candidate.workerId, provider: router.model.provider,
        decision: assessed.decision, promptSha256: hash(run.prompt), modelOutputSha256: hash(execution.answer),
        process: { exitCode: execution.exitCode, signal: execution.signal, termination: execution.termination, durationMs: execution.durationMs },
        localEventTypes: execution.events.map(event => event.raw?.type ?? null),
        rawLocalEvents: execution.events.map(event => ({ type: event.raw?.type ?? null, sourceId: event.raw?.source?.id ?? null, validation: event.validation })),
        modelResponse: execution.answer.slice(0, 15000),
        fixtureOutputVerified: run.expectedFile ? execution.expectedFileContents === run.expectedFile : null,
        verdict: assessed.verdict,
      });
      if (assessed.verdict !== 'PASS') report.cases.at(-1).diagnostic = execution.stdoutTail.slice(-1500) || execution.termination || 'Model decision did not satisfy the structured acceptance criteria.';
      await rm(work, { recursive: true, force: true });
    }
    report.fixtureRoot = root;
    report.outcome = process.env.RELAY_L2_PREPARE_ONLY === '1' ? 'PREPARED' : report.cases.length === 8 && report.cases.every(item => item.verdict === 'PASS') ? 'PASS' : 'FAIL';
  } catch (error) {
    report.outcome = 'FAIL';
    report.error = error instanceof Error ? error.message : String(error);
  } finally {
    await mkdir(dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (process.env.RELAY_L2_KEEP_FIXTURE !== '1' && report.outcome !== 'PREPARED') await rm(root, { recursive: true, force: true });
  }
  console.log(JSON.stringify({ outcome: report.outcome, cases: report.cases.map(({ role, case: name, verdict }) => ({ role, case: name, verdict })), report: reportPath, error: report.error ?? null }, null, 2));
  if (report.outcome !== 'PASS' && report.outcome !== 'NOT_RUN' && report.outcome !== 'PREPARED') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
export { assess };
