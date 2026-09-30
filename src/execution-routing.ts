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
  name: 'provider' | 'model' | 'reasoning';
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

function stageFacts(
  baseFacts: Record<string, unknown>,
  selected: Partial<{ worker: string; provider: string; model: string }>,
  candidates: Record<string, unknown>,
): JsonValue {
  return JSON.parse(JSON.stringify({
    ...baseFacts,
    selected,
    ...candidates,
  })) as JsonValue;
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
  const userInputRules = rules.text;
  const preferredChatgptConcurrency = options.preferredChatgptConcurrency ?? DEFAULT_CHATGPT_PREFERRED_CONCURRENCY;
  const chatgptRunning = options.chatgptRunning ?? 0;

  const taskFacts = options.taskFacts ?? {};
  const taskShape = executionTaskShape(taskFacts);
  const baseFacts = JSON.parse(JSON.stringify({
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
    routing_instruction: 'Interpret user_input_rules directly. Choose among the runtime-provided legal candidates at each stage. Relay does not parse user_input_rules into model or reasoning choices.',
  })) as Record<string, unknown>;

  let selected = fallback;
  let evidence: WorkerSelection['decisionEvidence'] = { mode: options.decisionMode ?? 'off', fallback: true };
  const decisionStages: LayaDecisionStage[] = [];
  if ((options.decisionMode ?? 'off') !== 'off' && options.decisionEngine) {
    try {
      const providerKeys = [...new Set(routes.map(route => route.worker.workerId + '::' + route.model.provider))];
      const providerOptions = providerKeys.map(key => {
        const splitAt = key.lastIndexOf('::');
        const worker = key.slice(0, splitAt);
        const provider = key.slice(splitAt + 2);
        const providerRoutes = routes.filter(route => route.worker.workerId === worker && route.model.provider === provider);
        const configured = providerRoutes.find(route => !route.model.id.startsWith('catalog:')) ?? providerRoutes[0];
        return {
          key,
          worker,
          provider,
          default_model: configured.model.model,
          label: 'worker=' + worker + ' provider=' + provider + ' default_model=' + configured.model.model,
        };
      });
      const providerFacts = stageFacts(baseFacts, {}, {
        provider_candidates: providerOptions.map(({ label: _label, key: _key, ...option }) => option),
      });
      const providerStage = await decideStage(
        options.decisionEngine,
        'provider',
        providerFacts,
        'Choose the best worker/provider pair. Interpret user_input_rules directly together with task context, runtime load, provider defaults, and code-plan quota. When user_input_rules explicitly names providers as routing options, prefer those named providers when applicable; treat unmentioned providers as fallbacks unless other facts clearly require them.',
        providerOptions.map(option => option.label),
      );
      decisionStages.push(providerStage);
      const selectedProvider = providerOptions.find(option => option.label === providerStage.result.choice);
      if (!selectedProvider) throw new Error('Laya selected an unknown worker/provider option');
      const workerId = selectedProvider.worker;
      const provider = selectedProvider.provider;
      const providerRoutes = routes.filter(route => route.worker.workerId === workerId && route.model.provider === provider);
      if (providerRoutes.length === 0) throw new Error('Laya selected a worker/provider pair with no eligible routes');

      const modelGroups = new Map<string, ExecutionRouteCandidate[]>();
      for (const route of providerRoutes) {
        const group = modelGroups.get(route.model.model) ?? [];
        group.push(route);
        modelGroups.set(route.model.model, group);
      }
      const modelChoices = [...modelGroups.keys()];
      const modelOptions = modelChoices.map(model => {
        const group = modelGroups.get(model) ?? [];
        const configured = group.some(route => !route.model.id.startsWith('catalog:'));
        return {
          model,
          configured_default: configured,
          supported_reasoning: [...new Set(group.map(route => route.model.reasoning).filter((value): value is string => Boolean(value)))],
          label: 'model=' + model + ' configured_default=' + String(configured),
        };
      });
      const modelFacts = stageFacts(baseFacts, { worker: workerId, provider }, {
        model_candidates: modelOptions.map(({ label: _label, ...option }) => option),
      });
      const modelStage = await decideStage(
        options.decisionEngine,
        'model',
        modelFacts,
        'Choose the best model for the selected worker/provider. Interpret user_input_rules directly. Candidate model names come from current runtime/configuration and are not derived from the free-text rules. If user_input_rules explicitly maps a model to the current task type, size, complexity, or other current condition, follow that mapping instead of the provider default.',
        modelOptions.map(option => option.label),
      );
      decisionStages.push(modelStage);
      const selectedModel = modelOptions.find(option => option.label === modelStage.result.choice);
      if (!selectedModel) throw new Error('Laya selected an unknown model option');

      const modelRoutes = modelGroups.get(selectedModel.model) ?? [];
      const reasoningChoices = [...new Set(modelRoutes.map(route => route.model.reasoning ?? 'provider-default'))];
      const reasoningOptions = reasoningChoices.map(reasoning => ({
        reasoning,
        label: 'reasoning=' + reasoning,
      }));
      const reasoningFacts = stageFacts(baseFacts, { worker: workerId, provider, model: selectedModel.model }, {
        reasoning_candidates: reasoningChoices,
      });
      const reasoningStage = await decideStage(
        options.decisionEngine,
        'reasoning',
        reasoningFacts,
        'Choose the reasoning level for the selected model. Interpret user_input_rules directly. If user_input_rules explicitly assigns a reasoning level to the selected model for the current conditions, follow that assignment. Use provider-default only when the model does not expose a specific reasoning level.',
        reasoningOptions.map(option => option.label),
      );
      decisionStages.push(reasoningStage);
      const selectedReasoning = reasoningOptions.find(option => option.label === reasoningStage.result.choice);
      if (!selectedReasoning) throw new Error('Laya selected an unknown reasoning option');

      const reasoning = selectedReasoning.reasoning === 'provider-default' ? null : selectedReasoning.reasoning;
      const proposed = modelRoutes.find(route => (route.model.reasoning ?? null) === reasoning);
      if (!proposed) throw new Error('Laya selected a model/reasoning combination with no eligible route');
      selected = proposed;
      evidence = {
        mode: options.decisionMode ?? 'active',
        engine: options.decisionEngine.name,
        proposed: providerStage.result.choice + '/' + selectedModel.model + '@' + selectedReasoning.reasoning,
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
