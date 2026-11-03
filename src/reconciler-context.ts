import { resolveExecutionContext, type ExecutionContext, type ExecutionRole } from './execution-context.js';
import type { DurableStore } from './store.js';
import type { Job, Plan, Task } from './types.js';
import type { ReconcileOptions } from './reconciler-runtime.js';

export async function resolveTaskContext(store: DurableStore, options: ReconcileOptions, job: Job, task: Task,
  role: ExecutionRole, projectPathOverride?: string): Promise<ExecutionContext> {
  const projectPath = projectPathOverride ?? (options.projectPathForJob ? await options.projectPathForJob(job) : task.routing?.cwd ?? process.cwd());
  return resolveExecutionContext(projectPath, role, {
    ...(options.executionContextRoots ?? {}),
    registeredAgents: await store.listAgents(),
    runtimes: options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
  });
}

export async function resolvePlannerContext(store: DurableStore, options: ReconcileOptions, job: Job, planning: Plan | Task): Promise<ExecutionContext> {
  const routingCwd = 'routing' in planning ? planning.routing?.cwd : undefined;
  const projectPath = options.projectPathForJob ? await options.projectPathForJob(job) : routingCwd ?? process.cwd();
  return resolveExecutionContext(projectPath, 'planner', {
    ...(options.executionContextRoots ?? {}),
    registeredAgents: await store.listAgents(),
    runtimes: options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
  });
}
