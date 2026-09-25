import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Job, Priority, StorySize, Task, AdapterName, RoutingDecision, TaskOutput, PlanningDecisionSource, taskOverallTimeoutMs, WorkerRequirements } from './types.js';
import { ExecutionContext, executionContextPrompt } from './execution-context.js';

export type ObjectiveStatus = 'in_progress' | 'satisfied';
export type PlannerTaskSpec = {
  id: string;
  input: string;
  priority?: Priority;
  storySize?: StorySize;
  projectName?: string;
  agentName?: string;
  agentGraph?: string;
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
export type PlannerResult = { objective_status: ObjectiveStatus; assessment: string; next_tasks: PlannerTaskSpec[] };
export type PlannerContext = { job: Job; tasks: readonly Task[]; objective: string; previousPlannerTaskId: string | null; executionContext?: ExecutionContext };
export interface ObjectivePlanner { plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult>; }

export function planningSpec(task: Task): PlannerTaskSpec {
  if (!task.output && task.adapter !== 'orchestrator') throw new Error(`Initial task ${task.id} requires an output contract`);
  if (!['codex', 'chatgpt', 'orchestrator'].includes(task.adapter)) throw new Error(`Initial task ${task.id} requires a supported adapter`);
  return { id: task.id, input: task.input, priority: task.priority, storySize: task.storySize, projectName: task.projectName, agentName: task.agentName, agentGraph: task.agentGraph, dependencies: task.dependencies, capabilities: task.capabilities, workerRequirements: task.workerRequirements, adapter: task.adapter, output: task.output ?? { kind: 'task_pr' }, routing: task.routing, continuation: task.continuation, maxAttempts: task.maxAttempts, timeoutMs: task.timeoutMs };
}


function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Planner result must be an object');
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
  const root = record(value);
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
  const route = record(value);
  for (const key of ['provider', 'model', 'decidedBy', 'decidedAt']) if (typeof route[key] !== 'string' || String(route[key]).length === 0) throw new Error(`Planner ${field}.${key} is required`);
  return { provider: route.provider as string, model: route.model as string, profile: optionalString(route.profile, `${field}.profile`), reasoning: optionalString(route.reasoning, `${field}.reasoning`), cwd: optionalString(route.cwd, `${field}.cwd`), projectId: optionalString(route.projectId, `${field}.projectId`), decidedBy: route.decidedBy as string, decidedAt: route.decidedAt as string };
}

export function parsePlannerResult(value: unknown): PlannerResult {
  const root = record(value);
  const status = root.objective_status;
  if (status !== 'in_progress' && status !== 'satisfied') throw new Error('Planner objective_status must be in_progress or satisfied');
  if (typeof root.assessment !== 'string') throw new Error('Planner assessment must be a string');
  if (!Array.isArray(root.next_tasks)) throw new Error('Planner next_tasks must be an array');
  const ids = new Set<string>();
  const next_tasks = root.next_tasks.map((item, index): PlannerTaskSpec => {
    const task = record(item);
    const id = task.id;
    if (typeof id !== 'string' || id.length === 0) throw new Error(`Planner next_tasks[${index}].id is required`);
    if (ids.has(id)) throw new Error(`Planner next_tasks contains duplicate id ${id}`);
    ids.add(id);
    if (typeof task.input !== 'string' || task.input.length === 0) throw new Error(`Planner next_tasks[${index}].input is required`);
    const adapter = task.adapter;
    if (adapter !== undefined && !['codex', 'chatgpt'].includes(String(adapter))) throw new Error(`Planner next_tasks[${index}].adapter must be codex or chatgpt when provided`);
    const output = task.output === undefined ? undefined : record(task.output);
    if (!output || (output.kind !== 'task_pr' && output.kind !== 'file')) throw new Error(`Planner next_tasks[${index}].output is required`);
    if (output.kind === 'file' && (typeof output.path !== 'string' || output.path.length === 0)) throw new Error(`Planner next_tasks[${index}].output.path is required for file output`);
    const priority = task.priority === undefined ? undefined : normalizePlannerPriority(task.priority, `next_tasks[${index}].priority`);
    const sizeValue = task.storySize === undefined ? 'M' : String(task.storySize).toUpperCase();
    if (!['S','M','L'].includes(sizeValue)) throw new Error('Planner next_tasks[' + index + '].storySize must be S, M, or L');
    const storySize = sizeValue as StorySize;
    const maxAttempts = task.maxAttempts === undefined ? 3 : task.maxAttempts;
    const route = routing(task.routing, 'next_tasks[' + index + '].routing');
    const requirements = workerRequirements(task.workerRequirements ?? task.requirements, 'next_tasks[' + index + '].workerRequirements');
    const timeoutMs = task.timeoutMs === undefined ? taskOverallTimeoutMs(storySize, route?.reasoning) : task.timeoutMs;
    if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`Planner next_tasks[${index}].maxAttempts is invalid`);
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`Planner next_tasks[${index}].timeoutMs is invalid`);
    return {
      id, input: task.input, priority, storySize,
      projectName: optionalString(task.projectName, 'projectName'), agentName: optionalString(task.agentName, 'agentName'), agentGraph: optionalString(task.agentGraph, 'agentGraph'),
      dependencies: stringArray(task.dependencies, 'dependencies'), capabilities: stringArray(task.capabilities, 'capabilities'), workerRequirements: requirements,
      adapter: adapter as AdapterName | undefined, output: output as TaskOutput, routing: route,
      continuation: task.continuation as Task['continuation'], maxAttempts, timeoutMs
    };
  });
  return { objective_status: status, assessment: root.assessment, next_tasks };
}

export function parsePlannerOutput(output: string): PlannerResult {
  const trimmed = output.trim();
  const candidate = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  return parsePlannerResult(JSON.parse(candidate) as unknown);
}

export function plannerInput(context: PlannerContext): string {
  const visibleAgents = context.executionContext?.agents.map(agent => ({
    name: agent.name,
    description: agent.description,
    capabilities: agent.capabilities,
    boundaries: agent.restrictions,
    runtime: agent.runtime,
  }));
  return JSON.stringify({ objective: context.objective, previous_planner_task_id: context.previousPlannerTaskId, visible_agents: visibleAgents ?? [], execution_context: context.executionContext, tasks: context.tasks.map(task => ({ id: task.id, kind: task.kind ?? 'work', parent_task_id: task.parentTaskId, state: task.state, input: task.input, result: task.result, planner_result: task.plannerResult, error: task.error })) });
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
