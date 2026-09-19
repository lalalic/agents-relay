import { spawn } from 'node:child_process';
import { Job, Priority, Task, AdapterName, RoutingDecision } from './types.js';

export type ObjectiveStatus = 'in_progress' | 'satisfied';
export type PlannerTaskSpec = {
  id: string;
  input: string;
  priority?: Priority;
  projectName?: string;
  agentName?: string;
  dependencies?: string[];
  capabilities?: string[];
  adapter?: AdapterName;
  routing?: RoutingDecision;
  continuation?: Task['continuation'];
  maxAttempts?: number;
  timeoutMs?: number;
};
export type PlannerResult = { objective_status: ObjectiveStatus; assessment: string; next_tasks: PlannerTaskSpec[] };
export type PlannerContext = { job: Job; tasks: readonly Task[]; objective: string; previousPlannerTaskId: string | null };
export interface ObjectivePlanner { plan(context: PlannerContext, signal: AbortSignal): Promise<PlannerResult>; }

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
    const adapter = task.adapter === undefined ? 'shell' : task.adapter;
    if (!['shell', 'codex', 'chatgpt', 'orchestrator'].includes(String(adapter))) throw new Error(`Planner next_tasks[${index}].adapter is invalid`);
    if (task.priority !== undefined && !['P0', 'P1', 'P2', 'P3'].includes(String(task.priority))) throw new Error(`Planner next_tasks[${index}].priority is invalid`);
    const maxAttempts = task.maxAttempts === undefined ? 3 : task.maxAttempts;
    const timeoutMs = task.timeoutMs === undefined ? 300000 : task.timeoutMs;
    if (typeof maxAttempts !== 'number' || !Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error(`Planner next_tasks[${index}].maxAttempts is invalid`);
    if (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error(`Planner next_tasks[${index}].timeoutMs is invalid`);
    return {
      id, input: task.input, priority: task.priority as Priority | undefined,
      projectName: optionalString(task.projectName, 'projectName'), agentName: optionalString(task.agentName, 'agentName'),
      dependencies: stringArray(task.dependencies, 'dependencies'), capabilities: stringArray(task.capabilities, 'capabilities'),
      adapter: adapter as AdapterName, routing: routing(task.routing, `next_tasks[${index}].routing`),
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
  return JSON.stringify({ objective: context.objective, previous_planner_task_id: context.previousPlannerTaskId, tasks: context.tasks.map(task => ({ id: task.id, kind: task.kind ?? 'work', parent_task_id: task.parentTaskId, state: task.state, input: task.input, result: task.result, planner_result: task.plannerResult, error: task.error })) });
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
