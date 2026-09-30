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

export function executionTaskShape(taskFacts: Record<string, unknown> = {}): {
  storySize: 'S' | 'M' | 'L';
  sustainedWork: boolean;
  preferredWorker: 'chatgpt' | 'codex';
  reason: string;
} {
  const raw = taskFacts.storySize;
  const storySize = raw === 'S' || raw === 'L' ? raw : 'M';
  const sustainedWork = storySize === 'L';
  return {
    storySize,
    sustainedWork,
    preferredWorker: sustainedWork ? 'codex' : 'chatgpt',
    reason: sustainedWork
      ? 'Large/sustained tasks favor Codex.'
      : 'Small/medium tasks favor ChatGPT when Browser Workspace capacity is available.',
  };
}

export const EXECUTION_ROUTING_PRINCIPLES = [
  'Choose one complete executable route: worker plus provider/model/profile/reasoning.',
  'ChatGPT with MacBridge and Codex have broadly overlapping execution capabilities.',
  'preferred_routes is the primary soft worker-fit preference derived from task size: S/M prefer ChatGPT, L prefers Codex.',
  "Browser Workspace exhaustion is ChatGPT's primary hard execution constraint.",
  'Concrete user rules, resource health, quota, or load facts may override preferred_routes.',
  'Codex is only the deterministic fallback when the decision engine fails.',
] as const;

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

  const taskFacts = options.taskFacts ?? {};
  const taskShape = executionTaskShape(taskFacts);
  const facts = JSON.parse(JSON.stringify({
    task_shape: {
      story_size: taskShape.storySize,
      sustained_work: taskShape.sustainedWork,
      preferred_worker: taskShape.preferredWorker,
      reason: taskShape.reason,
    },
    environment_rules: environmentRules,
    reviewer_context: taskFacts.reviewer_diversity ? {
      role: taskFacts.role ?? null,
      reviewer_diversity: taskFacts.reviewer_diversity,
    } : null,
    runtime_load: {
      chatgpt_running: chatgptRunning,
      preferred_chatgpt_concurrency: preferredChatgptConcurrency,
    },
    preferred_routes: routes.filter(route => route.worker.adapter === taskShape.preferredWorker).map(route => route.id),
    candidates: routes.map(route => ({
      id: route.id,
      worker: {
        adapter: route.worker.adapter,
      },
      model: {
        provider: route.model.provider,
        model: route.model.model,
        profile: route.model.profile ?? null,
        reasoning: route.model.reasoning ?? null,
        resourceHealthy: route.model.resourceHealthy ?? null,
        code_plan: {
          five_hour: route.model.resourceWindows?.fiveHour ? {
            remaining_percent: route.model.resourceWindows.fiveHour.remainingPercent ?? null,
            reset_at: route.model.resourceWindows.fiveHour.resetAt ?? null,
            reset_in_minutes: route.model.resourceWindows.fiveHour.resetInMinutes ?? null,
          } : null,
          weekly: route.model.resourceWindows?.weekly ? {
            remaining_percent: route.model.resourceWindows.weekly.remainingPercent ?? null,
            reset_at: route.model.resourceWindows.weekly.resetAt ?? null,
            reset_in_minutes: route.model.resourceWindows.weekly.resetInMinutes ?? null,
          } : null,
        },
      },
    })),
  })) as JsonValue;

  const decisionRequest = { facts };
  const decisionContract = {
    type: 'choice' as const,
    question: 'Choose the best complete execution route. If preferred_routes is non-empty, choose from preferred_routes unless environment_rules explicitly override it or a preferred route is unhealthy/unavailable. Choose worker+model together in one decision.',
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
