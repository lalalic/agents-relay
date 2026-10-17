import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'NOT_RUN', 'UNSUPPORTED']);
export const CATEGORIES = Object.freeze(['L1', 'L2', 'L3']);

export function validateScenario(scenario) {
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) throw new Error('scenario must be an object');
  if (!/^[a-z][a-z0-9-]+$/.test(scenario.id ?? '')) throw new Error('invalid scenario id');
  if (!CATEGORIES.includes(scenario.category)) throw new Error('invalid scenario category');
  if (!Array.isArray(scenario.expectedTrace) || !scenario.expectedTrace.every(x => typeof x === 'string')) throw new Error('invalid expectedTrace');
  if (scenario.externalOutcomes !== undefined && (!Array.isArray(scenario.externalOutcomes) || !scenario.externalOutcomes.every(x => x && typeof x === 'object' && typeof x.event === 'string'))) throw new Error('invalid externalOutcomes');
  if (scenario.expectedTransitions !== undefined && (!Array.isArray(scenario.expectedTransitions) || !scenario.expectedTransitions.every(x => typeof x === 'string'))) throw new Error('invalid expectedTransitions');
  if (scenario.faults !== undefined && !Array.isArray(scenario.faults)) throw new Error('invalid faults');
  for (const key of ['effects', 'assertions']) if (scenario[key] !== undefined && (!Array.isArray(scenario[key]) || !scenario[key].every(x => typeof x === 'string'))) throw new Error(`invalid ${key}`);
  if (typeof scenario.expectedTerminal !== 'string') throw new Error('invalid expectedTerminal');
  return Object.freeze({ ...scenario, expectedTrace: Object.freeze([...scenario.expectedTrace]) });
}

export function loadScenarios(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error('scenario corpus must be an array');
  const scenarios = parsed.map(validateScenario);
  const ids = new Set(scenarios.map(x => x.id));
  if (ids.size !== scenarios.length) throw new Error('duplicate scenario id');
  return scenarios;
}

export function newEvidence(scenario, details = {}) {
  validateScenario(scenario);
  const outcome = details.outcome ?? 'NOT_RUN';
  if (!OUTCOMES.includes(outcome)) throw new Error('invalid outcome');
  const trace = details.trace ?? [];
  if (!Array.isArray(trace)) throw new Error('trace must be an array');
  return {
    schemaVersion: 1, scenarioId: scenario.id, category: scenario.category,
    role: details.role ?? scenario.role ?? null,
    provider: details.provider ?? null, outcome,
    expectedTerminal: scenario.expectedTerminal,
    actualTerminal: details.actualTerminal ?? null,
    trace, failureEdge: details.failureEdge ?? null,
    reason: details.reason ?? null,
  };
}

export function classifyTrace(scenario, trace, { terminal = null, maxSteps = 100, fingerprint = step => JSON.stringify({event:step.event, state:step.state, pending:step.pending, effect:step.effect}) } = {}) {
  validateScenario(scenario);
  if (trace.length > maxSteps) return { outcome: 'FAIL', failureEdge: 'STEP_LIMIT', reason: 'maximum event steps exceeded' };
  const seen = new Set();
  for (const step of trace) {
    if (step?.progress === false) {
      const key = fingerprint(step);
      if (seen.has(key)) return { outcome: 'FAIL', failureEdge: 'NO_PROGRESS_LOOP', reason: 'repeated no-progress state' };
      seen.add(key);
    }
  }
  // Trace validation is NOT proof of Relay execution. Only an authenticated runtime
  // runner may mark a workflow PASS after reading the isolated durable store.
  if (terminal === null) return { outcome: 'FAIL', failureEdge: 'DEADLOCK', reason: 'no next effect or terminal outcome' };
  const actual = trace.map(step => typeof step === 'string' ? step : step.event).filter(Boolean);
  let cursor = 0;
  for (const required of scenario.expectedTrace) {
    const offset = actual.indexOf(required, cursor);
    if (offset < 0) return { outcome: 'FAIL', failureEdge: required, reason: 'required causal event missing or out of order' };
    cursor = offset + 1;
  }
  if (terminal !== scenario.expectedTerminal) return { outcome: 'FAIL', failureEdge: 'TERMINAL_MISMATCH', reason: 'unexpected terminal outcome' };
  return { outcome: 'PASS', failureEdge: null, reason: null };
}

export function createIsolatedEnvironment(prefix = 'relay-verification-') {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const storeDir = join(root, 'stores');
  const logDir = join(root, 'logs');
  mkdirSync(storeDir);
  mkdirSync(logDir);
  const env = { ...process.env, AGENTS_RELAY_STORE_DIR: storeDir, AGENTS_RELAY_LOG_DIR: logDir };
  return { root, storeDir, logDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function writeReport(report, dir) {
  mkdirSync(dir, { recursive: true });
  const sorted = [...report].sort((a, b) => a.scenarioId.localeCompare(b.scenarioId));
  const json = JSON.stringify({ schemaVersion: 1, results: sorted }, null, 2) + '\n';
  const lines = ['# Relay Verification', '', '| Scenario | Layer | Outcome | Failure edge |', '| --- | --- | --- | --- |'];
  for (const result of sorted) lines.push(`| ${result.scenarioId} | ${result.category} | ${result.outcome} | ${result.failureEdge ?? '-'} |`);
  writeFileSync(join(dir, 'report.json'), json);
  writeFileSync(join(dir, 'report.md'), lines.join('\n') + '\n');
  return { json: resolve(dir, 'report.json'), markdown: resolve(dir, 'report.md'), digest: createHash('sha256').update(json).digest('hex') };
}

/** Verify an observed scenario against a trusted read from the runner's isolated store. */
export async function classifyObservedTrace(scenario, trace, { loadDurableState, ...options } = {}) {
  if (typeof loadDurableState !== 'function') throw new Error('durable state reader required');
  const snapshot = await loadDurableState();
  if (!snapshot || typeof snapshot.state !== 'string') throw new Error('invalid durable state');
  return classifyTrace(scenario, trace, { ...options, terminal: snapshot.state });
}
