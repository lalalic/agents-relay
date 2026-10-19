import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseExecutableMermaid, WorkflowEngine } from '../dist/workflow/mermaid.js';
import { parseGraphV2 } from '../dist/workflow/graph-v2.js';
import { jobLifecycleV2, taskLifecycleV2 } from '../dist/workflow/definitions-v2.js';
import { plannerTriggerV2 } from '../dist/workflow/planner-trigger-v2.js';
import { plannerOrchestrationV2 } from '../dist/workflow/planner-orchestration-v2.js';
import { blockerResolutionV2 } from '../dist/workflow/blocker-resolution-v2.js';
import { authoritativeUnblockV2 } from '../dist/workflow/authoritative-unblock-v2.js';
import { scheduledRunV2 } from '../dist/workflow/scheduled-run-v2.js';
import { scheduleCycleV2 } from '../dist/workflow/schedule-cycle-v2.js';
import { troubleshooterV2 } from '../dist/workflow/troubleshooter-v2.js';
import { escalationGraph } from '../dist/workflow/escalation.js';
import { reviewLifecycleV2 } from '../dist/workflow/review-v2.js';
import { taskRelatedActionV2 } from '../dist/workflow/task-related-action-v2.js';
import { taskResolutionV2 } from '../dist/workflow/task-resolution.js';
import { projectionConflictV2 } from '../dist/workflow/projection-conflict-v2.js';
import { orchestratorRescueV2 } from '../dist/workflow/orchestrator-rescue.js';
import { interactiveInvocationGraph } from '../dist/interactive-invocation.js';
import { assertJobLifecycleTransition, assertTaskTransition } from '../dist/types.js';

test('minimal profile supports named guard and action references', async () => {
  const graph=parseExecutableMermaid(`stateDiagram-v2\n[*] --> A\nA --> B: go [allowed] / audit\nB --> [*]\n`);
  const calls=[];
  const engine=new WorkflowEngine(graph,{allowed:ctx=>ctx.ok===true},{audit:(_ctx,t)=>calls.push(`${t.from}->${t.to}`)});
  assert.equal((await engine.enabled('A','go',{ok:false})).length,0);
  assert.equal(await engine.transition('A','go',{ok:true}),'B');
  assert.deepEqual(calls,['A->B']);
});

test('minimal executable Mermaid profile fails fast on unsupported syntax', () => {
  assert.throws(() => parseExecutableMermaid('stateDiagram-v2\nstate A\n[*] --> A'), /Unsupported executable Mermaid syntax/);
  assert.throws(() => parseExecutableMermaid('flowchart TD\nA-->B'), /stateDiagram-v2/);
  assert.throws(() => parseExecutableMermaid('stateDiagram-v2\n[*] --> A\nA --> B'), /requires an event label/);
});

test('engine validates named guard/action bindings when registry is bound', () => {
  const guarded=parseExecutableMermaid(`stateDiagram-v2\n[*] --> A\nA --> B: go [allowed] / audit\nB --> [*]\n`);
  assert.throws(() => new WorkflowEngine(guarded), /Unknown workflow guard allowed referenced at line 3/);
  assert.throws(() => new WorkflowEngine(guarded,{allowed:()=>true}), /Unknown workflow action audit referenced at line 3/);
  assert.doesNotThrow(() => new WorkflowEngine(guarded,{allowed:()=>true},{audit:()=>{}}));
});

test('profile rejects duplicate source/event/guard branches as ambiguous', () => {
  assert.throws(() => parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: go
A --> C: go
`), /Ambiguous executable transition/);
  assert.doesNotThrow(() => parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: go [left]
A --> C: go [right]
`));
});

test('engine exposes graph introspection without duplicating workflow policy', () => {
  const graph=parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: go
A --> C: stop
`);
  const engine=new WorkflowEngine(graph);
  assert.deepEqual(engine.transitionsFrom('A').map(t=>[t.event,t.to]),[['go','B'],['stop','C']]);
  assert.throws(() => engine.transitionsFrom('MISSING'), /Unknown workflow state MISSING/);
});


test('every repository lifecycle graph file parses and validates with the production contract', async () => {
  const directory = new URL('../workflow/', import.meta.url);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.mmd') && entry.name !== 'main.mmd')
    .map(entry => entry.name)
    .sort();
  assert.ok(files.length > 0, 'expected at least one workflow .mmd file');
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8');
    assert.ok(source.trimStart().startsWith('flowchart '), file+' must use the current canonical flowchart profile');
    {
      assert.doesNotThrow(() => parseGraphV2(source), file);
      const runtimes = new Map([
        ['job-lifecycle.mmd', jobLifecycleV2],
        ['task-lifecycle.mmd', taskLifecycleV2],
        ['review-lifecycle.mmd', reviewLifecycleV2],
        ['planner-trigger.mmd', plannerTriggerV2],
        ['planner-orchestration.mmd', plannerOrchestrationV2],
        ['blocker-resolution.mmd', blockerResolutionV2],
        ['authoritative-unblock.mmd', authoritativeUnblockV2],
        ['scheduled-run.mmd', scheduledRunV2],
        ['schedule-cycle.mmd', scheduleCycleV2],
        ['troubleshooter.mmd', troubleshooterV2],
        ['escalation.mmd', escalationGraph],
        ['task-related-action.mmd', taskRelatedActionV2],
        ['task-resolution.mmd', taskResolutionV2],
        ['projection-conflict.mmd', projectionConflictV2],
        ['orchestrator-rescue.mmd', orchestratorRescueV2],
        ['interactive-invocation.mmd', interactiveInvocationGraph],
      ]);
      const runtime = runtimes.get(file);
      assert.ok(runtime, file+' must have a production runtime');
      assert.equal(runtime.graph.source, source, file+' must be loaded by the production runtime');
    }
  }
});


async function sourceFiles(directory) {
  const entries = (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(path);
  }
  return files;
}

test('production lifecycle state assignments stay inside graph application boundaries', async () => {
  const root = new URL('../src', import.meta.url).pathname;
  const assignments = [];
  for (const path of await sourceFiles(root)) {
    const content = await readFile(path, 'utf8');
    for (const match of content.matchAll(/\b(task|job)\.state\s*=(?!=)/g)) {
      assignments.push({ path: path.slice(root.length + 1), text: content.slice(match.index, match.index + 80).split('\n')[0] });
    }
  }
  assert.ok(assignments.length >= 3, 'expected graph-owned lifecycle mutations');
  assert.ok(assignments.every(item => item.path === 'workflow/runtime.ts'), JSON.stringify(assignments));
});

test('production orchestration entry points use dispatch facades and never direct decision helpers', async () => {
  const expectations = new Map([
    ['reconciler-review.ts', ['dispatchReviewLifecycle']],
    ['reconciler.ts', ['dispatchPlannerOrchestration', 'dispatchJobReconcile']],
    ['blockers.ts', ['dispatchBlockerResolution']],
    ['unblock.ts', ['dispatchAuthoritativeUnblock']],
    ['scheduled-jobs.ts', ['dispatchScheduledRun']],
    ['scheduler.ts', ['dispatchScheduleCycle']],
    ['troubleshooter.ts', ['dispatchTroubleshooter']],
  ]);
  const forbiddenDecision = /\bdecide(?:ReviewLifecycle|PlannerOrchestration|JobReconcile|BlockerResolution|AuthoritativeUnblock|ScheduledRun|ScheduleCycle|Troubleshooter|TaskLifecycle|JobLifecycle)\b/;
  for (const [name, symbols] of expectations) {
    const source = await readFile(new URL('../src/' + name, import.meta.url), 'utf8');
    for (const symbol of symbols) assert.match(source, new RegExp('\\b' + symbol + '\\b'), name + ' must use ' + symbol);
    assert.doesNotMatch(source, forbiddenDecision, name + ' must not invoke direct workflow decision helpers');
  }

  const root = new URL('../src', import.meta.url).pathname;
  for (const path of await sourceFiles(root)) {
    const relative = path.slice(root.length + 1);
    const source = await readFile(path, 'utf8');
    if (!['workflow/graph-v2.ts','workflow/dispatcher.ts'].includes(relative)) {
      assert.doesNotMatch(source, /new\s+GraphDispatcher\b|\.evaluateSync\s*\(|\.evaluate\s*\(/, relative + ' must enter graph execution through the dispatcher facade');
    }
  }

  const review = await readFile(new URL('../src/reconciler-review.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(review, /reviewEligible\s*\(/, 'review eligibility must remain explicit graph guards');
  const reconciler = await readFile(new URL('../src/reconciler.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(reconciler, /task\.attempt\s*=\s*task\.maxAttempts/, 'planner availability must not force attempts procedurally');
  assert.doesNotMatch(reconciler, /reviewEnabled\s*===\s*false[^\n]+implementationComplete/, 'no-review merge policy must stay in the Job graph');
  assert.doesNotMatch(reconciler, /prState\s*===\s*['"]MERGED['"]\s*\?\s*['"]COMPLETED['"]/, 'merge completion policy must stay in the Job graph');
  assert.doesNotMatch(reconciler, /prState\s*===\s*['"]CLOSED['"]\s*\?\s*['"]CANCELLED['"]/, 'close cancellation policy must stay in the Job graph');
});


test('new entity constructors cannot choose lifecycle state outside workflow creation boundary', async () => {
  const root = new URL('../src', import.meta.url).pathname;
  const allowed = new Set(['workflow/entity-creation.ts']);
  const violations = [];
  for (const path of await sourceFiles(root)) {
    const relative = path.slice(root.length + 1);
    if (allowed.has(relative)) continue;
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/state\s*:\s*['"](?:DRAFT|QUEUED|ACTIVE)['"]/g)) {
      // Explicit historical record/import is allowed to materialize a completed fact only,
      // never a fresh runnable lifecycle state.
      violations.push(relative + ':' + match[0]);
    }
  }
  assert.deepEqual(violations, []);
});

test('production cannot create synthetic planner Tasks', async () => {
  const root = new URL('../src', import.meta.url).pathname;
  const violations = [];
  for (const path of await sourceFiles(root)) {
    const relative = path.slice(root.length + 1);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/kind\s*:\s*['"]planner['"]/g)) violations.push(relative + ':' + match[0]);
  }
  assert.deepEqual(violations, []);
});


test('production creates planning rounds only as Plan entities', async () => {
  const root = new URL('../src', import.meta.url).pathname;
  const violations = [];
  for (const path of await sourceFiles(root)) {
    const relative = path.slice(root.length + 1);
    const source = await readFile(path, 'utf8');
    for (const match of source.matchAll(/kind\s*:\s*['"]planner['"]/g)) violations.push(relative + ':' + match[0]);
    assert.doesNotMatch(source, /createPlannerRoundTask|pendingPlanForPlannerTask/, relative + ' must not expose synthetic planner Task creation/migration helpers');
  }
  assert.deepEqual(violations, []);
});

test('legacy planner Tasks are read-only compatibility records', async () => {
  const actions = await readFile(new URL('../src/task-actions.ts', import.meta.url), 'utf8');
  const recovery = await readFile(new URL('../src/execution-recovery.ts', import.meta.url), 'utf8');
  const taskReconcile = await readFile(new URL('../src/workflow/task-reconcile.ts', import.meta.url), 'utf8');
  const jobs = await readFile(new URL('../src/job-actions.ts', import.meta.url), 'utf8');
  assert.match(actions, /Legacy planner Task .* read-only/);
  assert.match(recovery, /item\.kind !== 'planner'/);
  assert.match(recovery, /task\.kind !== 'planner'/);
  assert.match(taskReconcile, /if \(task\.kind === 'planner'\) continue/);
  assert.match(jobs, /tryApplyTaskCancelAction\s*\(task, reason\)/);
  assert.match(actions, /if \(task\.kind === 'planner'\) return false/);
});
