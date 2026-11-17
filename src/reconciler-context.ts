import { resolveExecutionContext, resolveAgentModelPreference, type ExecutionContext, type ExecutionRole } from './execution-context.js';
import type { DurableStore } from './store.js';
import type { Job, Plan, Task } from './types.js';
import type { ReconcileOptions } from './reconciler-runtime.js';
import type { ExecutionRoutingOptions } from './execution-routing.js';

/**
 * Agent model guidance is advisory. A missing/malformed Agent or unavailable
 * context must never turn a previously routable Task into a routing failure.
 */
export async function agentModelPreferenceForJob(
  options: ReconcileOptions, job: Job, agentName?: string, task?: Task,
): Promise<ExecutionRoutingOptions['modelPreference']> {
  if (!agentName) return undefined;
  try {
    // Do not call cwdForJob here: production providers may create a
    // worktree or mutate Job state when that execution locator is evaluated.
    const projectPath = options.agentPreferenceRootForJob
      ? await options.agentPreferenceRootForJob(job, task)
      : task?.routing?.cwd;
    return projectPath ? await resolveAgentModelPreference(projectPath, agentName, options.executionContextRoots ?? {}) : undefined;
  } catch {
    return undefined;
  }
}

export async function resolveTaskContext(store: DurableStore, options: ReconcileOptions, job: Job, task: Task,
  role: ExecutionRole, projectPathOverride?: string): Promise<ExecutionContext> {
  const projectPath = projectPathOverride ?? (options.cwdForJob ? await options.cwdForJob(job) : task.routing?.cwd ?? process.cwd());
  return resolveExecutionContext(projectPath, role, {
    ...(options.executionContextRoots ?? {}),
    registeredAgents: await store.listAgents(),
    runtimes: options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
  });
}

export async function resolvePlannerContext(store: DurableStore, options: ReconcileOptions, job: Job, planning: Plan | Task): Promise<ExecutionContext> {
  const routingCwd = 'routing' in planning ? planning.routing?.cwd : undefined;
  const projectPath = options.cwdForJob ? await options.cwdForJob(job) : routingCwd ?? process.cwd();
  return resolveExecutionContext(projectPath, 'planner', {
    ...(options.executionContextRoots ?? {}),
    registeredAgents: await store.listAgents(),
    runtimes: options.adapters.map(adapter => ({ name: adapter.name, id: adapter.id, capabilities: [...adapter.capabilities] })),
  });
}
