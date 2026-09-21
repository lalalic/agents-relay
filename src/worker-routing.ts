import { AccountUsageOverview } from './usage.js';
import { AdapterName, AgentAvailability, AgentRegistration, RoutingDecision, WorkerRequirements, WorkerSelection } from './types.js';

export type WorkerCandidate = {
  workerId: string;
  adapter: Exclude<AdapterName, 'orchestrator'>;
  capabilities: readonly string[];
  runtime?: string;
  taskKind?: string;
  trustDomains?: readonly string[];
  region?: string;
  labels?: Readonly<Record<string, string>>;
  availability?: AgentAvailability;
  routing: RoutingDecision;
  resourceHealthy?: boolean;
  resourceProvider?: string;
  resourceUsedPercent?: number;
};

export type WorkerRoutingDecision = { candidate: WorkerCandidate; selection: WorkerSelection };

export function usageForProvider(snapshot: AccountUsageOverview | undefined, provider: string): { healthy?: boolean; usedPercent?: number } {
  const usage = snapshot?.providers.find(item => item.id === provider)?.usage;
  if (!usage || !usage.available) return {};
  const usedPercent = Math.max(usage.fiveHour?.usedPercent ?? 0, usage.weekly?.usedPercent ?? 0);
  return { healthy: usedPercent < 100, usedPercent };
}

export function workerCandidates(
  adapters: readonly { name: AdapterName; id: string; capabilities: readonly string[] }[],
  registered: readonly AgentRegistration[],
  snapshot?: AccountUsageOverview,
): WorkerCandidate[] {
  return adapters.filter(adapter => adapter.name !== 'orchestrator').flatMap(adapter => {
    const defaults = adapter.name === 'chatgpt' ? { provider: 'chatgpt', model: 'account-defaults' } : { provider: 'openai', model: 'gpt-5.6-luna' };
    const workers = registered.filter(worker => worker.runtime.adapter === adapter.name);
    return (workers.length > 0 ? workers : [undefined]).map(worker => {
      const provider = worker?.runtime.provider ?? defaults.provider;
      const resource = usageForProvider(snapshot, provider);
      return {
        workerId: worker?.id ?? adapter.id,
        adapter: adapter.name as Exclude<AdapterName, 'orchestrator'>,
        capabilities: worker?.capabilities ?? [
          ...adapter.capabilities,
          ...(adapter.name === 'codex' ? ['local_repo', 'iterative_tools', 'long_running'] : ['web_session', 'attachments', 'interactive_ui', 'one_shot']),
        ],
        runtime: worker?.runtime.adapter ?? adapter.name,
        trustDomains: worker?.routing.trustDomains,
        region: worker?.routing.regions?.[0],
        labels: worker?.routing.labels,
        availability: worker?.availability,
        resourceHealthy: resource.healthy,
        resourceProvider: provider,
        resourceUsedPercent: resource.usedPercent,
        routing: { provider, model: worker?.runtime.model ?? defaults.model, decidedBy: 'model-router', decidedAt: new Date().toISOString() },
      };
    });
  });
}

function satisfies(candidate: WorkerCandidate, requirements: WorkerRequirements): boolean {
  if (candidate.availability && candidate.availability !== 'available') return false;
  if (candidate.resourceHealthy === false) return false;
  if (!requirements.capabilities.every(capability => candidate.capabilities.includes(capability))) return false;
  if (requirements.runtime && candidate.runtime !== requirements.runtime) return false;
  if (requirements.taskKind && candidate.taskKind !== requirements.taskKind) return false;
  if (requirements.trustDomain && !candidate.trustDomains?.includes(requirements.trustDomain)) return false;
  if (requirements.region && candidate.region !== requirements.region) return false;
  if (requirements.labels && Object.entries(requirements.labels).some(([key, value]) => candidate.labels?.[key] !== value)) return false;
  return true;
}

export function selectWorker(candidates: readonly WorkerCandidate[], requirements: WorkerRequirements): WorkerRoutingDecision {
  const eligible = candidates.filter(candidate => satisfies(candidate, requirements));
  if (eligible.length === 0) throw new Error('No eligible worker satisfies the declared requirements');
  const ranked = eligible.map((candidate, index) => ({ candidate, index })).sort((a, b) => {
    const pressure = (item: WorkerCandidate): number => item.resourceUsedPercent === undefined ? 1 : item.resourceUsedPercent >= 90 ? 2 : 0;
    return pressure(a.candidate) - pressure(b.candidate) || a.index - b.index;
  });
  const selected = ranked[0].candidate;
  return {
    candidate: selected,
    selection: {
      workerId: selected.workerId,
      adapter: selected.adapter,
      capabilities: [...selected.capabilities],
      selectedBy: 'worker-router:requirements',
      selectedAt: new Date().toISOString(),
      resourceHealthy: selected.resourceHealthy,
      resourceProvider: selected.resourceProvider,
      resourceUsedPercent: selected.resourceUsedPercent,
    },
  };
}
