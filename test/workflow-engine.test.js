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
import { reviewLifecycleV2 } from '../dist/workflow/review-v2.js';
import { taskRelatedActionV2 } from '../dist/workflow/task-related-action-v2.js';
import { jobLifecycleWorkflow, taskLifecycleWorkflow, validateCanonicalWorkflowGraph } from '../dist/workflow/definitions.js';
import { assertJobLifecycleTransition, assertTaskTransition } from '../dist/types.js';

test('canonical Mermaid workflow graphs load as executable profile', () => {
  assert.equal(jobLifecycleWorkflow.graph.initial, 'DRAFT');
  assert.deepEqual([...jobLifecycleWorkflow.graph.states].sort(), ['ACTIVE','CANCELLED','COMPLETED','DRAFT']);
  assert.equal(taskLifecycleWorkflow.graph.initial, 'DRAFT');
  assert.deepEqual([...taskLifecycleWorkflow.graph.finals].sort(), ['CANCELLED','SUCCEEDED']);
});

test('existing Job and Task lifecycle legality is driven by Mermaid graphs', () => {
  assert.doesNotThrow(() => assertJobLifecycleTransition('DRAFT','ACTIVE'));
  assert.doesNotThrow(() => assertJobLifecycleTransition('CANCELLED','COMPLETED'));
  assert.throws(() => assertJobLifecycleTransition('COMPLETED','ACTIVE'), /Invalid job transition/);
  assert.throws(() => assertTaskTransition('RUNNING','DRAFT'), /Invalid task transition/);
  assert.doesNotThrow(() => assertTaskTransition('FAILED','RUNNING'));
  assert.throws(() => assertTaskTransition('SUCCEEDED','QUEUED'), /Invalid task transition/);
});

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


test('canonical lifecycle graphs expose the integrated runtime event contract', async () => {
  const closed=jobLifecycleWorkflow.graph.transitions.find(t=>t.from==='ACTIVE' && t.event==='pr.closed');
  assert.deepEqual(closed && {to:closed.to,guard:closed.guard,actions:closed.actions},{to:'CANCELLED',guard:'notMerged',actions:['effect.cancelActiveTasks']});
  assert.equal(await jobLifecycleWorkflow.transition('ACTIVE','pr.closed',{notMerged:true}),'CANCELLED');
  await assert.rejects(jobLifecycleWorkflow.transition('ACTIVE','pr.closed',{notMerged:false}),/No enabled workflow transition/);

  assert.equal(await taskLifecycleWorkflow.transition('QUEUED','task.started'),'RUNNING');
  assert.equal(await taskLifecycleWorkflow.transition('RUNNING','task.completed'),'SUCCEEDED');
  assert.equal(await taskLifecycleWorkflow.transition('FAILED','task.completed',{recoverableExecution:true}),'SUCCEEDED');
  await assert.rejects(taskLifecycleWorkflow.transition('FAILED','task.completed',{recoverableExecution:false}),/No enabled workflow transition/);
  await assert.rejects(taskLifecycleWorkflow.transition('SUCCEEDED','watchdog.failed'),/No enabled workflow transition/);
  assert.equal(await taskLifecycleWorkflow.transition('DRAFT','reconcile',{dependenciesSatisfied:true}),'QUEUED');
  assert.equal(await taskLifecycleWorkflow.transition('QUEUED','reconcile',{dependenciesUnsatisfied:true}),'DRAFT');
  assert.equal(await taskLifecycleWorkflow.transition('QUEUED','reconcile',{runnable:true}),'QUEUED');
});

test('canonical graph contract fails closed on undeclared events, facts, and actions', () => {
  const unknownEvent=parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: invented.event
`);
  assert.throws(() => validateCanonicalWorkflowGraph(unknownEvent), /Unknown canonical workflow event/);

  const unknownFact=parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: reconcile [inventedFact]
`);
  assert.throws(() => validateCanonicalWorkflowGraph(unknownFact), /Unknown canonical workflow fact/);

  const unknownAction=parseExecutableMermaid(`stateDiagram-v2
[*] --> A
A --> B: reconcile / effect.invented
`);
  assert.throws(() => validateCanonicalWorkflowGraph(unknownAction), /Unknown canonical workflow action/);
});

test('every canonical graph transition uses the shared event, fact, and action contracts', () => {
  for (const workflow of [jobLifecycleWorkflow, taskLifecycleWorkflow]) {
    assert.doesNotThrow(() => validateCanonicalWorkflowGraph(workflow.graph));
  }
});

test('every repository lifecycle graph file parses and validates with the production contract', async () => {
  const directory = new URL('../workflow/', import.meta.url);
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.mmd'))
    .map(entry => entry.name)
    .sort();
  assert.ok(files.length > 0, 'expected at least one workflow .mmd file');
  for (const file of files) {
    const source = await readFile(new URL(file, directory), 'utf8');
    if (source.trimStart().startsWith('flowchart ')) {
      assert.doesNotThrow(() => parseGraphV2(source), file);
      const runtimes = new Map([
        ['job-lifecycle-v2.mmd', jobLifecycleV2],
        ['task-lifecycle-v2.mmd', taskLifecycleV2],
        ['review-lifecycle-v2.mmd', reviewLifecycleV2],
        ['planner-trigger-v2.mmd', plannerTriggerV2],
        ['planner-orchestration-v2.mmd', plannerOrchestrationV2],
        ['blocker-resolution-v2.mmd', blockerResolutionV2],
        ['authoritative-unblock-v2.mmd', authoritativeUnblockV2],
        ['scheduled-run-v2.mmd', scheduledRunV2],
        ['schedule-cycle-v2.mmd', scheduleCycleV2],
        ['troubleshooter-v2.mmd', troubleshooterV2],
        ['task-related-action-v2.mmd', taskRelatedActionV2],
      ]);
      const runtime = runtimes.get(file);
      assert.ok(runtime, file+' must have a production v2 runtime');
      assert.equal(runtime.graph.source, source, file+' must be loaded by the production v2 runtime');
    } else {
      const graph = parseExecutableMermaid(source);
      assert.doesNotThrow(() => validateCanonicalWorkflowGraph(graph), file);
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
