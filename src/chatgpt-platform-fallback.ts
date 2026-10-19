import type { Task, WorkerAdapterName, WorkerRequirements } from './types.js';
import { eligibleWorkerCandidates, workerCandidates } from './worker-routing.js';
import type { AgentRegistration } from './types.js';
import type { ChatGptPlatformFailureClassification } from './worker-rejection.js';
import { routeExecution } from './execution-routing.js';
import type { AccountUsageOverview } from './usage.js';
import type { DurableTaskTransitionRuntime } from './workflow/durable-transition.js';
import type { EventRecord } from './types.js';
import { eventFor } from './events.js';

type WorkerAdapter = { name: WorkerAdapterName; id: string; capabilities: readonly string[] };

export function codexFallbackRouting(
  task: Task,
  adapters: readonly WorkerAdapter[],
  registered: readonly AgentRegistration[],
  usage?: AccountUsageOverview,
): { candidates: ReturnType<typeof workerCandidates>; excludedRoutes: Array<{ provider: string; model: string; profile?: string }> } {
  const requirements = task.workerRequirements ?? { capabilities: [] };
  const excludedWorkers = new Set((task.routingExclusions ?? []).map(item => item.workerId).filter((id): id is string => Boolean(id)));
  const excludedAdapters = new Set((task.routingExclusions ?? []).map(item => item.adapter).filter((adapter): adapter is WorkerAdapterName => Boolean(adapter)));
  const candidates = eligibleWorkerCandidates(workerCandidates(adapters, registered, usage), requirements, { strictCapabilities: true })
    .filter(candidate => candidate.adapter === 'codex' && !excludedWorkers.has(candidate.workerId) && !excludedAdapters.has(candidate.adapter));
  const excludedRoutes = (task.routingExclusions ?? []).map(item => ({ provider: item.provider, model: item.model, ...(item.profile ? { profile: item.profile } : {}) }));
  return { candidates, excludedRoutes };
}

export async function codexFallbackCompatible(
  task: Task,
  adapters: readonly WorkerAdapter[],
  registered: readonly AgentRegistration[],
  usage?: AccountUsageOverview,
): Promise<boolean> {
  if (task.adapter !== 'chatgpt' || task.chatgptThreadDelivery || task.workerRequirements?.runtime === 'chatgpt') return false;
  const requirements: WorkerRequirements = task.workerRequirements ?? { capabilities: [] };
  const { candidates, excludedRoutes } = codexFallbackRouting(task, adapters, registered, usage);
  if (candidates.length === 0) return false;
  try {
    await routeExecution(candidates, requirements, { registered, usage, taskFacts: { task }, excludedRoutes });
    return true;
  } catch {
    return false;
  }
}

export async function quarantineUnavailableCodexFallback(
  transitions: DurableTaskTransitionRuntime,
  emit: (event: EventRecord) => Promise<void>,
  jobId: string,
  taskId: string,
  error: unknown,
): Promise<void> {
  const transition = await transitions.apply(jobId, taskId, 'worker.platform_failure', {
    eligible: (_job, task) => task.state === 'QUEUED' && task.adapter === 'chatgpt' && task.platformFailure?.safeToReroute === true,
    facts: () => ({ platformFallbackSafe: false }),
    mutate: (_job, task) => { task.error = `Codex fallback route became unavailable: ${error instanceof Error ? error.message : String(error)}`; },
  });
  if (transition?.decision.accepted) await emit(eventFor(jobId, taskId, transition.task.parentTaskId, 'task.blocked', 'blocked', transition.task.error ?? 'Codex fallback route unavailable', 'user', { reason: transition.task.failureReason, phase: 'fallback-routing' }));
}

export function persistChatGptPlatformFailure(
  task: Task,
  original: Task | undefined,
  executionId: string | null,
  classification: ChatGptPlatformFailureClassification,
  evidence: string,
  safeToReroute: boolean,
): void {
  const route = original?.routing;
  const workerId = original?.workerSelection?.workerId ?? 'chatgpt';
  const at = new Date().toISOString();
  task.platformFailure = {
    classification,
    executionId: executionId ?? 'unknown',
    route: { workerId, adapter: 'chatgpt', provider: route?.provider ?? 'unknown', model: route?.model ?? 'unknown', ...(route?.profile ? { profile: route.profile } : {}) },
    evidence,
    safeToReroute,
    at,
  };
  if (!task.routingExclusions?.some(item => item.workerId === workerId && item.adapter === 'chatgpt')) {
    task.routingExclusions = [...(task.routingExclusions ?? []), {
      ...task.platformFailure.route,
      reason: classification,
      at,
    }];
  }
}
