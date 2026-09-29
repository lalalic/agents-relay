import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Job, Priority, StorySize, Task, AdapterName, RoutingDecision, TaskOutput, PlanningDecisionSource, storySizeTimeoutMs, taskOverallTimeoutMs, WorkerRequirements, ReviewTaskMetadata } from './types.js';
import { ExecutionContext, executionContextPrompt } from './execution-context.js';
import { parseAgentGraph } from './agent-graph.js';

export type ObjectiveStatus = 'in_progress' | 'satisfied';
export type PlannerTaskSpec = {
  id: string;
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
  adapter?: AdapterName;
  output?: TaskOutput;
  routing?: RoutingDecision;
  continuation?: Task['continuation'];
  maxAttempts?: number;
  timeoutMs?: number;
};
export type PlannerUnblockSpec = { repository: string; prNumber: number; jobId: string; taskId: string; resolutionMode?: 'merge' | 'verified' };
export type PlannerResult = { objective_status: ObjectiveStatus; assessment: string; next_tasks: PlannerTaskSpec[]; unblocks: PlannerUnblockSpec[] };
export type PlannerContext = { job: Job; tasks: readonly Task[]; objective: string; previousPlannerTaskId: string | null; executionContext?: ExecutionContext; retryFeedback?: string; guidance?: string };
export interface ObjectivePlanner { plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult>; }
export type PlannerRoundOptions = { guidance?: string; manual?: boolean; timeoutMs?: number; now?: string };

export function plannerRoundNumber(task: Task): number | null {
  if (task.kind !== 'planner') return null;
  if (Number.isInteger(task.planningRound) && (task.planningRound ?? 0) > 0) return task.planningRound as number;
  const match = /^(?:plan|planner)-(\d+)$/.exec(task.id);
  return match ? Number(match[1]) : null;
}

export function createPlannerRoundTask(job: Job, options: PlannerRoundOptions = {}): Task {
  const planners = job.tasks.filter(task => task.kind === 'planner')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const used = new Set(job.tasks.map(task => task.id));
  let round = Math.max(0, ...planners.map(task => plannerRoundNumber(task) ?? 0)) + 1;
  let id = `plan-${round}`;
  while (used.has(id)) { round += 1; id = `plan-${round}`; }
  const previousPlanner = planners.at(-1);
  const now = options.now ?? new Date().toISOString();
  const context: PlannerContext = {
    job,
    tasks: job.tasks,
    objective: job.objective ?? job.description ?? job.title,
    previousPlannerTaskId: previousPlanner?.id ?? null,
    guidance: options.guidance,
  };
  return {
    jobId: job.id, id, kind: 'planner', storySize: 'M', agentName: 'planner',
    parentTaskId: null, dependencies: [], capabilities: ['planner'], adapter: 'orchestrator',
    input: plannerInput(context), continuation: null, continuationDeliveredAt: null, state: 'QUEUED', attempt: 0,
    maxAttempts: options.manual ? 1 : 3, leaseOwner: null, leaseExpiresAt: null, executionId: null, threadId: null,
    result: null, plannerResult: null, error: null, timeoutMs: options.timeoutMs ?? storySizeTimeoutMs('M'),
    createdAt: now, updatedAt: now, planningDecisionId: id, planningSource: 'model-planner', planningRound: round, previousPlannerTaskId: previousPlanner?.id ?? null,
    plannerGuidance: options.guidance, manualPlanning: options.manual === true,
  };
}

export function planningSpec(task: Task): PlannerTaskSpec {
  if (!task.output && task.adapter !== 'orchestrator') throw new Error(`Initial task ${task.id} requires an output contract`);
  if (!['codex', 'chatgpt', 'orchestrator'].includes(task.adapter)) throw new Error(`Initial task ${task.id} requires a supported adapter`);
  return { id: task.id, parentTaskId: task.parentTaskId, input: task.input, priority: task.priority, storySize: task.storySize, projectName: task.projectName, agentName: task.agentName, agentGraph: task.agentGraph, review: task.review, dependencies: task.dependencies, capabilities: task.capabilities, workerRequirements: task.workerRequirements, adapter: task.adapter, output: task.output ?? { kind: 'task_pr' }, routing: task.routing, continuation: task.continuation, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs };
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
      id, parentTaskId, input: task.input, priority, storySize,
      projectName: optionalString(task.projectName, 'projectName'), agentName: optionalString(task.agentName, 'agentName'), agentGraph, review,
      dependencies: stringArray(task.dependencies, 'dependencies'), capabilities: stringArray(task.capabilities, 'capabilities'), workerRequirements: requirements,
      adapter: adapter as AdapterName | undefined, output: output as TaskOutput, routing: route,
      continuation: task.continuation as Task['continuation'], maxAttempts, timeoutMs
    };
  });
  return { objective_status: status, assessment: root.assessment, next_tasks, unblocks };
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
    retry_feedback: context.retryFeedback,
    caller_prompt: context.guidance,
    previous_planner_task_id: context.previousPlannerTaskId,
    change_cycle: context.job.changeCycle,
    project: project ? { name: project.name, path: project.path } : undefined,
    visible_agents: visibleAgents ?? [],
    tasks: context.tasks.map(task => ({
      id: task.id,
      kind: task.kind ?? 'work',
      parent_task_id: task.parentTaskId,
      state: task.state,
      input: task.kind === 'planner' ? undefined : boundedText(task.input),
      result_summary: boundedText(task.result?.summary),
      planner_result: task.plannerResult ? {
        objective_status: task.plannerResult.objective_status,
        assessment: boundedText(task.plannerResult.assessment),
        next_task_ids: task.plannerResult.next_tasks.map(item => item.id),
      } : undefined,
      error: boundedText(task.error, 2000),
      blocked_baseline: task.blockedBaseline,
      unblock: task.unblock,
    })),
  });
}

export class CommandObjectivePlanner implements ObjectivePlanner {
  constructor(private readonly command: string) { if (!command) throw new Error('Planner command is required'); }
  async plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult> {
    return await new Promise<PlannerResult>((resolve, reject) => {
      const child = spawn(this.command, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', reject);
      child.on('close', code => code === 0 ? (() => { try { resolve(parsePlannerOutput(stdout)); } catch (error) { reject(error); } })() : reject(new Error(stderr.trim() || `Planner exited ${code}`)));
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      child.stdin.end(plannerInput(context));
    });
  }
}


const DEFAULT_PLANNER_AGENT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agents-relay', 'agents', 'planner.agent.md');
const DEFAULT_TASK_JOB_CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'agents-relay', 'contracts', 'task-job-contract.md');

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
    const resolvedPlanner = context.executionContext?.agents.find(agent => agent.name === 'planner')?.path;
    const instructions = await readFile(resolvedPlanner ?? this.agentFile, 'utf8');
    const contract = await readFile(DEFAULT_TASK_JOB_CONTRACT, 'utf8');
    const resolvedContext = context.executionContext ? executionContextPrompt(context.executionContext) + '\n\n' : '';
    const prompt = instructions.trim() + '\n\n## Shared Task / Job Contract\n\n' + contract.trim() + '\n\n' + resolvedContext + '## Durable planner input\n\n' + plannerInput(context);
    return await new Promise<PlannerResult>((resolve, reject) => {
      const child = spawn(this.command, ['exec', '--json', '--', prompt], { cwd: context.executionContext?.project.path, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdoutBuffer = '';
      let finalMessage = '';
      let stderrTail = '';
      const consume = (line: string): void => {
        const message = parsePlannerAgentMessage(line);
        if (message) finalMessage = message;
      };
      child.stdout.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? '';
        for (const line of lines) consume(line);
      });
      child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString()).slice(-16384); });
      child.on('error', reject);
      child.on('close', code => {
        if (stdoutBuffer) consume(stdoutBuffer);
        if (code !== 0) { reject(new Error(stderrTail.trim() || 'Planner agent runtime exited ' + code)); return; }
        if (!finalMessage) { reject(new Error('Planner agent returned no final message')); return; }
        try { resolve(parsePlannerOutput(finalMessage)); } catch (error) { reject(error); }
      });
      signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
    });
  }
}
