import { buildReferenceFirstPrompt, renderAgentPrompt } from './agent-prompt-builder.js';
import { readFile } from 'node:fs/promises';
import { parseTestInjection } from './e2e-injection.js';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve as resolvePath } from 'node:path';
import { Job, Plan, Priority, StorySize, Task, AdapterName, RoutingDecision, TaskOutput, PlanningDecisionSource, PlanTrigger, storySizeTimeoutMs, taskOverallTimeoutMs, WorkerRequirements, ReviewTaskMetadata, TaskResolutionProposal } from './types.js';
import { unresolvedTask } from './workflow/task-resolution.js';
import { ExecutionContext, executionContextPrompt, BUNDLED_AGENTS_ROOT } from './execution-context.js';
import { resolveAgentMarkdown } from './agent-content-resolver.js';
import { parseAgentGraph, validateAgentSelection } from './agent-graph.js';
import { dispatchPlannerTrigger } from './workflow/planner-trigger-v2.js';
import { createTaskEntity } from './workflow/entity-creation.js';
import { prepareReviewerThreadDelivery, chatgptThreadRequirements } from './reviewer-thread.js';
import { spawnOwnedProcess } from './owned-process.js'; import { requiredPlannerTaskTitle } from './planner-task-title.js';
import { parsePlannerHistoryCleanup, type PlannerHistoryCleanup } from './planner-history-cleanup.js';
import { plannerTaskContext } from './planner-task-context.js';
import { relayStoreDirectory } from './local-job-path.js';

export type ObjectiveStatus = 'in_progress' | 'satisfied';
export type PlannerTaskSpec = {
  id: string;
  title?: string;
  parentTaskId?: string | null;
  input: string;
  priority?: Priority;
  storySize?: StorySize;
  projectName?: string;
  agentName?: string;
  agentGraph?: string;
  review?: ReviewTaskMetadata;
  dependencies?: string[];
  capabilities?: string[];
  workerRequirements?: WorkerRequirements;
  testInjection?: Task['testInjection'];
  adapter?: AdapterName;
  output?: TaskOutput;
  routing?: RoutingDecision;
  continuation?: Task['continuation'];
  maxAttempts?: number;
  timeoutMs?: number;
  resolution?: TaskResolutionProposal;
};
export type PlannerUnblockSpec = { repository: string; prNumber: number; jobId: string; taskId: string; resolutionMode?: 'merge' | 'verified' };
export type PlannerResult = { objective_status: ObjectiveStatus; assessment: string; next_tasks: PlannerTaskSpec[]; unblocks: PlannerUnblockSpec[]; history_cleanup?: PlannerHistoryCleanup[]; cliApplied?: true };
export type PlannerContext = { planExecution?: { planId: string; executionId: string }; forceRestate?: boolean; restateTaskIds?: readonly string[]; job: Job; tasks: readonly Task[]; objective: string; previousPlannerTaskId: string | null; trigger?: PlanTrigger; executionContext?: ExecutionContext; retryFeedback?: string; guidance?: string };
export type SemanticTaskTreeEntry = { id: string; title?: string; parent_task_id: string | null; state: Task['state']; dependencies: string[]; planning_decision_id?: string; planning_round?: number; review?: ReviewTaskMetadata; resolution_classification?: Task['resolutionClassification'] };

export function semanticTaskTree(tasks: readonly Task[]): { roots: string[]; tasks: SemanticTaskTreeEntry[] } {
  const work = tasks.filter(task => task.kind !== 'planner');
  const ids = new Set(work.map(task => task.id));
  return {
    roots: work.filter(task => !task.parentTaskId || !ids.has(task.parentTaskId)).map(task => task.id),
    tasks: work.map(task => ({ id: task.id, title: task.title, parent_task_id: task.parentTaskId, state: task.state, dependencies: [...task.dependencies], planning_decision_id: task.planningDecisionId, planning_round: task.planningRound, review: task.review, resolution_classification: task.resolutionClassification })),
  };
}

export interface ObjectivePlanner { plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult>; }
export type PlannerRoundOptions = { guidance?: string; manual?: boolean; timeoutMs?: number; now?: string };

function plannerTrigger(job: Job, manual = false): PlanTrigger {
  const consumed = new Set((job.plans ?? []).filter(plan => plan.status === 'SUCCEEDED').flatMap(plan => plan.trigger.source === 'unblock' ? plan.trigger.taskIds ?? [] : []));
  const unblocked = job.tasks.filter(task => ['DRAFT', 'QUEUED'].includes(task.state) && task.unblock && !consumed.has(task.id));
  const hasUnblock = unblocked.length > 0 || Boolean(job.changeCycle && !job.changeCycle.consumedByPlannerTaskId);
  const decision = dispatchPlannerTrigger({
    manualPlan: manual && !hasUnblock,
    hasUnblock,
    scheduledRun: Boolean(job.schedule?.currentRunSlot),
    initialPlan: (job.plans?.length ?? 0) === 0 && !job.tasks.some(task => task.kind === 'planner'),
  });
  if (!decision.accepted) throw new Error('Planner trigger graph rejected plan.requested');
  const source = decision.target as PlanTrigger['source'];

  if (source === 'manual') return { source: 'manual' };
  if (source === 'unblock') {
    if (unblocked.length > 0) {
      const records = unblocked.map(task => task.unblock!);
      const blockedHeadShas = [...new Set(records.map(record => record.baseline.headSha).filter((value): value is string => Boolean(value)))];
      return {
        source: 'unblock', taskIds: unblocked.map(task => task.id),
        reason: [...new Set(records.map(record => record.reason))].join('; '),
        blockedHeadShas,
        currentHeadSha: records.map(record => record.currentHeadSha).find((value): value is string => Boolean(value)),
        unblockSource: records[0].source,
        facts: [...new Set(records.flatMap(record => record.facts ?? ['unblock: ' + record.reason]))],
      };
    }
    const cycle = job.changeCycle;
    if (!cycle || cycle.consumedByPlannerTaskId) throw new Error('Planner trigger graph selected unblock without unblock facts');
    return { source: 'unblock', taskIds: cycle.taskIds, reason: cycle.reason, facts: cycle.facts, blockedHeadShas: cycle.baselineHeadShas, currentHeadSha: cycle.currentHeadSha, unblockSource: cycle.source };
  }
  if (source === 'schedule') return { source: 'schedule' };
  if (source === 'initial') return { source: 'initial' };
  return { source: 'continuation' };
}

export function plannerRoundNumber(task: Task): number | null {
  if (task.kind !== 'planner') return null;
  if (Number.isInteger(task.planningRound) && (task.planningRound ?? 0) > 0) return task.planningRound as number;
  const match = /^(?:plan|planner)-(\d+)$/.exec(task.id);
  return match ? Number(match[1]) : null;
}

function latestLegacyPlanner(job: Job): Task | undefined {
  return job.tasks.filter(task => task.kind === 'planner')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
}

export function createPlanRound(job: Job, options: PlannerRoundOptions = {}): Plan {
  const plans = [...(job.plans ?? [])].sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
  const legacy = job.tasks.filter(task => task.kind === 'planner');
  const used = new Set([...job.tasks.map(task => task.id), ...plans.map(plan => plan.id)]);
  let round = Math.max(0, ...plans.map(plan => plan.round), ...legacy.map(task => plannerRoundNumber(task) ?? 0)) + 1;
  let id = `plan-${round}`;
  while (used.has(id)) { round += 1; id = `plan-${round}`; }
  const previousPlan = plans.at(-1);
  const previousLegacy = previousPlan ? undefined : latestLegacyPlanner(job);
  const previousPlanId = previousPlan?.id ?? previousLegacy?.id ?? null;
  const now = options.now ?? new Date().toISOString();
  const trigger = plannerTrigger(job, options.manual === true);
  return {
    jobId: job.id, id, round, source: 'model-planner', previousPlanId, trigger,
    status: 'PLANNING', guidance: options.guidance, assessment: 'Planning in progress.', generatedTaskIds: [],
    headSha: trigger.currentHeadSha ?? job.headSha,
    attempt: 0, maxAttempts: options.manual ? 1 : 3, leaseOwner: null, leaseExpiresAt: null, executionId: null,
    timeoutMs: options.timeoutMs ?? storySizeTimeoutMs('M'), manualPlanning: options.manual === true,
    createdAt: now, updatedAt: now,
  };
}

export function pendingPlan(job: Job): Plan | null {
  return [...(job.plans ?? [])].filter(plan => plan.status === 'PLANNING').sort((a, b) => a.round - b.round)[0] ?? null;
}

export function materializePlannerChild(job: Job, planner: Plan | Task, spec: PlannerTaskSpec, executionContext: ExecutionContext): Task {
  validateAgentSelection(executionContext, spec.agentName, spec.agentGraph);
  const now = new Date().toISOString();
  const decisionId = 'round' in planner ? planner.id : planner.id;
  const source = 'round' in planner ? planner.source : planner.planningSource ?? 'model-planner';
  const round = 'round' in planner ? planner.round : planner.planningRound ?? 1;
  const plannerHeadSha = 'round' in planner ? planner.headSha : undefined;
  const reviewHeadSha = spec.agentName === 'reviewer' && !(spec.dependencies?.length) ? plannerHeadSha ?? job.headSha : undefined;
  const objectiveRoot = spec.agentName === 'reviewer' ? job.tasks.find(task => task.kind !== 'planner' && task.agentName !== 'reviewer' && task.agentName !== 'troubleshooter' && !task.parentTaskId) : undefined;
  const resolution = spec.resolution;
  if (resolution) {
    const target = resolution.targetTaskId ? job.tasks.find(task => task.id === resolution.targetTaskId) : undefined;
    if (!target || !unresolvedTask(target)) throw new Error(`Planner resolution for ${spec.id} must target one unresolved durable Task`);
  }
  const reviewerThread = spec.agentName === 'reviewer' ? prepareReviewerThreadDelivery(job, { id: spec.id, agentName: spec.agentName, reviewHeadSha }) : undefined, implementationThread = (spec.agentName === 'implementation' || spec.agentName == null) && job.implementationThreadId ? job.implementationThreadId : undefined, threadOwned = Boolean(reviewerThread || implementationThread);
  return createTaskEntity(job, { jobId: job.id, id: spec.id, title: spec.agentName === 'reviewer' ? 'Review' : spec.title, kind: 'work', priority: spec.priority ?? job.priority, storySize: spec.storySize ?? 'M', projectName: spec.projectName, agentName: spec.agentName, agentGraph: spec.agentGraph, review: spec.review, parentTaskId: objectiveRoot?.id ?? spec.parentTaskId ?? null, dependencies: spec.dependencies ?? [], capabilities: spec.capabilities ?? [], workerRequirements: threadOwned ? chatgptThreadRequirements(spec.workerRequirements) : spec.workerRequirements, testInjection: spec.testInjection, adapter: threadOwned ? 'chatgpt' : (spec.adapter ?? 'codex'), chatgptThreadDelivery: reviewerThread, input: spec.input, output: spec.output, continuation: spec.continuation ?? null, continuationDeliveredAt: null, attempt: 0, maxAttempts: spec.maxAttempts ?? 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null, result: null, plannerResult: null, error: null, timeoutMs: spec.timeoutMs ?? taskOverallTimeoutMs(spec.storySize ?? 'M'), createdAt: now, updatedAt: now, planningDecisionId: decisionId, planningSource: source, planningRound: round, reviewHeadSha, resolution: resolution ? { ...resolution, state: 'proposed', owner: 'planner', updatedAt: now } : undefined });
}

export function planningSpec(task: Task): PlannerTaskSpec {
  if (!task.output) throw new Error(`Initial task ${task.id} requires an output contract`);
  if (!['codex', 'chatgpt'].includes(task.adapter)) throw new Error(`Initial task ${task.id} requires a supported worker adapter`);
  return { id: task.id, title: task.title, parentTaskId: task.parentTaskId, input: task.input, priority: task.priority, storySize: task.storySize, projectName: task.projectName, agentName: task.agentName, agentGraph: task.agentGraph, review: task.review, dependencies: task.dependencies, capabilities: task.capabilities, workerRequirements: task.workerRequirements, testInjection: task.testInjection, adapter: task.adapter, output: task.output ?? { kind: 'task_pr' }, routing: task.routing, continuation: task.continuation, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs, resolution: task.resolution ? { ...task.resolution, state: undefined, owner: undefined, updatedAt: undefined } as unknown as TaskResolutionProposal : undefined };
}

function record(value: unknown, field = 'result'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Planner ${field} must be an object`);
  return value as Record<string, unknown>;
}
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`Planner ${field} must be a non-empty string`);
  return value;
}
function stringArray(value: unknown, field: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) throw new Error(`Planner ${field} must be an array of non-empty strings`);
  return [...value];
}
function workerRequirements(value: unknown, field: string): WorkerRequirements | undefined {
  if (value === undefined || value === null) return undefined;
  const root = record(value, field);
  const capabilities = stringArray(root.capabilities, `${field}.capabilities`);
  const optional = (name: string): string | undefined => optionalString(root[name], `${field}.${name}`);
  const labelsValue = root.labels;
  let labels: Record<string, string> | undefined;
  if (labelsValue !== undefined) {
    if (!labelsValue || typeof labelsValue !== 'object' || Array.isArray(labelsValue)) throw new Error(`Planner ${field}.labels must be an object`);
    labels = {};
    for (const [key, item] of Object.entries(labelsValue)) {
      if (typeof item !== 'string' || item.length === 0) throw new Error(`Planner ${field}.labels values must be non-empty strings`);
      labels[key] = item;
    }
  }
  return { capabilities, runtime: optional('runtime'), taskKind: optional('taskKind'), trustDomain: optional('trustDomain'), region: optional('region'), labels };
}
function reviewMetadata(value: unknown, field: string): ReviewTaskMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  const root = record(value, field);
  if (root.role !== 'chair' && root.role !== 'specialist') throw new Error(`Planner ${field}.role must be chair or specialist`);
  const targetValue = record(root.target, `${field}.target`);
  const artifact = optionalString(targetValue.artifact, `${field}.target.artifact`);
  const version = optionalString(targetValue.version, `${field}.target.version`);
  if (!artifact || !version) throw new Error(`Planner ${field}.target requires artifact and version`);
  const dimension = optionalString(root.dimension, `${field}.dimension`);
  const selectionReason = optionalString(root.selectionReason, `${field}.selectionReason`);
  if (root.role === 'specialist' && (!dimension || !selectionReason)) {
    throw new Error(`Planner ${field} specialist tasks require dimension and selectionReason`);
  }
  const round = root.round === undefined ? undefined : root.round;
  if (round !== undefined && (!Number.isInteger(round) || Number(round) < 1)) throw new Error(`Planner ${field}.round must be a positive integer`);
  return { role: root.role, target: { artifact, version }, dimension, selectionReason, round: round === undefined ? undefined : Number(round) };
}
function rawValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === undefined) return 'undefined';
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}
export function normalizePlannerPriority(value: unknown, field: string): Priority {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 3) return `P${value}` as Priority;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (/^P[0-3]$/i.test(normalized)) return normalized.toUpperCase() as Priority;
    if (/^[0-3]$/.test(normalized)) return `P${normalized}` as Priority;
  }
  throw new Error(`Planner ${field} is invalid: ${rawValue(value)}`);
}
function routing(value: unknown, field: string): RoutingDecision | undefined {
  if (value === undefined || value === null) return undefined;
  const route = record(value, field);
  for (const key of ['provider', 'model', 'decidedBy', 'decidedAt']) if (typeof route[key] !== 'string' || String(route[key]).length === 0) throw new Error(`Planner ${field}.${key} is required`);
  return { provider: route.provider as string, model: route.model as string, profile: optionalString(route.profile, `${field}.profile`), reasoning: optionalString(route.reasoning, `${field}.reasoning`), cwd: optionalString(route.cwd, `${field}.cwd`), projectId: optionalString(route.projectId, `${field}.projectId`), decidedBy: route.decidedBy as string, decidedAt: route.decidedAt as string };
}
function resolutionProposal(value: unknown, field: string): TaskResolutionProposal | undefined {
  if (value === undefined || value === null) return undefined;
  const root = record(value, field);
  const path = root.path;
  if (typeof path !== 'string' || !['exact_original_retry','same_job_dependency','blocker_job_dependency','escalation_gate','cancel_supersede'].includes(path)) throw new Error(`Planner ${field}.path is invalid`);
  const stringField = (name: string): string | undefined => optionalString(root[name], `${field}.${name}`);
  const mode = root.mode === undefined ? undefined : String(root.mode);
  if (mode !== undefined && mode !== 'merge' && mode !== 'verified') throw new Error(`Planner ${field}.mode must be merge or verified`);
  const list = (name: string): string[] | undefined => root[name] === undefined ? undefined : stringArray(root[name], `${field}.${name}`);
  return { path: path as TaskResolutionProposal['path'], targetTaskId: stringField('targetTaskId'), targetJobId: stringField('targetJobId'), mode: mode as 'merge' | 'verified' | undefined, rootCause: stringField('rootCause'), solution: stringField('solution'), deviations: list('deviations'), validationEvidence: list('validationEvidence') };
}

export function parsePlannerResult(value: unknown): PlannerResult {
  const root = record(value, 'result');
  const status = root.objective_status;
  if (status !== 'in_progress' && status !== 'satisfied') throw new Error('Planner objective_status must be in_progress or satisfied');
  if (typeof root.assessment !== 'string') throw new Error('Planner assessment must be a string');
  if (!Array.isArray(root.next_tasks)) throw new Error('Planner next_tasks must be an array');
  const unblockKeys = new Set<string>();
  const unblocksRaw = root.unblocks === undefined ? [] : root.unblocks;
  if (!Array.isArray(unblocksRaw)) throw new Error('Planner unblocks must be an array when provided');
  const unblocks = unblocksRaw.map((item, index): PlannerUnblockSpec => {
    const unblock = record(item, `unblocks[${index}]`);
    const repository = optionalString(unblock.repository, `unblocks[${index}].repository`);
    const jobId = optionalString(unblock.jobId, `unblocks[${index}].jobId`);
    const taskId = optionalString(unblock.taskId, `unblocks[${index}].taskId`);
    if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new Error(`Planner unblocks[${index}].repository must be OWNER/REPO`);
    if (!jobId) throw new Error(`Planner unblocks[${index}].jobId is required`);
    if (!taskId) throw new Error(`Planner unblocks[${index}].taskId is required`);
    const prNumber = unblock.prNumber;
    if (!Number.isInteger(prNumber) || Number(prNumber) <= 0) throw new Error(`Planner unblocks[${index}].prNumber must be a positive integer`);
    const resolutionMode = unblock.resolutionMode === undefined ? undefined : String(unblock.resolutionMode);
    if (resolutionMode !== undefined && resolutionMode !== 'merge' && resolutionMode !== 'verified') throw new Error(`Planner unblocks[${index}].resolutionMode must be merge or verified`);
    const key = `${repository}#${prNumber}:${jobId}:${taskId}`;
    if (unblockKeys.has(key)) throw new Error(`Planner unblocks contains duplicate dependent ${key}`);
    unblockKeys.add(key);
    return { repository, prNumber: Number(prNumber), jobId, taskId, resolutionMode: resolutionMode as 'merge' | 'verified' | undefined };
  });
  const history_cleanup = parsePlannerHistoryCleanup(root.history_cleanup);
  const ids = new Set<string>();
  const next_tasks = root.next_tasks.map((item, index): PlannerTaskSpec => {
    const task = record(item, `next_tasks[${index}]`);
    const id = task.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`Planner next_tasks[${index}].id is required`);
    if (ids.has(id)) throw new Error(`Planner next_tasks contains duplicate id ${id}`);
    ids.add(id);
    if (typeof task.input !== 'string' || task.input.length === 0) throw new Error(`Planner next_tasks[${index}].input is required`);
    const parentTaskId = task.parentTaskId === undefined || task.parentTaskId === null ? task.parentTaskId as undefined | null : optionalString(task.parentTaskId, `next_tasks[${index}].parentTaskId`);
    const adapter = task.adapter;
    if (adapter !== undefined && !['codex', 'chatgpt'].includes(String(adapter))) throw new Error(`Planner next_tasks[${index}].adapter must be codex or chatgpt when provided`);
    const output = task.output === undefined ? undefined : record(task.output, `next_tasks[${index}].output`);
    if (!output || (output.kind !== 'task_pr' && output.kind !== 'file')) throw new Error(`Planner next_tasks[${index}].output is required`);
    if (output.kind === 'file' && (typeof output.path !== 'string' || output.path.length === 0)) throw new Error(`Planner next_tasks[${index}].output.path is required for file output`);
    const priority = task.priority === undefined ? undefined : normalizePlannerPriority(task.priority, `next_tasks[${index}].priority`);
    const sizeValue = task.storySize === undefined ? 'M' : String(task.storySize).toUpperCase();
    if (!['S','M','L'].includes(sizeValue)) throw new Error('Planner next_tasks[' + index + '].storySize must be S, M, or L');
    const storySize = sizeValue as StorySize;
    const maxAttempts = task.maxAttempts === undefined ? 3 : task.maxAttempts;
    const route = routing(task.routing, 'next_tasks[' + index + '].routing');
    const requirements = workerRequirements(task.workerRequirements ?? task.requirements, 'next_tasks[' + index + '].workerRequirements');
    const agentGraph = optionalString(task.agentGraph, `next_tasks[${index}].agentGraph`);
    const review = reviewMetadata(task.review, `next_tasks[${index}].review`);
    if (agentGraph) {
      try {
        parseAgentGraph(agentGraph);
      } catch (error) {
        throw new Error(`Planner next_tasks[${index}].agentGraph is invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const timeoutMs = task.timeoutMs === undefined ? taskOverallTimeoutMs(storySize, route?.reasoning) : task.timeoutMs;
    if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`Planner next_tasks[${index}].maxAttempts is invalid`);
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`Planner next_tasks[${index}].timeoutMs is invalid`);
    return {
      id, title: requiredPlannerTaskTitle(task.title, index), parentTaskId, input: task.input, priority, storySize,
      projectName: optionalString(task.projectName, 'projectName'), agentName: optionalString(task.agentName, 'agentName'), agentGraph, review,
      dependencies: stringArray(task.dependencies, 'dependencies'), capabilities: stringArray(task.capabilities, 'capabilities'), workerRequirements: requirements,
      testInjection: parseTestInjection(task.testInjection ?? task['--test-injection']) ?? optionalString(task.testInjection ?? task['--test-injection'], `next_tasks[${index}].--test-injection`),
      adapter: adapter as AdapterName | undefined, output: output as TaskOutput, routing: route,
      continuation: task.continuation as Task['continuation'], maxAttempts, timeoutMs, resolution: resolutionProposal(task.resolution, `next_tasks[${index}].resolution`)
    };
  });
  return { objective_status: status, assessment: root.assessment, next_tasks, unblocks, ...(history_cleanup ? { history_cleanup } : {}) };
}


export function validatePlannerProgress(job: Job, result: PlannerResult): void {
  if (result.objective_status !== 'in_progress' || result.next_tasks.length > 0 || result.unblocks.length > 0) return;
  const previousReviewFinished = job.tasks.some(task => task.agentName === 'reviewer' && task.state === 'SUCCEEDED');
  if (previousReviewFinished) return;
  const liveWork = job.tasks.some(task => task.kind !== 'planner' && !['SUCCEEDED','FAILED','CANCELLED'].includes(task.state));
  if (liveWork) return;
  throw new Error('Planner returned in_progress with no executable tasks or unblocks while no live work remains; return satisfied when only Relay-owned review/merge/completion effects remain');
}

export function validatePlannerLifecycleOwnership(job: Job, specs: readonly PlannerTaskSpec[]): void {
  if (!job.localMerge?.sourceRef) return;
  for (const spec of specs) {
    // Restrict ownership detection to an individual imperative clause. A long
    // implementation brief may describe Relay-owned completion as context.
    const clauses = spec.input.toLowerCase().split(/[.!?\n]+/);
    for (const clause of clauses) {
      if (/\b(?:relay|graph|orchestrator)\s+(?:must|will|should|owns?)\b/.test(clause)) continue;
      const localMerge = /\blocal[ -]merge\b|\blocal merge\b/.test(clause);
      const jobCompletion = /\bjob\b.{0,80}\bcompleted\b|\bcompleted\b.{0,80}\bjob\b/.test(clause);
      const externalMerge = /\b(?:external|github|projected)\b.{0,80}\bpr\b.{0,80}\bmerged\b|\bpr\b.{0,80}\bmerged\b/.test(clause);
      const ownsLifecycle = /^\s*(?:perform|execute|complete|trigger|drive|merge|transition|finish|finalize)\b/.test(clause);
      if (ownsLifecycle && [localMerge, jobCompletion, externalMerge].filter(Boolean).length >= 2) {
        throw new Error(`Planner next task ${spec.id} attempts to own Graph lifecycle delivery; local merge, Job COMPLETED, and projected PR merge are Relay-owned effects and must not be worker Tasks`);
      }
      const releaseEffect = /\b(?:publish|release|deploy)\b.{0,100}\b(?:package|npm|service|runtime|version)\b|\b(?:package|npm|service|runtime)\b.{0,100}\b(?:publish|release|deploy)\b/.test(clause);
      const releaseImperative = /^\s*(?:publish|release|deploy)\b|\b(?:then|and)\s+(?:publish|release|deploy)\b/.test(clause);
      if (releaseEffect && releaseImperative) {
        throw new Error(`Planner next task ${spec.id} attempts to own Relay release delivery; package publication and service/runtime deployment are Relay-owned effects and must not be worker Tasks`);
      }
    }
  }
}

export function validatePlannerHierarchy(existing: readonly Task[], specs: readonly PlannerTaskSpec[]): void {
  const existingById = new Map(existing.map(task => [task.id, task]));
  const specsById = new Map(specs.map(spec => [spec.id, spec]));
  for (const spec of specs) {
    const parent = spec.parentTaskId;
    if (!parent) continue;
    if (parent === spec.id) throw new Error(`Planner next task ${spec.id} cannot parent itself`);
    const existingParent = existingById.get(parent);
    if (existingParent?.kind === 'planner') throw new Error(`Planner next task ${spec.id} cannot use planner round ${parent} as parentTaskId`);
    if (!existingParent && !specsById.has(parent)) throw new Error(`Planner next task ${spec.id} references unknown parentTaskId ${parent}`);
  }
  for (const spec of specs) {
    const seen = new Set<string>([spec.id]);
    let parent = spec.parentTaskId ?? null;
    while (parent && specsById.has(parent)) {
      if (seen.has(parent)) throw new Error(`Planner next_tasks parentTaskId cycle includes ${parent}`);
      seen.add(parent);
      parent = specsById.get(parent)?.parentTaskId ?? null;
    }
  }
}

/** Planner may only materialize a new business Task while unresolved work is either
 * explicitly resolved in this round or already owned by an active resolution path. */
export function validatePlannerResolutionMaterialization(existing: readonly Task[], specs: readonly PlannerTaskSpec[]): void {
  const unresolved = existing.filter(task => unresolvedTask(task) && ['FAILED', 'BLOCKED'].includes(task.state) && !task.resolutionClassification);
  if (unresolved.length === 0) return;
  const resolvedIds = new Set(specs.map(spec => spec.resolution?.targetTaskId).filter((id): id is string => Boolean(id)));
  const owned = unresolved.filter(task => task.resolution && ['active', 'waiting'].includes(task.resolution.state));
  const uncovered = unresolved.filter(task => !resolvedIds.has(task.id) && !owned.some(candidate => candidate.id === task.id));
  if (uncovered.length > 0 && specs.length > 0) throw new Error(`Planner cannot create sibling replacement work while unresolved Task(s) lack a graph resolution: ${uncovered.map(task => task.id).join(', ')}. Correct next_tasks by adding resolution: {"path":"same_job_dependency","targetTaskId":"<unresolved original task id>","rootCause":"<evidence>","solution":"<how new task resolves original>"} to each relevant recovery Task. The targetTaskId must refer to the FAILED/BLOCKED original, not the new Task. Do not bypass this check or mark work satisfied without evidence.`);
}

export function parsePlannerOutput(output: string): PlannerResult {
  const trimmed = output.trim();
  const candidate = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return parsePlannerResult(JSON.parse(candidate) as unknown);
}

function boundedText(value: string | null | undefined, max = 4000): string | null | undefined {
  if (value === null || value === undefined || value.length <= max) return value;
  return value.slice(0, max) + `\n...[truncated ${value.length - max} chars]`;
}

export function plannerInput(context: PlannerContext): string {
  const visibleAgents = context.executionContext?.agents.map(agent => ({
    name: agent.name,
    description: boundedText(agent.description, 1000),
    capabilities: agent.capabilities,
    boundaries: agent.restrictions,
    runtime: agent.runtime,
  }));
  const project = context.executionContext?.project;
  return JSON.stringify({
    objective: context.objective,
    apply_cli: context.planExecution ? `agents-relay plan apply --repo ${context.job.repository} --pr ${context.job.prNumber} --id ${context.job.id} --plan-id ${context.planExecution.planId} --execution-id ${context.planExecution.executionId} --file PATH` : undefined,
    plan_execution: context.planExecution, retry_feedback: context.retryFeedback,
    caller_prompt: context.guidance,
    force_restate: context.forceRestate === true,
    restate_task_ids: context.restateTaskIds ?? [],
    previous_planner_task_id: context.previousPlannerTaskId,
    plan_trigger: context.trigger,
    legacy_change_cycle: context.job.changeCycle,
    semantic_task_tree: semanticTaskTree(context.tasks),
    plans: (context.job.plans ?? []).map(plan => ({
      id: plan.id,
      round: plan.round,
      status: plan.status,
      source: plan.source,
      previous_plan_id: plan.previousPlanId,
      trigger: plan.trigger,
      objective_status: plan.objectiveStatus,
      assessment: boundedText(plan.assessment),
      generated_task_ids: plan.generatedTaskIds,
      error: boundedText(plan.error, 2000),
    })),
    project: project ? { name: project.name, path: project.path } : undefined,
    visible_agents: visibleAgents ?? [],
    tasks: context.tasks.map(task => ({ ...plannerTaskContext(task), planner_result: task.plannerResult ? {
      objective_status: task.plannerResult.objective_status,
      assessment: boundedText(task.plannerResult.assessment),
      next_task_ids: task.plannerResult.next_tasks.map(item => item.id),
    } : undefined })),
  });
}

export class CommandObjectivePlanner implements ObjectivePlanner {
  constructor(private readonly command: string) { if (!command) throw new Error('Planner command is required'); }
  async plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult> {
    return await new Promise<PlannerResult>((resolve, reject) => {
      const child = spawnOwnedProcess(this.command, [], { invocation: 'planner.command', signal, correlation: { jobId: context.job.id }, spawn: { stdio: ['pipe', 'pipe', 'pipe'] } });
      let stdout = ''; let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? (() => { const expected = context.planExecution ? `PLAN_APPLIED:${context.planExecution.planId}:${context.planExecution.executionId}` : ''; if (stdout.trim() !== expected || !expected) { reject(new Error('Planner command must commit its proposal through agents-relay plan apply and return the matching PLAN_APPLIED receipt')); return; } resolve({ objective_status: 'satisfied', assessment: 'Plan committed through the authorized CLI action.', next_tasks: [], unblocks: [], cliApplied: true }); })() : reject(new Error(stderr.trim() || `Planner exited ${code}`)));
      child.stdin?.end(plannerInput(context));
    });
  }
}

const DEFAULT_PLANNER_AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agents-relay', 'agents', 'planner.agent.md');
const DEFAULT_TASK_JOB_CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agents-relay', 'contracts', 'task-job-contract.md');

export function buildPlannerCodexArgs(storeDirectory: string, input: string): string[] {
  return ['exec', '--json', '--sandbox', 'workspace-write', '--add-dir', resolvePath(dirname(storeDirectory)),
    '-c', 'sandbox_workspace_write.network_access=true', '--', input];
}

function parsePlannerAgentMessage(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const item = value.item as Record<string, unknown> | undefined;
    if (value.type === 'item.completed' && item?.type === 'agent_message' && typeof item.text === 'string') return item.text.trim() || undefined;
    const payload = value.payload as Record<string, unknown> | undefined;
    if (value.type === 'event_msg' && payload?.type === 'task_complete' && typeof payload.last_agent_message === 'string') return payload.last_agent_message.trim() || undefined;
  } catch { /* ignore non-JSON runtime diagnostics */ }
  return undefined;
}
export class AgentObjectivePlanner implements ObjectivePlanner {
  constructor(private readonly command = 'codex', private readonly agentFile = DEFAULT_PLANNER_AGENT) {}
  async plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult> {
    const effectivePlanner = context.executionContext ? await resolveAgentMarkdown('planner', BUNDLED_AGENTS_ROOT, context.executionContext.project.path) : undefined;
    const instructions = effectivePlanner?.content ?? await readFile(this.agentFile, 'utf8');
    const contract = await readFile(DEFAULT_TASK_JOB_CONTRACT, 'utf8');
    const resolvedContext = context.executionContext ? executionContextPrompt(context.executionContext) + '\n\n' : '';
    const prompt = renderAgentPrompt(await buildReferenceFirstPrompt({ role: 'planner', adapter: 'codex', system: (effectivePlanner ? `[Effective planner contract SHA-256: ${effectivePlanner.hash}]\n\n` : '') + instructions.trim() + '\n\n## Shared Task / Job Contract\n\n' + contract.trim(), user: resolvedContext + '## Durable planner input\n\n' + plannerInput(context) }), 'codex');
    const runAgent = (input: string): Promise<string> => new Promise<string>((resolve, reject) => {
      // Plan apply writes unified relay.sqlite beside AGENTS_RELAY_STORE_DIR.
      const child = spawnOwnedProcess(this.command, buildPlannerCodexArgs(relayStoreDirectory(), input), { invocation: 'planner.agent', signal, correlation: { jobId: context.job.id }, spawn: { cwd: context.executionContext?.project.path, stdio: ['ignore', 'pipe', 'pipe'] } });
      let stdoutBuffer = '', finalMessage = '', stderrTail = '';
      const consume = (line: string): void => {
        const message = parsePlannerAgentMessage(line); if (message) finalMessage = message;
      };
      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString(); const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? ''; for (const line of lines) consume(line);
      });
      child.stderr?.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-16384); });
      child.on('error', reject); child.on('close', code => {
        if (stdoutBuffer) consume(stdoutBuffer);
        if (code !== 0) { reject(new Error(stderrTail.trim() || 'Planner agent runtime exited ' + code)); return; }
        if (!finalMessage) { reject(new Error('Planner agent returned no final message')); return; }
        resolve(finalMessage);
      });
    });
    if (!context.planExecution) throw new Error('Planner execution is missing its durable Plan and execution identity');
    const response = await runAgent(prompt);
    const expected = `PLAN_APPLIED:${context.planExecution.planId}:${context.planExecution.executionId}`;
    if (response !== expected) {
      const kind = response.startsWith('PLAN_APPLIED:') ? 'mismatched' : 'missing';
      throw new Error(`Planner returned a ${kind} PLAN_APPLIED receipt; must return only the matching PLAN_APPLIED receipt. Expected ${expected}, received ${response.slice(0, 200) || '(empty final message)'}. Inspect durable Plan state before retrying; only PLAN_APPLY_VALIDATION_FAILED authorizes same-execution candidate correction.`);
    }
    return { objective_status: 'satisfied', assessment: 'Plan committed through the authorized CLI action.', next_tasks: [], unblocks: [], cliApplied: true };
  }
}
