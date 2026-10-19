import type { Task, WorkerAdapterName, WorkerRequirements } from './types.js';
import { eligibleWorkerCandidates, workerCandidates } from './worker-routing.js';
import type { AgentRegistration } from './types.js';
import type { ChatGptPlatformFailureClassification } from './worker-rejection.js';
import { routeExecution } from './execution-routing.js';
import type { AccountUsageOverview } from './usage.js';

type WorkerAdapter = { name: WorkerAdapterName; id: string; capabilities: readonly string[] };

export async function codexFallbackCompatible(
  task: Task,
  adapters: readonly WorkerAdapter[],
  registered: readonly AgentRegistration[],
  usage?: AccountUsageOverview,
): Promise<boolean> {
  if (task.adapter !== 'chatgpt' || task.chatgptThreadDelivery || task.workerRequirements?.runtime === 'chatgpt') return false;
  const requirements: WorkerRequirements = task.workerRequirements ?? { capabilities: [] };
  const candidates = eligibleWorkerCandidates(workerCandidates(adapters, registered, usage), requirements, { strictCapabilities: true })
    .filter(candidate => candidate.adapter === 'codex');
  if (candidates.length === 0) return false;
  try {
    await routeExecution(candidates, requirements, { registered, usage, taskFacts: { task } });
    return true;
  } catch {
    return false;
  }
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
