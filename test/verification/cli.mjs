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
} else if (command === 'trace-check') {
  const file = process.argv[3];
  if (!file) throw new Error('trace-check requires trace JSON path');
  const { readFileSync } = await import('node:fs');
  const fixture = JSON.parse(readFileSync(resolve(file),'utf8'));
  const scenario = scenarios.find(x=>x.id===fixture.scenarioId);
  if (!scenario) throw new Error('scenario not found');
  const result = classifyTrace(scenario, fixture.trace, { terminal: fixture.terminal });
  const report = newEvidence(scenario,{...result,trace:fixture.trace,actualTerminal:fixture.terminal});
  console.log(JSON.stringify(report,null,2));
  if (result.outcome !== 'PASS') process.exitCode = 1;
} else if (command === 'l2-live') {
  const {readFileSync}=await import('node:fs');
  const {runLiveMatrix}=await import('./live-compliance.mjs');
  const path=process.argv[3];
  if(!path) throw new Error('l2-live needs provider matrix JSON path');
  const results=await runLiveMatrix(JSON.parse(readFileSync(resolve(path),'utf8')));
  console.log(JSON.stringify(results,null,2));
  if(results.some(x=>x.outcome==='FAIL')) process.exitCode=1;
} else if (command === 'replay') {
  const file=process.argv[3];
  if (!file) throw new Error('replay requires canonical external-events JSON path');
  const {readFileSync}=await import('node:fs');
  const {replayIngress}=await import('./real-ingress-replay.mjs');
  const result=await replayIngress(JSON.parse(readFileSync(resolve(file),'utf8')));
  console.log(JSON.stringify(result,null,2));
  if (result.outcome!=='PASS') process.exitCode=1;
} else {
  throw new Error('Unknown command: '+command);
}
