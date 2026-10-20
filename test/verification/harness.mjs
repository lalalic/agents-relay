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
  if (typeof scenario.expectedTerminal !== 'string') throw new Error('invalid expectedTerminal');
  if (scenario.effects !== undefined && (!Array.isArray(scenario.effects) || !scenario.effects.every(x => typeof x === 'string' || (x && typeof x === 'object' && typeof x.name === 'string')))) throw new Error('invalid effects');
  if (scenario.assertions !== undefined && (!Array.isArray(scenario.assertions) || !scenario.assertions.every(x => typeof x === 'string' || (x && typeof x === 'object' && typeof x.name === 'string')))) throw new Error('invalid assertions');
  return Object.freeze({ ...scenario, expectedTrace: Object.freeze([...scenario.expectedTrace]), effects: Object.freeze([...(scenario.effects ?? [])]), assertions: Object.freeze([...(scenario.assertions ?? [])]) });
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

export function classifyTrace(scenario, trace, { terminal = null, maxSteps = 100, fingerprint } = {}) {
  validateScenario(scenario);
  if (trace.length > maxSteps) return { outcome: 'FAIL', failureEdge: 'STEP_LIMIT', reason: 'maximum event steps exceeded' };
  const seen = new Set();
  const stableFingerprint = fingerprint ?? (step => {
    if (!step || typeof step !== 'object') return JSON.stringify(step);
    const { timestamp: _timestamp, time: _time, ...stable } = step;
    return JSON.stringify(stable);
  });
  for (const step of trace) {
    if (step?.progress === false) {
      const key = stableFingerprint(step);
      if (seen.has(key)) return { outcome: 'FAIL', failureEdge: 'NO_PROGRESS_LOOP', reason: 'repeated no-progress state' };
      seen.add(key);
    }
  }
  const observedTerminal = [...trace].reverse().find(step => step && typeof step === 'object' && typeof step.terminal === 'string')?.terminal ?? null;
  if (observedTerminal === null) return { outcome: 'FAIL', failureEdge: 'DEADLOCK', reason: 'no observed terminal outcome in production trace' };
  const actual = trace.map(step => typeof step === 'string' ? step : step.event).filter(Boolean);
  let cursor = 0;
  for (const required of scenario.expectedTrace) {
    const offset = actual.indexOf(required, cursor);
    if (offset < 0) return { outcome: 'FAIL', failureEdge: required, reason: 'required causal event missing or out of order' };
    cursor = offset + 1;
  }
  if (observedTerminal !== scenario.expectedTerminal) return { outcome: 'FAIL', failureEdge: 'TERMINAL_MISMATCH', reason: 'unexpected observed terminal outcome' };
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
