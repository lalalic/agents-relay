import { AgentAvailability, RoutingDecision, Task, WorkerRequirements, WorkerSelection } from './types.js';

export type ReviewerCandidate = {
  workerId: string;
  adapter: Exclude<Task['adapter'], 'orchestrator'>;
  capabilities: readonly string[];
  runtime?: string;
  taskKind?: string;
  trustDomains?: readonly string[];
  region?: string;
  labels?: Readonly<Record<string, string>>;
  availability?: AgentAvailability;
  resourceHealthy?: boolean;
  routing: RoutingDecision;
};

export type ReviewerRoutingDecision = {
  candidate: ReviewerCandidate;
  selection: WorkerSelection;
  reason: 'worker-diversity' | 'provider-model-diversity' | 'eligible-fallback';
};

function satisfies(candidate: ReviewerCandidate, requirements?: WorkerRequirements): boolean {
  if (candidate.availability && candidate.availability !== 'available') return false;
  if (candidate.resourceHealthy === false) return false;
  if (!requirements) return true;
  if (!requirements.capabilities.every(capability => candidate.capabilities.includes(capability))) return false;
  if (requirements.runtime && candidate.runtime !== requirements.runtime) return false;
  if (requirements.taskKind && candidate.taskKind !== requirements.taskKind) return false;
  if (requirements.trustDomain && !candidate.trustDomains?.includes(requirements.trustDomain)) return false;
  if (requirements.region && candidate.region !== requirements.region) return false;
  if (requirements.labels && Object.entries(requirements.labels).some(([key, value]) => candidate.labels?.[key] !== value)) return false;
  return true;
}

function producedWorkerIds(tasks: readonly Task[]): Set<string> {
  return new Set(tasks
    .filter(task => task.agentName !== 'reviewer')
    .map(task => task.workerSelection?.workerId ?? task.adapter));
}

function producedRoutes(tasks: readonly Task[]): Set<string> {
  return new Set(tasks
    .filter(task => task.agentName !== 'reviewer' && task.routing)
    .map(task => `${task.routing?.provider}\0${task.routing?.model}`));
}

/** Select a review worker only after hard gates, then prefer execution diversity. */
export function selectReviewer(
  candidates: readonly ReviewerCandidate[],
  implementationTasks: readonly Task[],
  requirements?: WorkerRequirements,
): ReviewerRoutingDecision {
  const eligible = candidates.filter(candidate => satisfies(candidate, requirements));
  if (eligible.length === 0) throw new Error('No eligible reviewer worker satisfies the declared requirements');
  const usedWorkers = producedWorkerIds(implementationTasks);
  const usedRoutes = producedRoutes(implementationTasks);
  const ranked = eligible.map((candidate, index) => ({
    candidate,
    index,
    differentWorker: !usedWorkers.has(candidate.workerId),
    differentRoute: !usedRoutes.has(`${candidate.routing.provider}\0${candidate.routing.model}`),
  })).sort((left, right) => {
    if (left.differentWorker !== right.differentWorker) return left.differentWorker ? -1 : 1;
    if (left.differentRoute !== right.differentRoute) return left.differentRoute ? -1 : 1;
    return left.index - right.index;
  });
  const selected = ranked[0];
  const reason = selected.differentWorker ? 'worker-diversity' : selected.differentRoute ? 'provider-model-diversity' : 'eligible-fallback';
  return {
    candidate: selected.candidate,
    selection: {
      workerId: selected.candidate.workerId,
      adapter: selected.candidate.adapter,
      capabilities: [...selected.candidate.capabilities],
      selectedBy: `worker-router:reviewer-diversity:${reason}`,
      selectedAt: new Date().toISOString(),
    },
    reason,
  };
}
