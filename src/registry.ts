import { AgentAvailability, AgentEndpoint, AgentRegistration } from './types.js';

export type DiscoveryQuery = {
  capabilities?: string[];
  runtime?: string;
  endpointKinds?: AgentEndpoint['kind'][];
  availability?: AgentAvailability[];
  labels?: Record<string, string>;
  trustDomain?: string;
  trustDomains?: string[];
  regions?: string[];
  requiredBoundaries?: string[];
  taskKind?: string;
  explore?: boolean;
};

export type AgentCandidate = {
  agent: AgentRegistration;
  reasons: string[];
  evidence: AgentRegistration['evidence'];
  exploratory: boolean;
  ranking: {
    taskKindSamples: number;
    taskKindSuccessRate: number | null;
    outcomeSamples: number;
    reliability: number | null;
  };
};

function hasAll(values: string[], required: string[]): boolean {
  return required.every(value => values.includes(value));
}

function matches(agent: AgentRegistration, query: DiscoveryQuery): boolean {
  if (query.capabilities?.length && !hasAll(agent.capabilities, query.capabilities)) return false;
  if (query.runtime && agent.runtime.adapter !== query.runtime) return false;
  if (query.endpointKinds?.length && !query.endpointKinds.includes(agent.endpoint.kind)) return false;
  if (query.trustDomain && !agent.routing.trustDomains?.includes(query.trustDomain)) return false;
  if (query.trustDomains?.length && !hasAll(agent.routing.trustDomains ?? [], query.trustDomains)) return false;
  if (query.regions?.length && !hasAll(agent.routing.regions ?? [], query.regions)) return false;
  if (query.requiredBoundaries?.length && !hasAll(agent.boundaries, query.requiredBoundaries)) return false;
  if (query.labels && !Object.entries(query.labels).every(([key, value]) => agent.routing.labels?.[key] === value)) return false;
  return (query.availability ?? ['available', 'degraded']).includes(agent.availability);
}

function ranking(agent: AgentRegistration, taskKind?: string): AgentCandidate['ranking'] {
  const evaluations = taskKind ? agent.evidence.evaluations.filter(item => item.taskKind === taskKind) : agent.evidence.evaluations;
  const taskKindSamples = evaluations.length;
  const taskKindSuccesses = evaluations.filter(item => item.outcome === 'success').length;
  const { succeeded, failed, timedOut } = agent.evidence.outcomes;
  const outcomeSamples = succeeded + failed + timedOut;
  return {
    taskKindSamples,
    taskKindSuccessRate: taskKindSamples === 0 ? null : taskKindSuccesses / taskKindSamples,
    outcomeSamples,
    reliability: outcomeSamples === 0 ? null : succeeded / outcomeSamples
  };
}

function compareCandidates(left: AgentCandidate, right: AgentCandidate): number {
  const leftTask = left.ranking.taskKindSuccessRate ?? -1;
  const rightTask = right.ranking.taskKindSuccessRate ?? -1;
  if (leftTask !== rightTask) return rightTask - leftTask;
  if (left.ranking.taskKindSamples !== right.ranking.taskKindSamples) return right.ranking.taskKindSamples - left.ranking.taskKindSamples;
  const leftReliability = left.ranking.reliability ?? -1;
  const rightReliability = right.ranking.reliability ?? -1;
  if (leftReliability !== rightReliability) return rightReliability - leftReliability;
  if (left.ranking.outcomeSamples !== right.ranking.outcomeSamples) return right.ranking.outcomeSamples - left.ranking.outcomeSamples;
  if (left.agent.availability !== right.agent.availability) return left.agent.availability === 'available' ? -1 : 1;
  return left.agent.id.localeCompare(right.agent.id);
}

function explain(agent: AgentRegistration, query: DiscoveryQuery, ranked: AgentCandidate['ranking']): string[] {
  const reasons = [
    query.capabilities?.length ? `hard filters matched capabilities: ${query.capabilities.join(', ')}` : 'hard filters matched',
    query.taskKind
      ? ranked.taskKindSamples > 0
        ? `task fit: ${ranked.taskKindSamples} observed ${query.taskKind} evaluation(s), ${Math.round((ranked.taskKindSuccessRate ?? 0) * 100)}% success`
        : `task fit: no observed ${query.taskKind} evaluations yet`
      : ranked.taskKindSamples > 0
        ? `observed evaluations: ${ranked.taskKindSamples}`
        : 'no observed evaluations yet',
    ranked.outcomeSamples > 0
      ? `observed outcomes: ${ranked.outcomeSamples}, ${Math.round((ranked.reliability ?? 0) * 100)}% succeeded`
      : 'no observed outcomes yet'
  ];
  if (agent.availability === 'degraded') reasons.push('availability: degraded');
  return reasons;
}

export function discoverAgents(agents: AgentRegistration[], query: DiscoveryQuery = {}): AgentCandidate[] {
  const ranked = agents.filter(agent => matches(agent, query)).map(agent => {
    const rank = ranking(agent, query.taskKind);
    const exploratory = rank.taskKindSamples === 0;
    return { agent, reasons: explain(agent, query, rank), evidence: agent.evidence, exploratory, ranking: rank };
  }).sort(compareCandidates);

  if (!query.explore) return ranked;

  const firstExploratory = ranked.findIndex(candidate => candidate.exploratory);
  const firstObserved = ranked.findIndex(candidate => !candidate.exploratory);
  if (firstExploratory < 0 || firstObserved < 0 || firstExploratory <= firstObserved + 1) return ranked;

  const [candidate] = ranked.splice(firstExploratory, 1);
  candidate.reasons.push('controlled exploration: promoted one unscored candidate behind the strongest observed candidate');
  ranked.splice(firstObserved + 1, 0, candidate);
  return ranked;
}
