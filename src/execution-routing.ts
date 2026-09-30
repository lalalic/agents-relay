import { DecisionEngine, DecisionMode, JsonValue } from './decision.js';
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
  const nestedTask = taskFacts.task && typeof taskFacts.task === 'object' ? taskFacts.task as Record<string, unknown> : undefined;
  const raw = taskFacts.storySize ?? nestedTask?.storySize;
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
  "Browser Workspace exhaustion is ChatGPT's primary hard execution constraint.",
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

const REASONING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;

function setupName(worker: WorkerCandidate, model: ModelCandidate): string {
  if (worker.adapter === 'chatgpt') return 'account-defaults';
  if (model.id.startsWith('default:') || model.id.startsWith('catalog:')) return 'default';
  return model.profile ?? model.provider;
}

function setupKey(worker: WorkerCandidate, model: ModelCandidate): string {
  return worker.workerId + '/' + setupName(worker, model);
}

function configuredDefault(models: readonly ModelCandidate[], setup: string): ModelCandidate | undefined {
  if (setup === 'account-defaults') return models[0];
  if (setup === 'default') return models.find(model => model.id.startsWith('default:'));
  return models.find(model => model.profile === setup && model.id.startsWith(setup + ':'));
}

function resolveModelAlias(raw: string, models: readonly ModelCandidate[], familyHint?: string): string {
  const normalized = raw.trim().toLowerCase();
  const exact = models.find(model => model.model.toLowerCase() === normalized);
  if (exact) return exact.model;
  if (familyHint) {
    const sameFamily = models.find(model => model.model.toLowerCase() === familyHint.toLowerCase() + '-' + normalized);
    if (sameFamily) return sameFamily.model;
  }
  const suffix = [...new Set(models.filter(model => model.model.toLowerCase().endsWith('-' + normalized)).map(model => model.model))];
  return suffix.length === 1 ? suffix[0] : raw.trim();
}

function userModelOverrides(rulesText: string, defaults: readonly ModelCandidate[], models: readonly ModelCandidate[]): ModelCandidate[] {
  const result: ModelCandidate[] = [];
  for (const line of rulesText.split(/\r?\n/)) {
    const match = line.match(/^\s*([a-z0-9._-]+)\s*:\s*(.+)$/i);
    if (!match) continue;
    const label = match[1].toLowerCase();
    const base = defaults.find(model => (model.profile ?? (model.provider === 'openai' ? 'default' : model.provider)).toLowerCase() === label || model.provider.toLowerCase() === label);
    if (!base) continue;
    const sameSetupModels = models.filter(model => model.provider === base.provider && (model.profile ?? null) === (base.profile ?? null));
    const familyHint = match[2].match(/\b(gpt-\d+(?:\.\d+)?)-[a-z0-9.-]+/i)?.[1];
    for (const segment of match[2].split(',')) {
      const item = segment.trim().match(/^(.+?)\s+(low|medium|high|xhigh|max|ultra)(?:\s|$)/i);
      if (!item) continue;
      const model = resolveModelAlias(item[1].trim(), sameSetupModels, familyHint);
      const reasoning = item[2].toLowerCase();
      if (result.some(candidate => candidate.provider === base.provider && candidate.model === model && (candidate.profile ?? null) === (base.profile ?? null) && candidate.reasoning === reasoning)) continue;
      result.push({
        ...base,
        id: (base.profile ?? 'default') + ':user/' + model,
        model,
        reasoning,
      });
    }
  }
  return result;
}

function codePlan(model: ModelCandidate): Record<string, unknown> {
  return {
    five_hour: model.resourceWindows?.fiveHour ? {
      remaining_percent: model.resourceWindows.fiveHour.remainingPercent ?? null,
      reset_at: model.resourceWindows.fiveHour.resetAt ?? null,
      reset_in_minutes: model.resourceWindows.fiveHour.resetInMinutes ?? null,
    } : null,
    weekly: model.resourceWindows?.weekly ? {
      remaining_percent: model.resourceWindows.weekly.remainingPercent ?? null,
      reset_at: model.resourceWindows.weekly.resetAt ?? null,
      reset_in_minutes: model.resourceWindows.weekly.resetInMinutes ?? null,
    } : null,
  };
}

function workerProviderFacts(routes: readonly ExecutionRouteCandidate[]): Array<Record<string, unknown>> {
  const workers = new Map<string, ExecutionRouteCandidate[]>();
  for (const route of routes) {
    const list = workers.get(route.worker.workerId) ?? [];
    list.push(route);
    workers.set(route.worker.workerId, list);
  }
  return [...workers.entries()].map(([workerId, workerRoutes]) => {
    const providers = new Map<string, ExecutionRouteCandidate[]>();
    for (const route of workerRoutes) {
      const list = providers.get(route.model.provider) ?? [];
      list.push(route);
      providers.set(route.model.provider, list);
    }
    return {
      id: workerId,
      adapter: workerRoutes[0].worker.adapter,
      providers: Object.fromEntries([...providers.entries()].map(([provider, providerRoutes]) => {
        const models = providerRoutes.map(route => route.model);
        const configured = models.find(model => !model.id.includes(':user/')) ?? models[0];
        return [provider, {
          default: { model: configured.model, reasoning: configured.reasoning ?? null },
          code_plan: codePlan(configured),
        }];
      })),
    };
  });
}


function decisionRouteLabel(route: ExecutionRouteCandidate): string {
  const prefix = route.worker.workerId + '/' + route.model.provider + '/';
  if (!route.model.id.includes(':user/')) return prefix + 'default';
  return prefix + route.model.model + (route.model.reasoning ? '@' + route.model.reasoning : '');
}

function routeId(worker: WorkerCandidate, model: ModelCandidate): string {
  return worker.workerId + '::' + model.id + (model.reasoning ? '@' + model.reasoning : '');
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
    const discoveredModels = await discoverModelCandidates(worker, registered, options.usage, undefined, options.rulesPath);
    const configuredModels = discoveredModels.filter(model => !model.id.startsWith('catalog:'));
    const defaults = configuredModels.filter(model => model.id.startsWith('default:') || (model.profile && model.id.startsWith(model.profile + ':')) || worker.adapter === 'chatgpt');
    const advertised = userModelOverrides(policy.rules.text, defaults, discoveredModels);
    const models = [...configuredModels, ...advertised];
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
  const userInputRules = rules.text;
  const preferredChatgptConcurrency = options.preferredChatgptConcurrency ?? DEFAULT_CHATGPT_PREFERRED_CONCURRENCY;
  const chatgptRunning = options.chatgptRunning ?? 0;

  const taskFacts = options.taskFacts ?? {};
  const taskShape = executionTaskShape(taskFacts);
  const facts = JSON.parse(JSON.stringify({
    context: {
      job: taskFacts.job ?? null,
      task: taskFacts.task ?? taskFacts,
      task_shape: {
        story_size: taskShape.storySize,
        sustained_work: taskShape.sustainedWork,
        preferred_worker: taskShape.preferredWorker,
        reason: taskShape.reason,
      },
      reviewer: taskFacts.reviewer_diversity ? {
        role: taskFacts.role ?? null,
        reviewer_diversity: taskFacts.reviewer_diversity,
      } : null,
    },
    user_input_rules: userInputRules,
    runtime: {
      chatgpt_running: chatgptRunning,
      preferred_chatgpt_concurrency: preferredChatgptConcurrency,
    },
    worker_candidates: workerProviderFacts(routes),
    routing_instruction: 'For each selected provider, use its default model and reasoning unless user_input_rules explicitly provides another model/reasoning option. Any override must be compatible with the selected worker/provider and pass runtime validation.',
  })) as JsonValue;

  const decisionChoices = routes.map(decisionRouteLabel);
  const decisionRequest = { facts };
  const decisionContract = {
    type: 'choice' as const,
    question: 'Choose one legal route. Each provider default is available. Additional model/reasoning routes exist only when explicitly provided by user_input_rules. Use context, code-plan quota, runtime load, and user_input_rules.',
    choices: decisionChoices,
  };

  let selected = fallback;
  let evidence: WorkerSelection['decisionEvidence'] = { mode: options.decisionMode ?? 'off', fallback: true };
  if ((options.decisionMode ?? 'off') !== 'off' && options.decisionEngine) {
    try {
      const decision = await options.decisionEngine.decide(decisionRequest, decisionContract);
      if (decision.type !== 'choice') throw new Error('Execution router expected a route choice result');
      const index = decisionChoices.indexOf(decision.choice);
      if (index < 0) throw new Error('Execution router returned an unknown route');
      selected = routes[index];
      evidence = {
        mode: options.decisionMode ?? 'active',
        engine: options.decisionEngine.name,
        proposed: decision.choice,
        probabilities: decision.probabilities,
        proposedFields: {
          worker: selected.worker.workerId,
          provider: selected.model.provider,
          model: selected.model.model,
          reasoning: selected.model.reasoning ?? '',
        },
        fallback: false,
      };
    } catch (error) {
      evidence = {
        mode: options.decisionMode ?? 'active',
        engine: options.decisionEngine.name,
        fallback: true,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const selectedBy = evidence.engine && !evidence.fallback ? 'execution-router:laya' : 'execution-router:fallback';
  const routing: RoutingDecision = {
    provider: selected.model.provider,
    model: selected.model.model,
    profile: selected.model.profile,
    reasoning: options.routingConstraints?.reasoning ?? selected.model.reasoning,
    decidedBy: selectedBy,
    decidedAt: new Date().toISOString(),
    decisionEvidence: evidence,
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
    selection: workerSelection(selected.worker, selectedBy, evidence),
    model: selected.model,
    audit,
  };
}
