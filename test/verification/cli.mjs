#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { loadScenarios, newEvidence, writeReport, classifyTrace } from './harness.mjs';
const corpus = join(dirname(fileURLToPath(import.meta.url)), 'scenarios.json');
const command = process.argv[2] ?? 'list';
const scenarios = loadScenarios(corpus);
if (command === 'list') {
  for (const item of scenarios) console.log([item.id, item.category, item.role ?? '-', item.expectedTerminal].join('\t'));
} else if (command === 'foundation') {
  const results = scenarios.map(scenario => newEvidence(scenario, {reason:'Layer-specific runner not executed'}));
  const dir = resolve(process.argv[3] ?? join(process.cwd(), '.verification-reports'));
  const report = writeReport(results, dir);
  console.log(JSON.stringify({scenarios:results.length, results:results.map(({scenarioId,outcome})=>({scenarioId,outcome})),report},null,2));
} else if (command === 'replay') {
  const file = process.argv[3];
  if (!file) throw new Error('replay requires trace JSON path');
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(resolve(file),'utf8'));
  const scenario = scenarios.find(x=>x.id===fixture.scenarioId);
  if (!scenario) throw new Error('scenario not found');
  const result = classifyTrace(scenario, fixture.trace);
  const actualTerminal = [...fixture.trace].reverse().find(step => step && typeof step === 'object' && typeof step.terminal === 'string')?.terminal ?? null;
  const report = newEvidence(scenario,{...result,trace:fixture.trace,actualTerminal});
  console.log(JSON.stringify(report,null,2));
  if (result.outcome !== 'PASS') process.exitCode = 1;
} else {
  throw new Error('Unknown command: '+command);
}
