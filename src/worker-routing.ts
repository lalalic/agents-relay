import { chooseWithDecision, DecisionEngine, DecisionMode, JsonValue } from './decision.js';
import { AccountUsageOverview } from './usage.js';
import { AdapterName, AgentAvailability, AgentRegistration, ResourceUsageWindow, WorkerRequirements, WorkerSelection } from './types.js';

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
  resourceHealthy?: boolean;
  resourceProvider?: string;
  resourceUsedPercent?: number;
  resourceRemainingPercent?: number;
  resourceResetAt?: number;
  resourceResetInMinutes?: number;
  resourceWindows?: { fiveHour?: ResourceUsageWindow; weekly?: ResourceUsageWindow };
};

export type WorkerRoutingDecision = { candidate: WorkerCandidate; selection: WorkerSelection };
export type WorkerRoutingOptions = {
  decisionEngine?: DecisionEngine;
  decisionMode?: DecisionMode;
  taskFacts?: Record<string, unknown>;
};

export function usageForProvider(snapshot: AccountUsageOverview | undefined, provider: string, now = Date.now()): { healthy?: boolean; usedPercent?: number; remainingPercent?: number; resetAt?: number; resetInMinutes?: number; windows?: { fiveHour?: ResourceUsageWindow; weekly?: ResourceUsageWindow } } {
  const usage = snapshot?.providers.find(item => item.id === provider)?.usage;
  if (usage?.available) {
    const usedPercent = Math.max(usage.fiveHour?.usedPercent ?? 0, usage.weekly?.usedPercent ?? 0);
    const resourceWindow = (window: typeof usage.fiveHour): ResourceUsageWindow | undefined => {
      if (!window) return undefined;
      const resetAt = window.resetsAt;
      return {
        remainingPercent: 100 - window.usedPercent,
        resetAt,
        resetInMinutes: resetAt === null ? null : Math.max(0, Math.ceil((resetAt * 1000 - now) / 60_000)),
      };
    };
    const windows = { fiveHour: resourceWindow(usage.fiveHour), weekly: resourceWindow(usage.weekly) };
    const resetWindow = [usage.fiveHour, usage.weekly]
      .filter((window): window is NonNullable<typeof window> => window?.resetsAt !== null && window?.resetsAt !== undefined)
      .filter(window => window.resetsAt! * 1000 > now)
      .sort((left, right) => left.resetsAt! - right.resetsAt!)[0];
    return {
      healthy: usedPercent < 100,
      usedPercent,
      remainingPercent: resetWindow ? 100 - resetWindow.usedPercent : undefined,
      resetAt: resetWindow?.resetsAt ?? undefined,
      resetInMinutes: resetWindow?.resetsAt ? Math.max(0, Math.ceil((resetWindow.resetsAt * 1000 - now) / 60_000)) : undefined,
      windows,
    };
  }
  const credits = snapshot?.credits.find(item => item.id === provider)?.credits;
  if (credits?.available) {
    const knownRemaining = credits.balances.map(item => item.remaining).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (knownRemaining.length > 0) return { healthy: knownRemaining.some(value => value > 0) };
  }
  return {};
}

export function workerCandidates(
  adapters: readonly { name: AdapterName; id: string; capabilities: readonly string[] }[],
  registered: readonly AgentRegistration[],
  snapshot?: AccountUsageOverview,
): WorkerCandidate[] {
  return adapters.filter(adapter => adapter.name !== 'orchestrator').flatMap(adapter => {
    const workers = registered.filter(worker => worker.runtime.adapter === adapter.name);
    return (workers.length > 0 ? workers : [undefined]).map(worker => {
      const provider = worker?.runtime.provider ?? (adapter.name === 'chatgpt' ? 'chatgpt' : 'openai');
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
        resourceRemainingPercent: resource.remainingPercent,
        resourceResetAt: resource.resetAt,
        resourceResetInMinutes: resource.resetInMinutes,
        resourceWindows: resource.windows,
      };
    });
  });
}

export function satisfiesWorker(candidate: WorkerCandidate, requirements: WorkerRequirements): boolean {
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

export function eligibleWorkerCandidates(candidates: readonly WorkerCandidate[], requirements: WorkerRequirements): WorkerCandidate[] {
  return candidates.filter(candidate => satisfiesWorker(candidate, requirements));
}

function deterministicWorker(eligible: readonly WorkerCandidate[]): WorkerCandidate {
  return [...eligible].map((candidate, index) => ({ candidate, index })).sort((left, right) => {
    const pressure = (item: WorkerCandidate): number => item.resourceUsedPercent === undefined ? 1 : item.resourceUsedPercent >= 90 ? 2 : 0;
    return pressure(left.candidate) - pressure(right.candidate) || left.index - right.index;
  })[0].candidate;
}

function selection(selected: WorkerCandidate, selectedBy: string, decisionEvidence?: WorkerSelection['decisionEvidence']): WorkerSelection {
  return {
    workerId: selected.workerId,
    adapter: selected.adapter,
    capabilities: [...selected.capabilities],
    selectedBy,
    selectedAt: new Date().toISOString(),
    resourceHealthy: selected.resourceHealthy,
    resourceProvider: selected.resourceProvider,
    resourceUsedPercent: selected.resourceUsedPercent,
    resourceRemainingPercent: selected.resourceRemainingPercent,
    resourceResetAt: selected.resourceResetAt,
    resourceResetInMinutes: selected.resourceResetInMinutes,
    resourceWindows: selected.resourceWindows,
    decisionEvidence,
  };
}

/** Deterministic fallback and backwards-compatible direct selector. */
export function selectWorker(candidates: readonly WorkerCandidate[], requirements: WorkerRequirements): WorkerRoutingDecision {
  const eligible = eligibleWorkerCandidates(candidates, requirements);
  if (eligible.length === 0) throw new Error('No eligible worker satisfies the declared requirements');
  const selected = deterministicWorker(eligible);
  return { candidate: selected, selection: selection(selected, 'worker-router:requirements') };
}

/** Gathered facts and hard gates stay in code; Laya only judges among legal choices. */
export async function routeWorker(
  candidates: readonly WorkerCandidate[],
  requirements: WorkerRequirements,
  options: WorkerRoutingOptions = {},
): Promise<WorkerRoutingDecision> {
  const eligible = eligibleWorkerCandidates(candidates, requirements);
  if (eligible.length === 0) throw new Error('No eligible worker satisfies the declared requirements');
  const deterministic = deterministicWorker(eligible);
  if (eligible.length === 1) {
    const evidence = { mode: options.decisionMode ?? 'off', fallback: true } as const;
    return { candidate: deterministic, selection: selection(deterministic, 'worker-router:requirements', evidence) };
  }
  const facts = JSON.parse(JSON.stringify({
    task: options.taskFacts ?? {},
    requirements,
    candidates: eligible.map(item => ({
      id: item.workerId,
      adapter: item.adapter,
      capabilities: [...item.capabilities],
      runtime: item.runtime ?? null,
      resourceHealthy: item.resourceHealthy ?? null,
      resourceProvider: item.resourceProvider ?? null,
      resourceUsedPercent: item.resourceUsedPercent ?? null,
      resourceRemainingPercent: item.resourceRemainingPercent ?? null,
      resourceResetAt: item.resourceResetAt ?? null,
      resourceResetInMinutes: item.resourceResetInMinutes ?? null,
      resourceWindows: item.resourceWindows ?? null,
    })),
  })) as JsonValue;
  const choice = await chooseWithDecision(
    options.decisionEngine,
    options.decisionMode ?? 'off',
    { facts },
    { type: 'choice', question: 'Which eligible worker is best suited to execute this task?', choices: eligible.map(item => item.workerId) },
    () => deterministic.workerId,
  );
  const selected = eligible.find(item => item.workerId === choice.choice) ?? deterministic;
  const selectedBy = choice.evidence.engine && !choice.evidence.fallback ? 'worker-router:laya' : 'worker-router:requirements';
  return { candidate: selected, selection: selection(selected, selectedBy, choice.evidence) };
}
