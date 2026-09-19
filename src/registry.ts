import { AgentAvailability, AgentCapabilityScore, AgentEndpoint, AgentRegistration } from './types.js';

export const DEFAULT_EVIDENCE_STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

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
  minScores?: Record<string, number>;
  staleAfterMs?: number;
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
    meanLatencyMs: number | null;
    meanCost: number | null;
    capabilityScores: AgentCapabilityScore[];
    capabilityFitScore: number | null;
  };
};

function hasAll(values: string[], required: string[]): boolean {
  return required.every(value => values.includes(value));
}

function evidenceTime(value: string): number | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function scoreAgentCapabilities(
  agent: AgentRegistration,
  options: { now?: number; staleAfterMs?: number } = {}
): AgentCapabilityScore[] {
  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_EVIDENCE_STALE_AFTER_MS;
  const capabilities = new Map<string, AgentRegistration['evidence']['evaluations']>();
  for (const observation of agent.evidence.evaluations) {
    for (const capability of observation.capabilities ?? []) {
      const values = capabilities.get(capability) ?? [];
      values.push(observation);
      capabilities.set(capability, values);
    }
  }
  return [...capabilities.entries()].map(([capability, observations]) => {
    const fresh = observations.filter(observation => {
      const timestamp = evidenceTime(observation.observedAt);
      return timestamp !== null && now - timestamp <= staleAfterMs;
    });
    const successes = fresh.filter(observation => observation.outcome === 'success').length;
    const lastObservedAt = observations
      .map(observation => observation.observedAt)
      .filter(value => evidenceTime(value) !== null)
      .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
    return {
      capability,
      score: fresh.length === 0 ? null : Math.round((successes / fresh.length) * 100),
      confidence: Math.round((fresh.length / (fresh.length + 3)) * 100),
      sampleCount: observations.length,
      freshSampleCount: fresh.length,
      staleSampleCount: observations.length - fresh.length,
      lastObservedAt,
      stale: observations.length > 0 && fresh.length === 0
    };
  }).sort((left, right) => left.capability.localeCompare(right.capability));
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
  if (query.minScores && Object.keys(query.minScores).length > 0) {
    const scores = new Map(scoreAgentCapabilities(agent, { staleAfterMs: query.staleAfterMs }).map(score => [score.capability, score]));
    for (const [capability, minimum] of Object.entries(query.minScores)) {
      if (!agent.capabilities.includes(capability)) return false;
      const score = scores.get(capability)?.score;
      if (score === null || score === undefined || score < minimum) return false;
    }
  }
  return (query.availability ?? ['available', 'degraded']).includes(agent.availability);
}

function average(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ranking(agent: AgentRegistration, taskKind?: string, staleAfterMs?: number, capabilities: string[] = []): AgentCandidate['ranking'] {
  const evaluations = taskKind ? agent.evidence.evaluations.filter(item => item.taskKind === taskKind) : agent.evidence.evaluations;
  const taskKindSamples = evaluations.length;
  const taskKindSuccesses = evaluations.filter(item => item.outcome === 'success').length;
  const { succeeded, failed, timedOut } = agent.evidence.outcomes;
  const outcomeSamples = succeeded + failed + timedOut;
  const latency = evaluations.map(item => item.latencyMs).filter((value): value is number => typeof value === 'number');
  const costs = evaluations.map(item => item.cost).filter((value): value is number => typeof value === 'number');
  const capabilityScores = scoreAgentCapabilities(agent, { staleAfterMs });
  const requestedScores = capabilities.map(capability => capabilityScores.find(item => item.capability === capability)?.score ?? null);
  const capabilityFitScore = requestedScores.length === 0 || requestedScores.some(score => score === null) ? null : Math.min(...requestedScores as number[]);
  return {
    taskKindSamples,
    taskKindSuccessRate: taskKindSamples === 0 ? null : taskKindSuccesses / taskKindSamples,
    outcomeSamples,
    reliability: outcomeSamples === 0 ? null : succeeded / outcomeSamples,
    meanLatencyMs: average(latency),
    meanCost: average(costs),
    capabilityScores,
    capabilityFitScore
  };
}

function compareCandidates(left: AgentCandidate, right: AgentCandidate): number {
  const leftTask = left.ranking.taskKindSuccessRate ?? -1;
  const rightTask = right.ranking.taskKindSuccessRate ?? -1;
  if (leftTask !== rightTask) return rightTask - leftTask;
  if (left.ranking.taskKindSamples !== right.ranking.taskKindSamples) return right.ranking.taskKindSamples - left.ranking.taskKindSamples;
  const leftCapability = left.ranking.capabilityFitScore ?? -1;
  const rightCapability = right.ranking.capabilityFitScore ?? -1;
  if (leftCapability !== rightCapability) return rightCapability - leftCapability;
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
  if (query.capabilities?.length) reasons.push(ranked.capabilityFitScore === null ? 'evaluated capability fit: unscored' : `evaluated capability fit: ${ranked.capabilityFitScore}/100 minimum across requested capabilities`);
  if (agent.availability === 'degraded') reasons.push('availability: degraded');
  for (const [capability, minimum] of Object.entries(query.minScores ?? {})) {
    const score = ranked.capabilityScores.find(item => item.capability === capability);
    reasons.push(`capability score: ${capability} ${score?.score ?? 'unscored'}/100 (minimum ${minimum}, confidence ${score?.confidence ?? 0}, fresh samples ${score?.freshSampleCount ?? 0})`);
  }
  if (ranked.meanLatencyMs !== null) reasons.push(`observed latency: mean ${Math.round(ranked.meanLatencyMs)} ms`);
  if (ranked.meanCost !== null) reasons.push(`observed cost: mean ${ranked.meanCost}`);
  return reasons;
}

export function discoverAgents(agents: AgentRegistration[], query: DiscoveryQuery = {}): AgentCandidate[] {
  const ranked = agents.filter(agent => matches(agent, query)).map(agent => {
    const rank = ranking(agent, query.taskKind, query.staleAfterMs, query.capabilities);
    const exploratory = query.capabilities?.length ? rank.capabilityFitScore === null : rank.taskKindSamples === 0;
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
