// Run full-path scenarios against isolated SQLite, preserving both passing and negative evidence.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { runFullPath } from './l3-simulator.mjs';

const output = resolve(process.argv[2] ?? '/tmp/relay-l3-evidence');
mkdirSync(output, { recursive: true });
const scenarios = [
  { id: 'normal-completion', expected: { jobState: 'COMPLETED', mergeStatus: 'succeeded' } },
  { id: 'revision-rereview', reviewVerdicts: { '*': ['changes-required', 'approved'] }, steps: [{ type: 'advance-head', headSha: 'head-2' }], expected: { jobState: 'COMPLETED', mergeStatus: 'succeeded' } },
  { id: 'parallel-restart', reviewEnabled: false, tasks: [{ id: 'a' }, { id: 'b', dependencies: ['a'] }, { id: 'c', dependencies: ['a'] }], steps: [{ type: 'restart' }], expected: { jobState: 'COMPLETED', mergeStatus: 'succeeded' } },
  { id: 'merge-failure-receipt', persistMergeFailure: true, mergeFailureReason: 'dirty_target_worktree', expected: { jobState: 'ACTIVE', mergeStatus: 'failed' } },
  { id: 'worker-fault', reviewEnabled: false, workerOutcomes: { a: ['failed'] }, expected: { jobState: 'ACTIVE', tasks: { a: 'FAILED', b: 'DRAFT' } } },
  { id: 'reviewer-fault', reviewVerdicts: { '*': ['failed'] }, expected: { jobState: 'ACTIVE', tasks: { 'final-review-head-1': 'FAILED' } } },
  { id: 'deliberately-broken', reviewEnabled: false, expected: { jobState: 'ACTIVE' }, expectedOutcome: 'FAIL' },
];
const results = [];
for (const scenario of scenarios) {
  const result = await runFullPath({ ...scenario, outputDir: join(output, scenario.id) });
  results.push({ scenarioId: scenario.id, expectedOutcome: scenario.expectedOutcome ?? 'PASS', outcome: result.outcome, errors: result.errors, actual: result.actual, artifact: `${scenario.id}/report.json` });
}
const unexpected = results.filter(result => result.outcome !== result.expectedOutcome);
const report = { schemaVersion: 1, authority: 'isolated SQLite', results, unexpectedFailures: unexpected.length, unsupported: ['human escalation/unblock full sequence', 'verified troubleshooter recovery of original task', 'reviewer-completed-but-stalled production regression', 'autonomous planner multi-batch production regression', 'production merge retry timing', 'L2 live provider compliance'] };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
writeFileSync(join(output, 'report.md'), ['# L3 production-path evidence', '', '| Scenario | Expected | Observed | SQLite job state |', '| --- | --- | --- | --- |', ...results.map(r => `| ${r.scenarioId} | ${r.expectedOutcome} | ${r.outcome} | ${r.actual.jobState} |`), '', '## Unsupported (not PASS)', ...report.unsupported.map(x => `- ${x}`), '', `Unexpected outcomes: ${unexpected.length}`].join('\n') + '\n');
console.log(JSON.stringify({ output, unexpectedFailures: unexpected.length, results: results.map(({scenarioId,outcome}) => ({scenarioId,outcome})) }, null, 2));
if (unexpected.length) process.exitCode = 1;
