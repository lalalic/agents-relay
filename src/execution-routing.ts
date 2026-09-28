import { chooseWithDecision, DecisionEngine, DecisionMode, JsonValue } from './decision.js';
import { DecisionAuditRecord, DecisionAuditStore, makeDecisionAudit } from './decision-audit.js';
import { discoverModelCandidates, ModelCandidate } from './model-routing.js';
import { loadExecutionRouterRules, loadRoutingPolicy, policyAllows } from './routing-policy.js';
import { AccountUsageOverview } from './usage.js';
import { AgentRegistration, RoutingDecision, Task, WorkerRequirements, WorkerSelection } from './types.js';
import { DEFAULT_CHATGPT_PREFERRED_CONCURRENCY, eligibleWorkerCandidates, WorkerCandidate } from './worker-routing.js';

export type ExecutionRouteCandidate = {
  id: string;
  worker: WorkerCandidate;
  model: ModelCandidate;
};

export type ExecutionRoutingDecision = {
  candidate: WorkerCandidate & { routing: RoutingDecision };
  selection: WorkerSelection;
  model: ModelCandidate;
  audit?: DecisionAuditRecord;
};

export type ExecutionRoutingOptions = {
  decisionEngine?: DecisionEngine;
  decisionMode?: DecisionMode;
  taskFacts?: Record<string, unknown>;
  usage?: AccountUsageOverview;
  registered?: readonly AgentRegistration[];
  rulesPath?: string;
  policyPath?: string;
  chatgptRunning?: number;
  preferredChatgptConcurrency?: number;
  routingConstraints?: Partial<Pick<RoutingDecision, 'provider' | 'model' | 'profile' | 'reasoning'>>;
  excludedRoutes?: Array<Partial<Pick<RoutingDecision, 'provider' | 'model' | 'profile'>>>;
  auditStore?: DecisionAuditStore;
  auditTask?: Task;
};

function sameModelRoute(candidate: ModelCandidate, route: Partial<Pick<RoutingDecision, 'provider' | 'model' | 'profile'>>): boolean {
  return (!route.provider || candidate.provider === route.provider)
    && (!route.model || candidate.model === route.model)
    && (route.profile === undefined || candidate.profile === route.profile);
}

function modelUsable(
  candidate: ModelCandidate,
  constraints: ExecutionRoutingOptions['routingConstraints'],
  excludedRoutes: ExecutionRoutingOptions['excludedRoutes'],
  policy: Awaited<ReturnType<typeof loadRoutingPolicy>>,
): boolean {
  if (candidate.resourceHealthy === false) return false;
  if ((excludedRoutes ?? []).some(route => sameModelRoute(candidate, route))) return false;
  if (!policyAllows(candidate, policy.policy)) return false;
  if (constraints?.provider && candidate.provider !== constraints.provider) return false;
  if (constraints?.model && candidate.model !== constraints.model) return false;
  if (constraints?.profile && candidate.profile !== constraints.profile) return false;
  if (constraints?.reasoning && candidate.reasoning && candidate.reasoning !== constraints.reasoning) return false;
  return true;
}

function routeId(worker: WorkerCandidate, model: ModelCandidate): string {
  return `${worker.workerId}::${model.id}`;
}

function fallbackRoute(routes: readonly ExecutionRouteCandidate[]): ExecutionRouteCandidate {
  const codex = routes.filter(route => route.worker.adapter === 'codex');
  return codex.find(route => route.model.id.startsWith('default:')) ?? codex[0] ?? routes[0];
}

function workerSelection(worker: WorkerCandidate, selectedBy: string, evidence: WorkerSelection['decisionEvidence']): WorkerSelection {
  return {
    workerId: worker.workerId,
    adapter: worker.adapter,
    capabilities: [...worker.capabilities],
    selectedBy,
    selectedAt: new Date().toISOString(),
    resourceHealthy: worker.resourceHealthy,
    resourceProvider: worker.resourceProvider,
    resourceUsedPercent: worker.resourceUsedPercent,
    resourceRemainingPercent: worker.resourceRemainingPercent,
    resourceResetAt: worker.resourceResetAt,
    resourceResetInMinutes: worker.resourceResetInMinutes,
    resourceWindows: worker.resourceWindows,
    browserWorkspaceCapacity: worker.browserWorkspaceCapacity,
    decisionEvidence: evidence,
  };
}

export async function discoverExecutionRoutes(
  workers: readonly WorkerCandidate[],
  requirements: WorkerRequirements,
  options: ExecutionRoutingOptions = {},
): Promise<{ routes: ExecutionRouteCandidate[]; policy: Awaited<ReturnType<typeof loadRoutingPolicy>> }> {
  const legalWorkers = eligibleWorkerCandidates(workers, requirements);
  const registered = options.registered ?? [];
  const policy = await loadRoutingPolicy(options.policyPath, options.rulesPath);
  const routes: ExecutionRouteCandidate[] = [];
  for (const worker of legalWorkers) {
    const models = await discoverModelCandidates(worker, registered, options.usage, undefined, options.rulesPath);
    for (const model of models) {
      if (!modelUsable(model, options.routingConstraints, options.excludedRoutes, policy)) continue;
      routes.push({ id: routeId(worker, model), worker, model });
    }
  }
  return { routes, policy };
}

export async function routeExecution(
  workers: readonly WorkerCandidate[],
  requirements: WorkerRequirements,
  options: ExecutionRoutingOptions = {},
): Promise<ExecutionRoutingDecision> {
  const { routes, policy } = await discoverExecutionRoutes(workers, requirements, options);
  if (routes.length === 0) throw new Error('No executable worker+model route satisfies authoritative constraints');

  const fallback = fallbackRoute(routes);
  const rules = await loadExecutionRouterRules(options.rulesPath);
  const environmentRules = rules.text;
  const preferredChatgptConcurrency = options.preferredChatgptConcurrency ?? DEFAULT_CHATGPT_PREFERRED_CONCURRENCY;
  const chatgptRunning = options.chatgptRunning ?? 0;

  const facts = JSON.parse(JSON.stringify({
    task: options.taskFacts ?? {},
    worker_requirements: requirements,
    explicit_routing_constraints: options.routingConstraints ?? {},
    environment_rules: environmentRules,
    structured_policy: policy.snapshot,
    usage_snapshot: options.usage ?? null,
    runtime_load: {
      chatgpt_running: chatgptRunning,
      preferred_chatgpt_concurrency: preferredChatgptConcurrency,
    },
    routing_principles: [
      'Choose one complete executable route: worker plus provider/model/profile/reasoning.',
      'Only authoritative impossibility constraints are hard gates; all other task fit, capability, trust, region, labels, quota, cost, latency, load, reviewer diversity, and quality signals are soft facts.',
      'User free-text environment rules are soft routing guidance and should be followed when they express a clear preference.',
      'Codex is only the deterministic fallback when the decision engine fails; Codex is not a normal preference when decide() succeeds.',
    ],
    candidates: routes.map(route => ({
      id: route.id,
      worker: {
        id: route.worker.workerId,
        adapter: route.worker.adapter,
        runtime: route.worker.runtime ?? null,
        availability: route.worker.availability ?? null,
        capabilities: [...route.worker.capabilities],
        trustDomains: route.worker.trustDomains ?? [],
        region: route.worker.region ?? null,
        labels: route.worker.labels ?? {},
        browserWorkspaceCapacity: route.worker.browserWorkspaceCapacity ?? null,
      },
      model: {
        provider: route.model.provider,
        model: route.model.model,
        profile: route.model.profile ?? null,
        reasoning: route.model.reasoning ?? null,
        resourceHealthy: route.model.resourceHealthy ?? null,
        resourceUsedPercent: route.model.resourceUsedPercent ?? null,
        resourceRemainingPercent: route.model.resourceRemainingPercent ?? null,
        resourceResetAt: route.model.resourceResetAt ?? null,
        resourceResetInMinutes: route.model.resourceResetInMinutes ?? null,
        resourceWindows: route.model.resourceWindows ?? null,
      },
    })),
  })) as JsonValue;

  const choice = await chooseWithDecision(
    options.decisionEngine,
    options.decisionMode ?? 'off',
    { facts },
    {
      type: 'choice',
      question: 'Choose the best complete execution route for this task. The listed candidates are already executable. Treat all non-impossibility signals as soft facts, follow free-text user guidance, and choose worker+model together in this one decision.',
      choices: routes.map(route => route.id),
    },
    () => fallback.id,
  );

  const selected = routes.find(route => route.id === choice.choice) ?? fallback;
  const selectedBy = choice.evidence.engine && !choice.evidence.fallback ? 'execution-router:laya' : 'execution-router:fallback';
  const routing: RoutingDecision = {
    provider: selected.model.provider,
    model: selected.model.model,
    profile: selected.model.profile,
    reasoning: options.routingConstraints?.reasoning ?? selected.model.reasoning,
    decidedBy: selectedBy,
    decidedAt: new Date().toISOString(),
    decisionEvidence: choice.evidence,
  };

  const audit = makeDecisionAudit({
    task: options.auditTask,
    worker: { id: selected.worker.workerId, adapter: selected.worker.adapter, capabilities: [...selected.worker.capabilities], route_id: selected.id },
    contract: {
      question: 'execution-route-selection',
      task: options.taskFacts ?? {},
      workerRequirements: requirements,
      constraints: options.routingConstraints ?? {},
      excludedRoutes: options.excludedRoutes ?? [],
      candidateRoutes: routes.map(route => ({ id: route.id, workerId: route.worker.workerId, adapter: route.worker.adapter })),
    },
    policy,
    candidates: routes.map(route => ({ ...route.model, id: route.id })),
    eligibleCandidates: routes.map(route => ({ ...route.model, id: route.id })),
    selected: { ...selected.model, id: selected.id },
    routing,
  });
  routing.decisionId = audit.decision_id;
  if (options.auditStore) await options.auditStore.append(audit);

  return {
    candidate: { ...selected.worker, routing },
    selection: workerSelection(selected.worker, selectedBy, choice.evidence),
    model: selected.model,
    audit,
  };
}
