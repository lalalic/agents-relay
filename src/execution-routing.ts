import { chooseWithDecision, DecisionEngine, DecisionMode, JsonValue } from './decision.js';
import { DecisionAuditRecord, DecisionAuditStore, makeExecutionDecisionAudit } from './decision-audit.js';
import { discoverModelCandidates, ModelCandidate } from './model-routing.js';
import { loadExecutionRouterRules, loadRoutingPolicy, policyAllows } from './routing-policy.js';
import { AccountUsageOverview } from './usage.js';
import { AgentRegistration, RoutingDecision, Task, WorkerRequirements, WorkerSelection } from './types.js';
import { DEFAULT_CHATGPT_PREFERRED_CONCURRENCY, WorkerCandidate } from './worker-routing.js';

export type ExecutionRouteCandidate = {
  id: string;
  worker: WorkerCandidate;
  model: ModelCandidate;
};

export type ExecutionRouteEvaluation = {
  route: ExecutionRouteCandidate;
  eligible: boolean;
  rejectionReasons: string[];
};

export type WorkerGateEvaluation = {
  workerId: string;
  eligible: boolean;
  rejectionReasons: string[];
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

function workerGateReasons(worker: WorkerCandidate, requirements: WorkerRequirements): string[] {
  const reasons: string[] = [];
  if (worker.availability === 'offline') reasons.push('worker_offline');
  if (requirements.runtime && worker.runtime !== requirements.runtime) reasons.push('runtime_constraint');
  if (worker.adapter === 'chatgpt' && worker.browserWorkspaceCapacity?.available === 0) reasons.push('browser_workspace_exhausted');
  return reasons;
}

function modelGateReasons(
  candidate: ModelCandidate,
  constraints: ExecutionRoutingOptions['routingConstraints'],
  excludedRoutes: ExecutionRoutingOptions['excludedRoutes'],
  policy: Awaited<ReturnType<typeof loadRoutingPolicy>>,
): string[] {
  const reasons: string[] = [];
  if (candidate.resourceHealthy === false) reasons.push('resource_unhealthy');
  if ((excludedRoutes ?? []).some(route => sameModelRoute(candidate, route))) reasons.push('prior_failed_route');
  if (!policyAllows(candidate, policy.policy)) {
    if (policy.policy.disabledProviders?.includes(candidate.provider)) reasons.push('policy_disabled_provider');
    if (candidate.profile && policy.policy.disabledProfiles?.includes(candidate.profile)) reasons.push('policy_disabled_profile');
  }
  if (constraints?.provider && candidate.provider !== constraints.provider) reasons.push('provider_constraint');
  if (constraints?.model && candidate.model !== constraints.model) reasons.push('model_constraint');
  if (constraints?.profile && candidate.profile !== constraints.profile) reasons.push('profile_constraint');
  if (constraints?.reasoning && candidate.reasoning && candidate.reasoning !== constraints.reasoning) reasons.push('reasoning_constraint');
  return reasons;
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
): Promise<{
  routes: ExecutionRouteCandidate[];
  evaluations: ExecutionRouteEvaluation[];
  workerGateEvaluations: WorkerGateEvaluation[];
  policy: Awaited<ReturnType<typeof loadRoutingPolicy>>;
}> {
  const registered = options.registered ?? [];
  const policy = await loadRoutingPolicy(options.policyPath, options.rulesPath);
  const workerGateEvaluations = workers.map(worker => {
    const rejectionReasons = workerGateReasons(worker, requirements);
    return { workerId: worker.workerId, eligible: rejectionReasons.length === 0, rejectionReasons };
  });
  const evaluations: ExecutionRouteEvaluation[] = [];
  for (const worker of workers) {
    const workerReasons = workerGateEvaluations.find(item => item.workerId === worker.workerId)?.rejectionReasons ?? [];
    const models = await discoverModelCandidates(worker, registered, options.usage, undefined, options.rulesPath);
    for (const model of models) {
      const rejectionReasons = [...workerReasons, ...modelGateReasons(model, options.routingConstraints, options.excludedRoutes, policy)];
      const route = { id: routeId(worker, model), worker, model };
      evaluations.push({ route, eligible: rejectionReasons.length === 0, rejectionReasons });
    }
  }
  const routes = evaluations.filter(item => item.eligible).map(item => item.route);
  return { routes, evaluations, workerGateEvaluations, policy };
}

export async function routeExecution(
  workers: readonly WorkerCandidate[],
  requirements: WorkerRequirements,
  options: ExecutionRoutingOptions = {},
): Promise<ExecutionRoutingDecision> {
  const { routes, evaluations, workerGateEvaluations, policy } = await discoverExecutionRoutes(workers, requirements, options);
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

  const decisionRequest = { facts };
  const decisionContract = {
    type: 'choice' as const,
    question: 'Choose the best complete execution route for this task. The listed candidates are already executable. Treat all non-impossibility signals as soft facts, follow free-text user guidance, and choose worker+model together in this one decision.',
    choices: routes.map(route => route.id),
  };
  const choice = await chooseWithDecision(
    options.decisionEngine,
    options.decisionMode ?? 'off',
    decisionRequest,
    decisionContract,
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

  const audit = makeExecutionDecisionAudit({
    task: options.auditTask,
    workers,
    requirements,
    evaluations,
    workerGateEvaluations,
    selected,
    contract: {
      question: 'execution-route-selection',
      task: options.taskFacts ?? {},
      workerRequirements: requirements,
      constraints: options.routingConstraints ?? {},
      excludedRoutes: options.excludedRoutes ?? [],
      candidateRoutes: routes.map(route => ({ id: route.id, workerId: route.worker.workerId, adapter: route.worker.adapter })),
    },
    policy,
    routing,
    decisionRequest,
    decisionContract,
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
