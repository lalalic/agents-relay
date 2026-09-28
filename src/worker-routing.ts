import { chooseWithDecision, DecisionEngine, DecisionMode, JsonValue } from './decision.js';
import { loadExecutionRouterRules } from './routing-policy.js';
import { AccountUsageOverview } from './usage.js';
import { AdapterName, AgentAvailability, AgentRegistration, BrowserWorkspaceCapacity, ResourceUsageWindow, WorkerRequirements, WorkerSelection } from './types.js';

export const DEFAULT_CHATGPT_PREFERRED_CONCURRENCY = 10;

export const DEFAULT_WORKER_ROUTER_PRINCIPLES = [
  'User-provided environment_rules are higher-priority routing guidance than these built-in defaults. Follow user guidance when it conflicts with a default unless doing so would violate an authoritative hard constraint.',
  'Worker Router chooses only the execution worker. Model Router chooses provider/model/profile after worker selection.',
  'Prefer ChatGPT when both workers can execute the task because it does not consume Codex coding-plan tokens and normally has access to a stronger ChatGPT Sol model.',
  'Prefer Codex when the task requires native/local execution or computer-use abilities that are unavailable through ChatGPT plus MacBridge.',
  'Treat coding-plan/provider quota as decision context, not worker legality. Codex may still use another provider selected later by Model Router.',
  'When Codex/OpenAI coding quota is scarce, prefer ChatGPT unless the Codex execution environment is necessary.',
  'When current ChatGPT running load reaches the preferred ChatGPT concurrency, strongly prefer Codex unless ChatGPT is materially required or better suited for the task.',
].join('\n');

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
  browserWorkspaceCapacity?: BrowserWorkspaceCapacity;
};

export type WorkerRoutingDecision = { candidate: WorkerCandidate; selection: WorkerSelection };
export type WorkerRoutingOptions = {
  decisionEngine?: DecisionEngine;
  decisionMode?: DecisionMode;
  taskFacts?: Record<string, unknown>;
  usage?: AccountUsageOverview;
  rulesPath?: string;
  chatgptRunning?: number;
  preferredChatgptConcurrency?: number;
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
  if (credits) {
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
      const provider = worker?.runtime.provider ?? (adapter.name === 'chatgpt' ? 'chatgpt' : undefined);
      const resource = provider ? usageForProvider(snapshot, provider) : {};
      return {
        workerId: worker?.id ?? adapter.id,
        adapter: adapter.name as Exclude<AdapterName, 'orchestrator'>,
        capabilities: worker?.capabilities ?? [...adapter.capabilities],
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
        browserWorkspaceCapacity: adapter.name === 'chatgpt' ? snapshot?.browserWorkspace : undefined,
      };
    });
  });
}

/**
 * Worker legality is intentionally narrow. Descriptive capability labels and provider
 * quota are facts for decide(), not hard gates. An explicit runtime is retained as a
 * compatibility/caller-owned constraint, and an explicitly offline worker is illegal.
 */
export function satisfiesWorker(candidate: WorkerCandidate, requirements: WorkerRequirements): boolean {
  if (candidate.availability === 'offline') return false;
  if (requirements.runtime && candidate.runtime !== requirements.runtime) return false;
  if (candidate.adapter === 'chatgpt' && candidate.browserWorkspaceCapacity?.available === 0) return false;
  return true;
}

export function eligibleWorkerCandidates(candidates: readonly WorkerCandidate[], requirements: WorkerRequirements): WorkerCandidate[] {
  return candidates.filter(candidate => satisfiesWorker(candidate, requirements));
}

function deterministicWorker(eligible: readonly WorkerCandidate[]): WorkerCandidate {
  return eligible.find(candidate => candidate.adapter === 'codex') ?? eligible[0];
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
    browserWorkspaceCapacity: selected.browserWorkspaceCapacity,
    decisionEvidence,
  };
}

/** Deterministic fallback and backwards-compatible direct selector. */
export function selectWorker(candidates: readonly WorkerCandidate[], requirements: WorkerRequirements): WorkerRoutingDecision {
  const eligible = eligibleWorkerCandidates(candidates, requirements);
  if (eligible.length === 0) throw new Error(noEligibleWorkerReason(candidates));
  const selected = deterministicWorker(eligible);
  return { candidate: selected, selection: selection(selected, 'worker-router:fallback') };
}

function noEligibleWorkerReason(candidates: readonly WorkerCandidate[]): string {
  if (candidates.some(candidate => candidate.adapter === 'chatgpt' && candidate.browserWorkspaceCapacity?.available === 0)) {
    return 'No eligible worker: ChatGPT Browser Workspace has no allocatable capacity.';
  }
  return 'No eligible worker satisfies the authoritative worker constraints';
}

/** Gather factual worker/task/resource context, then let decide() choose among legal workers. */
export async function routeWorker(
  candidates: readonly WorkerCandidate[],
  requirements: WorkerRequirements,
  options: WorkerRoutingOptions = {},
): Promise<WorkerRoutingDecision> {
  const eligible = eligibleWorkerCandidates(candidates, requirements);
  if (eligible.length === 0) throw new Error(noEligibleWorkerReason(candidates));
  const preferredChatgptConcurrency = options.preferredChatgptConcurrency ?? DEFAULT_CHATGPT_PREFERRED_CONCURRENCY;
  const chatgptRunning = options.chatgptRunning ?? 0;
  const deterministic = deterministicWorker(eligible);
  if (eligible.length === 1) {
    const evidence = { mode: options.decisionMode ?? 'off', fallback: true } as const;
    return { candidate: deterministic, selection: selection(deterministic, 'worker-router:constraint', evidence) };
  }

  const rules = await loadExecutionRouterRules(options.rulesPath);
  const facts = JSON.parse(JSON.stringify({
    task: options.taskFacts ?? {},
    explicit_constraints: { runtime: requirements.runtime ?? null },
    decision_precedence: ['authoritative_hard_constraints', 'environment_rules', 'routing_principles', 'resource_and_runtime_preferences'],
    environment_rules: rules.text,
    routing_principles: DEFAULT_WORKER_ROUTER_PRINCIPLES,
    usage_snapshot: options.usage ?? null,
    runtime_load: {
      chatgpt_running: chatgptRunning,
      preferred_chatgpt_concurrency: preferredChatgptConcurrency,
    },
    candidates: eligible.map(item => ({
      id: item.workerId,
      adapter: item.adapter,
      runtime: item.runtime ?? null,
      availability: item.availability ?? null,
      declaredCapabilities: [...item.capabilities],
      resourceProvider: item.resourceProvider ?? null,
      resourceHealthy: item.resourceHealthy ?? null,
      resourceUsedPercent: item.resourceUsedPercent ?? null,
      resourceRemainingPercent: item.resourceRemainingPercent ?? null,
      resourceResetAt: item.resourceResetAt ?? null,
      resourceResetInMinutes: item.resourceResetInMinutes ?? null,
      resourceWindows: item.resourceWindows ?? null,
      browserWorkspaceCapacity: item.browserWorkspaceCapacity ?? null,
    })),
  })) as JsonValue;

  const choice = await chooseWithDecision(
    options.decisionEngine,
    options.decisionMode ?? 'off',
    { facts },
    {
      type: 'choice',
      question: 'Choose the best execution worker for this task. Authoritative hard constraints come first. Then follow user-provided environment rules ahead of built-in routing principles when they conflict. Use task facts, reviewer-diversity context when present, current usage, and runtime load as supporting evidence. Do not choose a provider or model here.',
      choices: eligible.map(item => item.workerId),
    },
    () => deterministic.workerId,
  );
  const selected = eligible.find(item => item.workerId === choice.choice) ?? deterministic;
  const selectedBy = choice.evidence.engine && !choice.evidence.fallback ? 'worker-router:laya' : 'worker-router:fallback';
  return { candidate: selected, selection: selection(selected, selectedBy, choice.evidence) };
}
