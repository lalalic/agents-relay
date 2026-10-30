import assert from 'node:assert/strict';
import test, { managedReconciler } from './test-runtime.js';
import { mkdtemp, mkdir, writeFile, readFile, realpath, chmod, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { InMemoryStore } from '../dist/store.js';
import { marker, JOB_MARKER, PLAN_MARKER, TASK_MARKER, parseJob, parsePlan, parseTask, renderJobComment, renderPlanComment } from '../dist/markers.js';
import { AgentObjectivePlanner, createPlanRound, normalizePlannerPriority, parsePlannerOutput, parsePlannerResult, plannerInput, semanticTaskTree, validatePlannerHierarchy, validatePlannerLifecycleOwnership, validatePlannerProgress, validatePlannerResolutionMaterialization } from '../dist/planner.js';
import { storySizeTimeoutMs, taskOverallTimeoutMs, chatGptStartAckTimeoutMs } from '../dist/types.js';
import { Reconciler, executionEventSource } from '../dist/reconciler.js';
import { refreshTaskDependencies } from '../dist/task-transitions.js';
import { deriveJobRuntimeStatus } from '../dist/runtime-status.js';
import { dashboardHtml } from '../dist/dashboard.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';

const now = () => new Date().toISOString();
const route = { provider: 'openai', model: 'gpt-5', decidedBy: 'test', decidedAt: now() };
const output = { kind: 'task_pr' };
const task = (id, state = 'QUEUED') => ({ jobId: 'auto', id, kind: 'work', parentTaskId: null, dependencies: [], capabilities: [], adapter: 'codex', input: 'do the described work', output, routing: route, state, attempt: 0, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, error: null, timeoutMs: 1000, createdAt: now(), updatedAt: now(), continuation: null, continuationDeliveredAt: null });
const job = (tasks = []) => ({ id: 'auto', title: 'Objective', objective: 'finish the objective', prNumber: 1, repository: 'owner/repo', state: 'ACTIVE', continuation: null, createdAt: now(), updatedAt: now(), tasks });
const spec = id => ({ id, title: 'Implement and verify durable task outputs', input: 'do the described work', adapter: 'codex', workerRequirements: { capabilities: ['model'] }, output, routing: route });
function startedObjectiveJob() {
  const seed = { ...task('seed', 'SUCCEEDED'), result: { summary: 'seed complete' } };
  return job([seed]);
}
function executionHarness(bus) {
  return {
    name: 'codex',
    id: 'test-codex',
    capabilities: ['model','codex'],
    launch(current) {
      queueMicrotask(async () => {
        const source = { id: executionEventSource('auto', current.id, current.executionId) };
        await bus.publish(eventFor('auto', current.id, current.parentTaskId, 'task.started', 'running', `started ${current.id}`, 'user', undefined, source));
        await bus.publish(eventFor('auto', current.id, current.parentTaskId, 'task.completed', 'succeeded', `completed ${current.id}`, 'orchestrator', undefined, source));
      });
      return { id: `exec-${current.id}`, promise: Promise.resolve({ summary: 'runtime exited' }), cancel() {} };
    },
  };
}
async function settle(reconciler, count = 8) { for (let index = 0; index < count; index += 1) { await reconciler.reconcile('auto'); await reconciler.idle(); await new Promise(resolve => setTimeout(resolve, 0)); } }



test('new planning rounds use plan-N while historical planner-N remains readable', () => {
  const historical = { ...task('planner-1', 'SUCCEEDED'), kind: 'planner', planningRound: 1, plannerResult: { objective_status: 'satisfied', assessment: 'legacy', next_tasks: [] } };
  const round = createPlanRound(job([historical]), { guidance: 're-plan from durable state', manual: true, now: '2026-09-26T12:00:00.000Z' });
  assert.equal(round.id, 'plan-2');
  assert.equal(round.previousPlanId, 'planner-1');
  assert.equal(round.round, 2);
  assert.equal(round.guidance, 're-plan from durable state');
  assert.equal(round.manualPlanning, true);
  assert.equal(round.status, 'PLANNING');
});

test('manual plan runs on a zero-task DRAFT job and persists routed-later child provenance', async () => {
  const root = { ...job([]), state: 'DRAFT' };
  const store = new InMemoryStore(root);
  let observed;
  const planner = { plan: async context => { observed = context; return { objective_status: 'in_progress', assessment: 'need implementation', next_tasks: [{title: 'Implement and verify durable task outputs',  id: 'implement', input: 'implement the objective', output, storySize: 'S', workerRequirements: { capabilities: ['model'] } }] }; } };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [{ name: 'codex', id: 'planner-worker', capabilities: ['model'] }], planner, maxConcurrent: 0 });
  const result = await reconciler.planJob('auto', 'focus on the durable objective');
  assert.equal(result.round.id, 'plan-1');
  assert.equal(result.round.status, 'SUCCEEDED');
  assert.equal(result.round.plannerResult.objective_status, 'in_progress');
  assert.equal(result.job.state, 'ACTIVE');
  assert.equal(observed.objective, 'finish the objective');
  assert.equal(observed.guidance, 'focus on the durable objective');
  const child = result.job.tasks.find(item => item.id === result.round.generatedTaskIds[0]);
  assert.match(child?.id ?? '', /^[1-9]\d*$/);
  assert.ok(child);
  assert.equal(child.parentTaskId, null);
  assert.equal(child.planningDecisionId, 'plan-1');
  assert.equal(child.planningSource, 'model-planner');
  assert.equal(child.planningRound, 1);
  assert.equal(child.workerSelection, undefined);
  assert.equal(child.routing, undefined);
});

test('planner binds reviewer children to the actual immutable PR head', async () => {
  const contextRoot = await mkdtemp(join(tmpdir(), 'agents-relay-planner-reviewer-context-'));
  await mkdir(join(contextRoot, 'agents'));
  await writeFile(join(contextRoot, 'agents', 'reviewer.agent.md'), '---\nname: reviewer\n---\nReview the managed task.\n');
  const headSha = '059c84f00c46f15dbc8f52c571c0be435878601c';
  const store = new InMemoryStore({ ...job([]), state: 'DRAFT', headSha: 'stale-head' });
  store.headSha = async () => headSha;
  let observedTriggerHeadSha;
  const reconciler = managedReconciler(store, {
    owner: 'test', adapters: [{ name: 'codex', id: 'review-worker', capabilities: ['model'] }, { name: 'chatgpt', id: 'review-chatgpt', capabilities: ['model', 'chatgpt', 'webhelm'] }], maxConcurrent: 0, executionContextRoots: { globalRoot: contextRoot, neoRoot: null },
    planner: { plan: async context => { observedTriggerHeadSha = context.trigger.currentHeadSha; return { objective_status: 'in_progress', assessment: 'review required', next_tasks: [{title: 'Implement and verify durable task outputs',
      id: 'immutable-review', input: `Review exactly ${headSha}.`, agentName: 'reviewer', output,
    }] }; } },
  });
  const result = await reconciler.planJob('auto');
  const reviewer = result.job.tasks.find(item => item.id === result.round.generatedTaskIds[0]);
  assert.ok(reviewer);
  assert.equal(observedTriggerHeadSha, headSha);
  assert.equal(result.round.headSha, headSha);
  assert.equal(reviewer.reviewHeadSha, headSha);
  assert.match(reviewer.input, new RegExp(headSha));
  await rm(contextRoot, { recursive: true, force: true });
});

test('planner hierarchy rejects planner parents, unknown parents, self parents, and cycles', () => {
  const plannerTask = { ...task('plan-1', 'SUCCEEDED'), kind: 'planner' };
  assert.throws(() => validatePlannerHierarchy([plannerTask], [{ ...spec('child'), parentTaskId: 'plan-1' }]), /cannot use planner round/);
  assert.throws(() => validatePlannerHierarchy([], [{ ...spec('child'), parentTaskId: 'missing' }]), /unknown parentTaskId/);
  assert.throws(() => validatePlannerHierarchy([], [{ ...spec('child'), parentTaskId: 'child' }]), /cannot parent itself/);
  assert.throws(() => validatePlannerHierarchy([], [{ ...spec('a'), parentTaskId: 'b' }, { ...spec('b'), parentTaskId: 'a' }]), /cycle/);
});

test('planner can create business parent-child hierarchy without plan-N parents', async () => {
  const root = { ...job([]), state: 'DRAFT' };
  const store = new InMemoryStore(root);
  const planner = { plan: async () => ({ objective_status: 'in_progress', assessment: 'hierarchy', next_tasks: [
    {title: 'Implement and verify durable task outputs',  id: 'day-2026-09-28', input: 'Group the day.', output, storySize: 'S' },
    {title: 'Implement and verify durable task outputs',  id: 'hour-17', parentTaskId: 'day-2026-09-28', input: 'Run the hour.', output, storySize: 'S' }
  ] }) };
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [{ name: 'codex', id: 'planner-worker', capabilities: [] }], planner, maxConcurrent: 0 });
  const result = await reconciler.planJob('auto');
  const [dayId, hourId] = result.round.generatedTaskIds;
  const day = result.job.tasks.find(item => item.id === dayId);
  const hour = result.job.tasks.find(item => item.id === hourId);
  assert.equal(day.parentTaskId, null);
  assert.equal(hour.parentTaskId, dayId);
  assert.equal(hour.planningDecisionId, 'plan-1');
});

test('manual satisfied plan without authoritative completion is rejected before commit', async () => {
  const store = new InMemoryStore({ ...job([]), state: 'DRAFT' });
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'already complete', next_tasks: [] }) } });
  await assert.rejects(() => reconciler.planJob('auto'), /PLAN_APPLY_VALIDATION_FAILED.*forward_convergence/);
  const current = await store.load('auto');
  assert.equal(current.plans[0].status, 'PLANNING');
  assert.equal(current.tasks.filter(item => item.kind !== 'planner').length, 0);
});

test('manual plan rejects a concurrent active planning round', async () => {
  const root = { ...job([]), state: 'ACTIVE' };
  const active = createPlanRound(root, { manual: true });
  active.executionId = 'active-plan-execution';
  active.leaseOwner = 'other-relay';
  active.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
  root.plans = [active];
  const store = new InMemoryStore(root);
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, planner: { plan: async () => ({ objective_status: 'satisfied', assessment: 'done', next_tasks: [] }) } });
  await assert.rejects(() => reconciler.planJob('auto'), /already PLANNING/);
});

test('malformed manual planner output fails the round without materializing children', async () => {
  const store = new InMemoryStore({ ...job([]), state: 'DRAFT' });
  const reconciler = managedReconciler(store, { owner: 'test', adapters: [], maxConcurrent: 0, planner: { plan: async () => ({ objective_status: 'in_progress', assessment: 'bad', next_tasks: [{title: 'Implement and verify durable task outputs',  id: 'broken', input: 'work without output' }] }) } });
  await assert.rejects(() => reconciler.planJob('auto'), /output is required/);
  const saved = await store.load('auto');
  assert.equal(saved.tasks.some(item => item.id === 'broken'), false);
  assert.equal(saved.tasks.some(item => item.kind === 'planner'), false);
  assert.equal(saved.plans.find(item => item.id === 'plan-1')?.status, 'PLANNING');
});
test('reconcile resumes a durable PLANNING Plan without creating a planner Task', async () => {
  const createdAt = '2026-09-29T12:00:00.000Z';
  const root = startedObjectiveJob();
  root.plans = [{ jobId:'auto', id:'plan-1', round:1, source:'model-planner', previousPlanId:null, trigger:{source:'continuation'}, status:'PLANNING', assessment:'Planning in progress.', generatedTaskIds:[], createdAt, updatedAt:createdAt }];
  const store = new InMemoryStore(root);
  const reconciler = managedReconciler(store, { owner:'test', adapters:[{ name:'codex', id:'planner-worker', capabilities:['model'] }], maxConcurrent:0, planner:{ plan:async()=>({ objective_status:'satisfied', assessment:'done', next_tasks:[spec('resume-work')] }) } });
  await reconciler.reconcile('auto');
  await reconciler.idle();
  const saved = await store.load('auto');
  assert.equal(saved.tasks.some(item => item.kind === 'planner'), false);
  assert.equal(saved.plans.filter(item => item.id === 'plan-1').length, 1);
  assert.equal(saved.plans[0].createdAt, createdAt);
  assert.equal(saved.plans[0].trigger.source, 'continuation');
  assert.equal(saved.plans[0].status, 'SUCCEEDED');
});

test('manual planning recovers an interrupted manual Plan instead of creating a new round', async () => {
  const createdAt = '2026-09-29T12:05:00.000Z';
  const root = { ...job([]), state:'DRAFT', plans:[{ jobId:'auto', id:'plan-1', round:1, source:'model-planner', previousPlanId:null, trigger:{source:'manual'}, status:'PLANNING', guidance:'original guidance', assessment:'Planning in progress.', generatedTaskIds:[], createdAt, updatedAt:createdAt }] };
  const store = new InMemoryStore(root);
  let observed;
  const reconciler = managedReconciler(store, { owner:'test', adapters:[{ name:'codex', id:'planner-worker', capabilities:['model'] }], maxConcurrent:0, planner:{ plan:async context=>{ observed=context; return { objective_status:'satisfied', assessment:'done', next_tasks:[spec('recovered-manual-work')] }; } } });
  const result = await reconciler.planJob('auto', 'new guidance must not replace durable pending input');
  assert.equal(result.round.id, 'plan-1');
  assert.equal(result.round.createdAt, createdAt);
  assert.equal(observed.guidance, 'original guidance');
  assert.equal(result.job.plans.filter(item => item.id === 'plan-1').length, 1);
  assert.equal(result.job.plans[0].status, 'SUCCEEDED');
});



test('planner cannot leave objective Job idle with in_progress and no executable work before review', () => {
  const implemented={...task('implementation','SUCCEEDED'),agentName:'implementation'};
  const root={...job([implemented]),prNumber:0,localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending'}};
  const empty={objective_status:'in_progress',assessment:'only Relay-owned lifecycle remains',next_tasks:[],unblocks:[]};
  assert.throws(()=>validatePlannerProgress(root,empty),/no executable tasks or unblocks/);
  assert.doesNotThrow(()=>validatePlannerProgress(root,{...empty,objective_status:'satisfied'}));
  const reviewed={...root,tasks:[implemented,{...task('review','SUCCEEDED'),agentName:'reviewer'}]};
  assert.doesNotThrow(()=>validatePlannerProgress(reviewed,empty));
});

test('local-first planner cannot delegate Relay-owned merge and completion lifecycle to a worker task', () => {
  const root = { ...job([]), prNumber:0, localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'pending'} };
  const release = { id:'release', agentName:'release', input:'Perform the required local merge, verify Job COMPLETED, and merge the projected GitHub PR.', output:{kind:'task_pr'}, storySize:'S' };
  assert.throws(() => validatePlannerLifecycleOwnership(root, [release]), /Relay-owned effects/);
  assert.doesNotThrow(() => validatePlannerLifecycleOwnership(root, [{...release,id:'verify',input:'Verify the implementation tests and report findings without changing lifecycle state.'}]));
  assert.doesNotThrow(() => validatePlannerLifecycleOwnership(root, [{...release,id:'implementation',input:'Create a fixture and run npm test. Relay must handle review, local merge, Job COMPLETED and GitHub PR MERGED. Do not perform manual lifecycle actions.'}]));
  assert.throws(() => validatePlannerLifecycleOwnership(root, [{...release,id:'publish',input:'Resolve the release blocker if safe, then publish the current npm package and deploy the runtime service.'}]), /release delivery/);
  assert.doesNotThrow(() => validatePlannerLifecycleOwnership(root, [{...release,id:'verify-release',input:'Verify the published npm package and deployed runtime service; report evidence only.'}]));
});

test('planner input exposes semantic ownership separately from plan provenance', () => {
  const milestone={...task('milestone','SUCCEEDED'),planningDecisionId:'plan-1',planningRound:1};
  const review={...task('review','SUCCEEDED'),parentTaskId:'milestone',dependencies:['milestone'],planningDecisionId:'plan-1',planningRound:1};
  const plan={...task('plan-2','SUCCEEDED'),kind:'planner',planningRound:2};
  const payload=JSON.parse(plannerInput({job:job([milestone,review,plan]),tasks:[milestone,review,plan],objective:'finish',previousPlannerTaskId:'plan-2'}));
  assert.deepEqual(payload.semantic_task_tree.roots,['milestone']);
  assert.deepEqual(payload.semantic_task_tree.tasks.map(item=>item.id),['milestone','review']);
  assert.equal(payload.semantic_task_tree.tasks.find(item=>item.id==='review').parent_task_id,'milestone');
  assert.equal(payload.semantic_task_tree.tasks.some(item=>item.id==='plan-2'),false);
  assert.deepEqual(semanticTaskTree([milestone,review,plan]).roots,['milestone']);
});

test('planner input carries explicit retry feedback for corrective retries', () => {
  const payload = JSON.parse(plannerInput({
    job: { id:'j', title:'j', prNumber:1, repository:'owner/repo', state:'ACTIVE', continuation:null, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), tasks:[] },
    tasks: [],
    objective: 'make content',
    previousPlannerTaskId: null,
    retryFeedback: 'Planner next_tasks[0].output is required',
  }));
  assert.equal(payload.retry_feedback, 'Planner next_tasks[0].output is required');
});

test('forced cleanup Planner context includes durable failure dependencies and evidence', () => {
  const failed = { ...task('failed'), state: 'FAILED', dependencies: ['prerequisite'], failureReason: 'task_failure', comments: [{ id: 'c1', text: 'replacement evidence was checked', author: 'operator', createdAt: now() }] };
  const payload = JSON.parse(plannerInput({ job: job([failed]), tasks: [failed], objective: 'replan', previousPlannerTaskId: null, forceRestate: true, restateTaskIds: ['failed'] }));
  assert.equal(payload.force_restate, true);
  assert.deepEqual(payload.restate_task_ids, ['failed']);
  assert.deepEqual(payload.tasks[0].dependencies, ['prerequisite']);
  assert.equal(payload.tasks[0].failure_reason, 'task_failure');
  assert.equal(payload.tasks[0].comments[0].text, 'replacement evidence was checked');
});

test('Planner contract makes forced cleanup an upfront audit and apply rejection actionable', async () => {
  const prompt = await readFile(new URL('../skills/agents-relay/agents/planner.agent.md', import.meta.url), 'utf8');
  assert.match(prompt, /end-to-end objective convergence/i);
  assert.match(prompt, /exactly one `history_cleanup` entry for every ID in `restate_task_ids` in the first complete candidate/i);
  assert.match(prompt, /PLAN_APPLY_VALIDATION_FAILED/);
  assert.match(prompt, /same Plan and execution IDs/i);
  assert.match(prompt, /missing, mismatched, or decorated receipt/);
  assert.match(prompt, /unknown.*`unresolved`/i);
  assert.match(prompt, /unresolved failure may still need safe recovery/i);
  assert.match(prompt, /evidence-backed blocked Troubleshooter/i);
  assert.doesNotMatch(prompt, /Do not create replacement work for an unresolved failure/);
});

test('planner input stays compact with a large execution context and planner history', () => {
  const huge = 'x'.repeat(70000);
  const context = {
    project: { name:'neo-build-log', path:'/tmp/neo/neo-build-log', workspaceRoot:'/tmp/neo', neoRoot:'/tmp/neo', globalRoot:'/tmp' },
    role:'planner',
    instructions:[{path:'/tmp/huge',content:huge}],
    skills:[{name:'huge-skill',description:huge,path:'/tmp/skill'}],
    agents:[{name:'build-log-editor',description:huge,capabilities:['content'],restrictions:[],runtime:'codex',path:'/tmp/editor'}],
    runtimes:[],
    delegation:{mode:'relay-child-task',parentTaskIdRequired:false},
  };
  const priorPlanner={...task('planner-old','FAILED'),kind:'planner',input:huge,error:huge,plannerResult:{objective_status:'in_progress',assessment:huge,next_tasks:[spec('episode')]}};
  const payloadText=plannerInput({job:job([priorPlanner]),tasks:[priorPlanner],objective:'make content',previousPlannerTaskId:'planner-old',executionContext:context,retryFeedback:'bad output'});
  const payload=JSON.parse(payloadText);
  assert.equal(payload.execution_context, undefined);
  assert.equal(payload.project.name, 'neo-build-log');
  assert.deepEqual(payload.visible_agents.map(agent => agent.name), ['build-log-editor']);
  assert.equal(payload.tasks[0].input, undefined);
  assert.deepEqual(payload.tasks[0].planner_result.next_task_ids, ['episode']);
  assert.equal(payloadText.includes(huge), false);
  assert.ok(payloadText.length < 20000, `planner input too large: ${payloadText.length}`);
});

test('legacy Job metadata is discarded while planner result markers round-trip', () => {
  const autonomous = job();
  assert.equal(parseJob(renderJobComment(autonomous)).executionMode, undefined);
  const legacy = { ...autonomous }; delete legacy.executionMode;
  assert.equal(parseJob(marker(JOB_MARKER, { ...legacy, executionMode: 'fixed', schedule: { kind: 'cron', expression: '* * * * *' } })).executionMode, undefined);
  assert.equal(parseJob(marker(JOB_MARKER, { ...legacy, executionMode: 'autonomous', schedule: { kind: 'cron', expression: '* * * * *' } })).schedule, undefined);
  const planner = { ...task('planner-1'), kind: 'planner', plannerResult: { objective_status: 'in_progress', assessment: 'need work', next_tasks: [spec('work-1')] } };
  assert.equal(parseTask(marker(TASK_MARKER, planner)).plannerResult.next_tasks[0].id, 'work-1');
  assert.equal(parsePlannerOutput('{"objective_status":"satisfied","assessment":"done","next_tasks":[]}').objective_status, 'satisfied');
  assert.throws(() => parsePlannerResult({ objective_status: 'satisfied', assessment: 'bad', next_tasks: [spec('duplicate'), spec('duplicate')] }), /duplicate/);
  assert.doesNotMatch(dashboardHtml, /Execution mode|Cadence|function cadence/);
});

test('planner parses authoritative reverse cross-job unblocks and rejects malformed declarations', () => {
  const result=parsePlannerResult({objective_status:'in_progress',assessment:'wait',unblocks:[{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}],next_tasks:[]});
  assert.deepEqual(result.unblocks,[{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}]);
  assert.throws(()=>parsePlannerResult({objective_status:'in_progress',assessment:'bad',unblocks:[{repository:'bad',prNumber:42,jobId:'dependent',taskId:'consume'}],next_tasks:[]}),/repository must be OWNER\/REPO/);
  assert.throws(()=>parsePlannerResult({objective_status:'in_progress',assessment:'bad',unblocks:[{repository:'org/app',prNumber:0,jobId:'dependent',taskId:'consume'}],next_tasks:[]}),/positive integer/);
});

test('planner parses only explicit failed-history dispositions', () => {
  const result = parsePlannerResult({ objective_status: 'satisfied', assessment: 'history preserved', next_tasks: [], history_cleanup: [
    { taskId: 'failed-1', outcome: 'unresolved', evidence: 'No replacement or root-cause evidence is available.', reason: 'Leave the failure visible for future evidence.' },
  ] });
  assert.equal(result.history_cleanup[0].outcome, 'unresolved');
  assert.throws(() => parsePlannerResult({ objective_status: 'satisfied', assessment: 'bad', next_tasks: [], history_cleanup: [{ taskId: 'failed-1', outcome: 'superseded', evidence: '', reason: '', targetTaskId: 'new' }] }), /history_cleanup\[0\]\.evidence must be a non-empty string/);
  assert.throws(() => parsePlannerResult({ objective_status: 'satisfied', assessment: 'bad', next_tasks: [], history_cleanup: [{ taskId: 'failed-1', outcome: 'success', evidence: 'done', reason: 'done' }] }), /history_cleanup\[0\]\.outcome is invalid/);
});

test('planner persistence delegates reverse unblock registration to durable store', async () => {
  const store=new InMemoryStore({...job([]),state:'DRAFT'});
  const seen=[];
  store.registerBlockerDependent=async (jobId, dependent)=>{ seen.push({jobId,dependent}); };
  const planner={plan:async()=>({objective_status:'satisfied',assessment:'work plus a blocked relation',unblocks:[{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}],next_tasks:[spec('unblock-work')]})};
  const reconciler=managedReconciler(store,{owner:'test',adapters:[{name:'codex',id:'planner-worker',capabilities:['model']}],maxConcurrent:0,planner});
  await reconciler.planJob('auto');
  assert.deepEqual(seen,[{jobId:'auto',dependent:{repository:'org/app',prNumber:42,jobId:'dependent',taskId:'consume',resolutionMode:'merge'}}]);
});

test('planner rejects command-like shell tasks and requires output', () => {
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{title: 'Implement and verify durable task outputs', id:'x',input:'npm test',adapter:'shell'}] }), /codex, chatgpt, or z/);
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{title: 'Implement and verify durable task outputs', id:'x',input:'work',adapter:'codex'}] }), /output is required/);
});

test('planner reports malformed nested output precisely', () => {
  assert.throws(() => parsePlannerResult({ objective_status:'in_progress', assessment:'x', next_tasks:[{title: 'Implement and verify durable task outputs', id:'x',input:'work',output:'file'}] }), /output must be an object/);
});

test('planner preserves worker requirements for worker-router selection', () => {
  const result = parsePlannerResult({ objective_status: 'in_progress', assessment: 'work', next_tasks: [{title: 'Implement and verify durable task outputs',
    id: 'resource-aware', input: 'do work', adapter: 'codex', output,
    workerRequirements: { capabilities: ['model', 'browser-harness'], runtime: 'hosted', taskKind: 'research', labels: { region: 'ca' } },
  }] });
  assert.deepEqual(result.next_tasks[0].workerRequirements, { capabilities: ['model', 'browser-harness'], runtime: 'hosted', taskKind: 'research', trustDomain: undefined, region: undefined, labels: { region: 'ca' } });
});

test('planner priority normalization preserves canonical values and accepts safe aliases', () => {
  assert.equal(normalizePlannerPriority('P0', 'next_tasks[0].priority'), 'P0');
  assert.equal(normalizePlannerPriority('p1', 'next_tasks[0].priority'), 'P1');
  assert.equal(normalizePlannerPriority(' P2 ', 'next_tasks[0].priority'), 'P2');
  assert.equal(normalizePlannerPriority(3, 'next_tasks[0].priority'), 'P3');
  assert.equal(normalizePlannerPriority('0', 'next_tasks[0].priority'), 'P0');
  assert.throws(() => normalizePlannerPriority('high', 'next_tasks[0].priority'), /priority is invalid.*"high"/);
  assert.throws(() => normalizePlannerPriority(4, 'next_tasks[0].priority'), /priority is invalid.*4/);
});

test('automatic planner retry carries prior failure and persists launch-time planner input', async () => {
  const store = new InMemoryStore(startedObjectiveJob());
  const seen = [];
  const planner = { plan: async context => {
    seen.push(context);
    if (seen.length === 1) throw new Error('Planner next_tasks[0].output is required');
    return { objective_status:'satisfied', assessment:'done', next_tasks:[spec('retry-work')] };
  } };
  const reconciler = managedReconciler(store, { owner:'test', adapters:[{name:'codex',id:'planner-worker',capabilities:['model']}], planner });
  await settle(reconciler, 6);
  const result = await store.load('auto');
  const round = result.plans?.find(item => item.id === 'plan-1');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].retryFeedback, 'Planner next_tasks[0].output is required');
  assert.equal(round?.retryFeedback, undefined);
  assert.equal(round?.attempt, 2);
  assert.equal(round?.status, 'SUCCEEDED');
  assert.equal(result.tasks.some(item => item.kind === 'planner'), false);
});

test('planner result with a formatting-only priority variation creates a child task', async () => {
  const bus = new MemoryEventBus();
  const store = new InMemoryStore(startedObjectiveJob());
  let calls = 0;
  const planner = { plan: async () => ++calls === 1 ? ({ objective_status:'satisfied', assessment:'work', next_tasks:[{title: 'Implement and verify durable task outputs',  ...spec('work-1'), priority:'p1' }] }) : ({ objective_status:'satisfied', assessment:'done', next_tasks:[] }) };
  const reconciler = managedReconciler(store, { owner:'test', adapters:[executionHarness(bus)], planner, eventBus:bus });
  const stop = await reconciler.watch('auto');
  await settle(reconciler, 8);
  const result = await store.load('auto');
  const firstPlan = result.plans?.find(item => item.id === 'plan-1');
  assert.equal(result.tasks.find(item => item.id === firstPlan?.generatedTaskIds[0])?.priority, 'P1');
  assert.equal(firstPlan?.status, 'SUCCEEDED');
  assert.match(firstPlan?.generatedTaskIds[0] ?? '', /^[1-9]\d*$/);
  const comments = await store.comments();
  const planIndex = comments.findIndex(comment => comment.body.includes(PLAN_MARKER) && comment.body.includes('\"id\":\"plan-1\"'));
  const childIndex = comments.findIndex(comment => comment.body.includes(TASK_MARKER) && comment.body.includes('\"id\":\"' + firstPlan.generatedTaskIds[0] + '\"'));
  assert.ok(planIndex >= 0 && childIndex > planIndex, 'Plan comment must precede generated child Task comment');
  await stop();
});

test('Plan marker round-trips independently from Job and Task markers', () => {
  const plan = { jobId:'auto', id:'plan-7', round:7, source:'model-planner', previousPlanId:'plan-6', trigger:{source:'unblock',taskIds:['release'],reason:'publisher access restored',blockedHeadShas:['abc'],currentHeadSha:'def',facts:['access changed']}, status:'SUCCEEDED', objectiveStatus:'in_progress', assessment:'re-plan release', generatedTaskIds:['release-next'], headSha:'def', createdAt:now(), updatedAt:now() };
  const body = renderPlanComment(plan);
  assert.ok(body.includes(PLAN_MARKER));
  assert.deepEqual(parsePlan(body), plan);
  assert.equal(parseJob(body), null);
  assert.equal(parseTask(body), null);
});

test('default planner uses the production reference-first prompt and preserves Plan apply contract', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-agent-'));
  try {
    const command = join(root, 'model-runtime');
    const promptFile = join(root, 'assembled-prompt.txt');
    const argsFile = join(root, 'runtime-args.json');
    await writeFile(command, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(promptFile)}, process.argv.at(-1));
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)));
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'PLAN_APPLIED:plan-1:execution-1'}}) + '\\n');
`, { mode: 0o700 });
    await chmod(command, 0o700);
    const planner = new AgentObjectivePlanner(command);
    assert.equal((await planner.plan({ job: job(), tasks: [], objective: 'finish', previousPlannerTaskId: null, planExecution: { planId: 'plan-1', executionId: 'execution-1' } }, new AbortController().signal)).cliApplied, true);
    const prompt = await readFile(promptFile, 'utf8');
    const reference = prompt.match(/^- instructions: (.+) \(sha256:([a-f0-9]{64})\)$/m);
    assert.ok(reference);
    assert.match(await readFile(reference[1], 'utf8'), /agents-relay plan apply/);
    assert.doesNotMatch(prompt, /Verify its SHA-256|Effective planner contract SHA-256/);
    assert.match(prompt, /Relay owns snapshot integrity/);
    assert.match(prompt, /## Durable planner input/);
    assert.ok(prompt.indexOf('[Agent instructions') < prompt.indexOf('[Task data'));
    const args = JSON.parse(await readFile(argsFile, 'utf8'));
    assert.ok(args.includes('--sandbox') && args[args.indexOf('--sandbox') + 1] === 'workspace-write');
    assert.ok(args.includes('--add-dir') && args[args.indexOf('--add-dir') + 1].startsWith('/'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('agent planner rejects text proposals that were not committed with the CLI action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-json-retry-'));
  try {
    const command = join(root, 'model-runtime');
    const agentFile = join(root, 'planner.agent.md');
    await writeFile(agentFile, '# Planner\nJSON only');
    await writeFile(command, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({objective_status:'satisfied',assessment:'done',next_tasks:[]})}}) + String.fromCharCode(10));
`, {mode:0o700});
    const planner = new AgentObjectivePlanner(command, agentFile);
    await assert.rejects(planner.plan({job:job(),tasks:[],objective:'finish',previousPlannerTaskId:null,planExecution:{planId:'plan-1',executionId:'execution-1'}},new AbortController().signal),/missing PLAN_APPLIED receipt/);
  } finally {await rm(root,{recursive:true,force:true});}
});

test('agent planner rejects missing, mismatched, and decorated CLI receipts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-receipt-'));
  try {
    const command = join(root, 'model-runtime');
    const agentFile = join(root, 'planner.agent.md');
    await writeFile(agentFile, '# Planner\nUse plan apply and return its receipt.');
    for (const receipt of ['', 'PLAN_APPLIED:other-plan:execution-1', 'PLAN_APPLIED:plan-1:other-execution', 'Applied PLAN_APPLIED:plan-1:execution-1']) {
      await writeFile(command, `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:${JSON.stringify(receipt)}}}) + String.fromCharCode(10));\n`, { mode: 0o700 });
      const planner = new AgentObjectivePlanner(command, agentFile);
      await assert.rejects(planner.plan({ job: job(), tasks: [], objective: 'finish', previousPlannerTaskId: null, planExecution: { planId: 'plan-1', executionId: 'execution-1' } }, new AbortController().signal), /(?:missing|mismatched) PLAN_APPLIED receipt|returned no final message/);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('default planner agent runs from the resolved project working directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-planner-cwd-'));
  try {
    const command = join(root, 'model-runtime');
    const agentFile = join(root, 'planner.agent.md');
    await writeFile(agentFile, '# Planner Agent\nReturn JSON only.\n');
    await writeFile(command, ['#!/bin/sh', 'pwd > planner.cwd', "printf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"PLAN_APPLIED:plan-1:execution-1\"}}'"].join('\n'), { mode: 0o700 });
    await chmod(command, 0o700);
    const planner = new AgentObjectivePlanner(command, agentFile);
    const executionContext = {
      project: { name: 'project', path: root, workspaceRoot: root, neoRoot: null, globalRoot: root },
      role: 'planner',
      instructions: [],
      skills: [],
      agents: [],
      runtimes: [],
      delegation: { mode: 'relay-child-task', parentTaskIdRequired: false }
    };
    const result = await planner.plan({ job: job(), tasks: [], objective: 'finish', previousPlannerTaskId: null, executionContext, planExecution: { planId: 'plan-1', executionId: 'execution-1' } }, new AbortController().signal);
    assert.equal(result.cliApplied, true);
    assert.equal((await readFile(join(root, 'planner.cwd'), 'utf8')).trim(), await realpath(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('planner satisfaction cannot bypass failed or blocked completion gates', () => {
  const satisfied = { ...task('planner-1', 'SUCCEEDED'), kind: 'planner', plannerResult: { objective_status: 'satisfied', assessment: 'done', next_tasks: [] } };
  const failed = refreshTaskDependencies(job([satisfied, { ...task('failed', 'FAILED'), error: 'unresolved' }]));
  const blocked = refreshTaskDependencies(job([satisfied, { ...task('blocked', 'BLOCKED') }]));
  assert.equal(failed.state, 'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(failed, 'OPEN'), 'FAILED');
  assert.equal(blocked.state, 'ACTIVE');
  assert.equal(deriveJobRuntimeStatus(blocked, 'OPEN'), 'BLOCKED');
});


test('story sizes map only the overall execution timeout', () => {
  assert.equal(storySizeTimeoutMs('S'),300000);
  assert.equal(storySizeTimeoutMs('M'),900000);
  assert.equal(storySizeTimeoutMs('L'),2700000);
  assert.equal(taskOverallTimeoutMs('M','high'),1800000);
  assert.equal(taskOverallTimeoutMs('L','high'),5400000);
  assert.equal(taskOverallTimeoutMs('M','medium'),900000);
  assert.equal(chatGptStartAckTimeoutMs(300000),120000);
  assert.equal(chatGptStartAckTimeoutMs(900000),300000);
  assert.equal(chatGptStartAckTimeoutMs(2700000),600000);
  assert.equal(chatGptStartAckTimeoutMs(1800000),600000);
  const sized=parsePlannerResult({objective_status:'in_progress',assessment:'size',next_tasks:[{title: 'Implement and verify durable task outputs', id:'large',input:'work',adapter:'codex',output:{kind:'task_pr'},storySize:'L'}]});
  assert.equal(sized.next_tasks[0].storySize,'L');
  assert.equal(sized.next_tasks[0].timeoutMs,2700000);
  const defaulted=parsePlannerResult({objective_status:'in_progress',assessment:'default',next_tasks:[{title: 'Implement and verify durable task outputs', id:'medium',input:'work',adapter:'codex',output:{kind:'task_pr'}}]});
  assert.equal(defaulted.next_tasks[0].storySize,'M');
  assert.equal(defaulted.next_tasks[0].timeoutMs,900000);
});


test('planner doubles story-size timeout only for high reasoning', () => {
  const high=parsePlannerResult({objective_status:'in_progress',assessment:'high',next_tasks:[{title: 'Implement and verify durable task outputs', id:'high',input:'work',adapter:'codex',output:{kind:'task_pr'},storySize:'M',routing:{provider:'openai',model:'gpt-test',reasoning:'high',decidedBy:'test',decidedAt:new Date().toISOString()}}]});
  assert.equal(high.next_tasks[0].timeoutMs,1800000);
  const normal=parsePlannerResult({objective_status:'in_progress',assessment:'normal',next_tasks:[{title: 'Implement and verify durable task outputs', id:'normal',input:'work',adapter:'codex',output:{kind:'task_pr'},storySize:'M',routing:{provider:'openai',model:'gpt-test',reasoning:'medium',decidedBy:'test',decidedAt:new Date().toISOString()}}]});
  assert.equal(normal.next_tasks[0].timeoutMs,900000);
});


test('planner parser rejects malformed Agent Graph before child materialization', () => {
  assert.throws(() => parsePlannerResult({
    objective_status: 'in_progress',
    assessment: 'work',
    next_tasks: [{title: 'Implement and verify durable task outputs',  id: 'bad-graph', input: 'work', output: { kind: 'task_pr' }, agentGraph: 'graph LR\na --> b' }],
  }), /next_tasks\[0\]\.agentGraph is invalid: Agent Graph must start with Mermaid flowchart/);
});


test('planner instruction contract forbids self-cycles in optional agent graphs', async () => {
  const prompt = await readFile(new URL('../skills/agents-relay/agents/planner.agent.md', import.meta.url), 'utf8');
  assert.match(prompt, /agentGraph.*optional/i);
  assert.match(prompt, /do \*\*not\*\* create an edge from an agent\/node to itself/);
  assert.throws(() => parsePlannerResult({ objective_status: 'in_progress', assessment: 'x', next_tasks: [{title: 'Implement and verify durable task outputs',  id: 'work', input: 'work', storySize: 'S', output: { kind: 'task_pr' }, agentGraph: 'flowchart LR\n  implementation --> implementation' }] }), /Agent Graph self-cycle at implementation/);
});


test('Planner validation feedback identifies missing Resolution and a corrected recovery child passes', () => {
  const original=task('34','FAILED');
  const child=spec('35');
  assert.throws(()=>validatePlannerResolutionMaterialization([original],[child]), error =>
    error.message.includes('34') && error.message.includes('same_job_dependency') && error.message.includes('targetTaskId'));
  const corrected={...child,resolution:{path:'same_job_dependency',targetTaskId:'34',rootCause:'worker failure',solution:'retry via a recovery child'}};
  assert.doesNotThrow(()=>validatePlannerResolutionMaterialization([original],[corrected]));
});


test('plan apply rejects invalid tree and corrects inside same durable Plan', async () => {
  const root = job([]);
  const round = createPlanRound(root, { manual: true });
  round.executionId = 'execution-1'; round.leaseOwner = 'planner-test';
  root.plans = [round];
  const store = new InMemoryStore(root);
  const reconciler = managedReconciler(store, { owner: 'planner-test', adapters: [{ name: 'codex', id: 'planner-test-worker', capabilities: [] }], maxConcurrent: 0 });
  const invalid = { objective_status: 'in_progress', assessment: 'Implement missing acceptance', next_tasks: [{ id: 'one', title: 'Implement and verify durable task outputs', input: 'real workflow tests', storySize: 'M' }] };
  await assert.rejects(() => reconciler.applyPlannerTree('auto', round.id, 'execution-1', invalid), /output is required/);
  let saved = await store.load('auto');
  assert.equal(saved.plans[0].status, 'PLANNING');
  assert.equal(saved.plans[0].attempt, 0);
  assert.equal(saved.tasks.length, 0);
  const accepted = { ...invalid, next_tasks: [{ ...invalid.next_tasks[0], output: { kind: 'task_pr' } }] };
  const committed = await reconciler.applyPlannerTree('auto', round.id, 'execution-1', accepted);
  saved = await store.load('auto');
  assert.equal(committed.status, 'SUCCEEDED');
  assert.equal(saved.plans.length, 1);
  assert.equal(saved.tasks.length, 1);
  assert.deepEqual(saved.plans[0].generatedTaskIds, [saved.tasks[0].id]);
  assert.equal((await reconciler.applyPlannerTree('auto', round.id, 'execution-1', accepted)).status, 'SUCCEEDED', 'identical successful commit is idempotent');
  await assert.rejects(() => reconciler.applyPlannerTree('auto', round.id, 'execution-1', { ...accepted, assessment: 'different candidate' }), /already committed a different candidate/);
  assert.equal((await store.load('auto')).tasks.length, 1);
  await reconciler.close();
});
