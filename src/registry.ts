import { AgentAvailability, AgentRegistration } from './types.js';

export type DiscoveryQuery = {
  capabilities?: string[];
  runtime?: string;
  availability?: AgentAvailability[];
  labels?: Record<string, string>;
  trustDomain?: string;
  taskKind?: string;
  explore?: boolean;
};
export type AgentCandidate = { agent: AgentRegistration; reasons: string[]; evidence: AgentRegistration['evidence']; exploratory: boolean };

function hasAll(values: string[], required: string[]): boolean { return required.every(value => values.includes(value)); }
function matches(agent: AgentRegistration, query: DiscoveryQuery): boolean {
  if (query.capabilities && !hasAll(agent.capabilities, query.capabilities)) return false;
  if (query.runtime && agent.runtime.adapter !== query.runtime) return false;
  if (query.availability && !query.availability.includes(agent.availability)) return false;
  if (query.trustDomain && !agent.routing.trustDomains?.includes(query.trustDomain)) return false;
  return !query.labels || Object.entries(query.labels).every(([key, value]) => agent.routing.labels?.[key] === value);
}
function reliability(agent: AgentRegistration): number { const { succeeded, failed, timedOut } = agent.evidence.outcomes; const total = succeeded + failed + timedOut; return total === 0 ? 0 : succeeded / total; }

export function discoverAgents(agents: AgentRegistration[], query: DiscoveryQuery = {}): AgentCandidate[] {
  const candidates = agents.filter(agent => matches(agent, query)).map(agent => {
    const evaluated = query.taskKind ? agent.evidence.evaluations.some(item => item.taskKind === query.taskKind) : agent.evidence.evaluations.length > 0;
    const reasons = [query.capabilities?.length ? `capabilities: ${query.capabilities.join(', ')}` : 'capabilities matched', evaluated ? 'observed evidence available' : 'no observed evidence yet'];
    return { agent, reasons, evidence: agent.evidence, exploratory: !evaluated };
  });
  return candidates.sort((left, right) => {
    if (query.explore && left.exploratory !== right.exploratory) return left.exploratory ? -1 : 1;
    if (left.agent.availability !== right.agent.availability) return left.agent.availability === 'available' ? -1 : 1;
    return reliability(right.agent) - reliability(left.agent);
  });
}
