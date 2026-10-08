import { DecisionEngine, DecisionMode, JsonValue } from './decision.js';
import { DecisionAuditRecord, DecisionAuditStore, makeExecutionDecisionAudit } from './decision-audit.js';
import { discoverModelCandidates, ModelCandidate } from './model-routing.js';
import { loadExecutionRouterRules, loadRoutingPolicy, policyAllows } from './routing-policy.js';
import { AccountUsageOverview } from './usage.js';
import { AgentRegistration, RoutingDecision, Task, WorkerRequirements, WorkerSelection } from './types.js';
import { DEFAULT_CHATGPT_PREFERRED_CONCURRENCY, WorkerCandidate } from './worker-routing.js';
import { appendRoutingInstruction, RouterRuleChoice } from './router-rules.js';

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
        const configured = providerRoutes.find(route => !route.model.id.startsWith('catalog:')) ?? providerRoutes[0];
        return [provider, {
          default: { model: configured.model.model, reasoning: configured.model.reasoning ?? null },
          code_plan: codePlan(configured.model),
        }];
      })),
    };
  });
}

type LayaDecisionStage = {
  name: string;
  facts: JsonValue;
  contract: { type: 'choice'; question: string; choices: string[] };
  result: { choice: string; probabilities?: Record<string, number>; bypassed?: boolean };
};

async function decideStage(
  engine: DecisionEngine,
  name: LayaDecisionStage['name'],
  facts: JsonValue,
  question: string,
  choices: string[],
): Promise<LayaDecisionStage> {
  if (choices.length === 0) throw new Error('No choices available for '+name+' stage');
  const contract = { type: 'choice' as const, question, choices };
  if (choices.length === 1) return { name, facts, contract, result: { choice: choices[0], bypassed: true } };
  const decision = await engine.decide({ facts }, contract);
  if (decision.type !== 'choice') throw new Error('Execution router expected a choice result for '+name);
  return { name, facts, contract, result: { choice: decision.choice, probabilities: decision.probabilities } };
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

/**
 * Configured profile defaults for one worker: the explicitly configured
 * provider/model/reasoning profiles (Codex `config.toml` and `*.config.toml`),
 * i.e. every discovered route that is not a runtime catalog expansion.
 */
function profileDefaults(candidates: readonly ModelCandidate[]): ModelCandidate[] {
  return candidates.filter(candidate => !candidate.id.startsWith('catalog:'));
}

/**
 * Resolve explicit user `[choices]` entries against discovered runtime models.
 * A choice may reference a runtime catalog model because the user named it
 * explicitly; Relay never expands the unreferenced catalog into choices.
 * Unresolvable or reasoning-incompatible entries are dropped rather than
 * fabricated into an impossible route.
 */
function resolveExplicitModel(choice: RouterRuleChoice, pool: readonly ModelCandidate[]): string | null {
  const model = choice.model.toLowerCase();
  const exact = pool.find(candidate => candidate.model.toLowerCase() === model);
  if (exact) return exact.model;
  const suffixes = [...new Set(pool.filter(candidate => candidate.model.toLowerCase().endsWith('-' + model)).map(candidate => candidate.model))];
  if (suffixes.length === 1) return suffixes[0];
  const hint = choice.model.match(/^(gpt-\d+(?:\.\d+)?)-[a-z0-9.-]+$/i)?.[1];
  if (hint) {
    const family = pool.find(candidate => candidate.model.toLowerCase() === (hint + '-' + model).toLowerCase());
    if (family) return family.model;
  }
  return null;
}

function resolveExplicitChoices(
  choices: readonly RouterRuleChoice[],
  candidates: readonly ModelCandidate[],
): ModelCandidate[] {
  const result: ModelCandidate[] = [];
  const seen = new Set<string>();
  for (const choice of choices) {
    const provider = choice.provider.toLowerCase();
    const providerPool = candidates.filter(candidate => candidate.provider.toLowerCase() === provider);
    const model = resolveExplicitModel(choice, providerPool);
    if (!model) continue;
    const matches = providerPool.filter(candidate => candidate.model === model);
    const pool = choice.reasoning
      ? matches.filter(candidate => (candidate.reasoning ?? '').toLowerCase() === choice.reasoning)
      : matches;
    const candidate = pool.find(item => !item.id.startsWith('catalog:')) ?? pool[0];
    if (!candidate) continue;
    const key = candidate.id + '@' + (candidate.reasoning ?? '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(candidate);
  }
  return result;
}

function mergeCandidates(...lists: ReadonlyArray<readonly ModelCandidate[]>): ModelCandidate[] {
  const result: ModelCandidate[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const candidate of list) {
      const key = candidate.id + '@' + (candidate.reasoning ?? '');
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
  }
  return result;
}

export function executionChoiceLabel(route: ExecutionRouteCandidate, isDefault: boolean): string {
  return 'worker=' + route.worker.workerId
    + ' provider=' + route.model.provider
    + ' model=' + route.model.model
    + ' reasoning=' + (route.model.reasoning ?? 'provider-default')
    + ' default=' + String(isDefault);
}

function isDefaultCandidate(candidate: ModelCandidate, defaults: readonly ModelCandidate[]): boolean {
  return defaults.some(item => item.id === candidate.id && item.reasoning === candidate.reasoning);
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
  choices: RouterRuleChoice[];
  routingInstruction: string;
}> {
  const registered = options.registered ?? [];
  const policy = await loadRoutingPolicy(options.policyPath, options.rulesPath);
  const rules = await loadExecutionRouterRules(options.rulesPath);
  const workerGateEvaluations = workers.map(worker => {
    const rejectionReasons = workerGateReasons(worker, requirements);
    return { workerId: worker.workerId, eligible: rejectionReasons.length === 0, rejectionReasons };
  });
  const evaluations: ExecutionRouteEvaluation[] = [];
  for (const worker of workers) {
    const workerReasons = workerGateEvaluations.find(item => item.workerId === worker.workerId)?.rejectionReasons ?? [];
    const discovered = await discoverModelCandidates(worker, registered, options.usage, undefined, options.rulesPath);
    const defaults = profileDefaults(discovered);
    const workerChoices = rules.parsed.choices.filter(choice => !choice.worker || choice.worker === worker.workerId || choice.worker === worker.adapter);
    const explicit = resolveExplicitChoices(workerChoices, discovered);
    const merged = mergeCandidates(defaults, explicit);
    for (const model of merged) {
      const rejectionReasons = [...workerReasons, ...modelGateReasons(model, options.routingConstraints, options.excludedRoutes, policy)];
      const route = { id: routeId(worker, model), worker, model };
      evaluations.push({ route, eligible: rejectionReasons.length === 0, rejectionReasons });
    }
  }
  const routes = evaluations.filter(item => item.eligible).map(item => item.route);
  return { routes, evaluations, workerGateEvaluations, policy, choices: rules.parsed.choices, routingInstruction: rules.parsed.routingInstruction };
}

export async function routeExecution(
  workers: readonly WorkerCandidate[],
  requirements: WorkerRequirements,
  options: ExecutionRoutingOptions = {},
): Promise<ExecutionRoutingDecision> {
  const { routes, evaluations, workerGateEvaluations, policy, routingInstruction } = await discoverExecutionRoutes(workers, requirements, options);
  if (routes.length === 0) throw new Error('No executable worker+model route satisfies authoritative constraints');

  const fallback = fallbackRoute(routes);
  const preferredChatgptConcurrency = options.preferredChatgptConcurrency ?? DEFAULT_CHATGPT_PREFERRED_CONCURRENCY;
  const chatgptRunning = options.chatgptRunning ?? 0;

  const taskFacts = options.taskFacts ?? {};
  const taskShape = executionTaskShape(taskFacts);

  const discoveredDefaults = new Map<string, readonly ModelCandidate[]>();
  for (const worker of workers) {
    const discovered = await discoverModelCandidates(worker, options.registered ?? [], options.usage, undefined, options.rulesPath);
    discoveredDefaults.set(worker.workerId, profileDefaults(discovered));
  }

  const effectiveChoices = routes.map(route => ({
    worker: route.worker.workerId,
    provider: route.model.provider,
    model: route.model.model,
    profile: route.model.profile ?? null,
    reasoning: route.model.reasoning ?? null,
    default: isDefaultCandidate(route.model, discoveredDefaults.get(route.worker.workerId) ?? []),
    source: isDefaultCandidate(route.model, discoveredDefaults.get(route.worker.workerId) ?? []) ? 'profile-default' : 'explicit-choice',
  }));
  const choiceLabels = routes.map((route, index) => executionChoiceLabel(route, effectiveChoices[index].default));
  // Usage is keyed by worker/provider, not repeated for every route choice.
  const usageByProvider = Object.fromEntries([...new Map(routes.map(route => [
    route.worker.workerId + '::' + route.model.provider,
    { worker: route.worker.workerId, provider: route.model.provider, ...codePlan(route.model) },
  ])).entries()]);

  const facts = JSON.parse(JSON.stringify({
    context: {
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
    usage_by_provider: usageByProvider,
    runtime: {
      chatgpt_running: chatgptRunning,
      preferred_chatgpt_concurrency: preferredChatgptConcurrency,
    },
  })) as Record<string, unknown>;

  const question = appendRoutingInstruction(
    'User routing instructions have highest priority over default preferences, task size, runtime and resource signals. Select an offered route that obeys them.\nUser routing instructions:\n' + routingInstruction,
    'Choose exactly one listed route; do not invent routes.',
  );

  let selected = fallback;
  let evidence: WorkerSelection['decisionEvidence'] = { mode: options.decisionMode ?? 'off', fallback: true };
  const decisionStages: LayaDecisionStage[] = [];
  if ((options.decisionMode ?? 'off') !== 'off' && options.decisionEngine) {
    try {
      const stage = await decideStage(options.decisionEngine, 'route', facts as JsonValue, question, choiceLabels);
      decisionStages.push(stage);
      const index = stage.result.choice ? choiceLabels.indexOf(stage.result.choice) : -1;
      if (index < 0) throw new Error('Laya selected a route outside the merged choice list');
      selected = routes[index];
      evidence = {
        mode: options.decisionMode ?? 'active',
        engine: options.decisionEngine.name,
        proposed: stage.result.choice,
        probabilities: stage.result.probabilities,
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
      effectiveChoices,
      routingInstruction,
    },
    policy,
    routing,
    decisionStages,
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
