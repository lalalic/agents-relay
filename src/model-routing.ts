import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { chooseWithDecision, DecisionChoice, DecisionEngine, DecisionMode } from './decision.js';
import { AccountUsageOverview } from './usage.js';
import { AgentRegistration, ResourceUsageWindow, RoutingDecision } from './types.js';
import { usageForProvider, WorkerCandidate } from './worker-routing.js';
import { DecisionAuditStore, DecisionAuditRecord, makeDecisionAudit } from './decision-audit.js';
import { loadExecutionRouterRules, loadRoutingPolicy, LoadedRoutingPolicy, policyAllows, policyRank } from './routing-policy.js';

export type ModelCandidate = {
  id: string;
  provider: string;
  model: string;
  profile?: string;
  reasoning?: string;
  resourceHealthy?: boolean;
  resourceUsedPercent?: number;
  resourceRemainingPercent?: number;
  resourceResetAt?: number;
  resourceResetInMinutes?: number;
  resourceWindows?: { fiveHour?: ResourceUsageWindow; weekly?: ResourceUsageWindow };
};

export type ModelRoutingDecision = { candidate: ModelCandidate; routing: RoutingDecision; audit?: DecisionAuditRecord };

export type ModelRoutingOptions = {
  decisionEngine?: DecisionEngine;
  decisionMode?: DecisionMode;
  taskFacts?: Record<string, unknown>;
  constraints?: Partial<Pick<RoutingDecision, 'provider' | 'model' | 'profile' | 'reasoning'>>;
  auditStore?: DecisionAuditStore;
  auditTask?: import('./types.js').Task;
  policyPath?: string;
  rulesPath?: string;
  priorDecisionId?: string;
  priorFailure?: import('./decision-audit.js').AuditFailureEvidence;
  excludedRoutes?: Array<Partial<Pick<RoutingDecision, 'provider' | 'model' | 'profile'>>>;
};

type CodexConfig = { model?: string; provider?: string; reasoning?: string };

function topLevelCodexConfig(text: string): CodexConfig {
  const result: CodexConfig = {};
  let inSection = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('[')) { inSection = true; continue; }
    if (inSection) continue;
    const match = line.match(/^(model|model_provider|model_reasoning_effort)\s*=\s*"([^"]+)"/);
    if (!match) continue;
    if (match[1] === 'model') result.model = match[2];
    else if (match[1] === 'model_provider') result.provider = match[2];
    else result.reasoning = match[2];
  }
  return result;
}

async function readConfig(path: string): Promise<CodexConfig | null> {
  try { return topLevelCodexConfig(await readFile(path, 'utf8')); } catch { return null; }
}

function compact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function modelAliases(model: string): string[] {
  const aliases = new Set<string>([compact(model)]);
  const firstDigit = model.search(/\d/);
  if (firstDigit >= 0) aliases.add(compact(model.slice(firstDigit)));
  return [...aliases].filter(Boolean);
}

export function nonOpenAiModelAuthorized(provider: string, model: string, rulesText: string): boolean {
  if (provider === 'openai') return true;
  const rules = compact(rulesText);
  if (!rules.includes(compact(provider))) return false;
  return modelAliases(model).some(alias => alias.length >= 3 && rules.includes(alias));
}

function withResource(candidate: ModelCandidate, usage?: AccountUsageOverview): ModelCandidate {
  const resource = usageForProvider(usage, candidate.provider);
  return { ...candidate, resourceHealthy: resource.healthy, resourceUsedPercent: resource.usedPercent, resourceRemainingPercent: resource.remainingPercent, resourceResetAt: resource.resetAt, resourceResetInMinutes: resource.resetInMinutes, resourceWindows: resource.windows };
}

export async function discoverModelCandidates(
  worker: WorkerCandidate,
  registered: readonly AgentRegistration[],
  usage?: AccountUsageOverview,
  codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex'),
  rulesPath?: string,
): Promise<ModelCandidate[]> {
  const registration = registered.find(item => item.id === worker.workerId);
  if (registration?.runtime.provider && registration.runtime.model) {
    const rules = await loadExecutionRouterRules(rulesPath);
    if (!nonOpenAiModelAuthorized(registration.runtime.provider, registration.runtime.model, rules.text)) return [];
    return [withResource({
      id: `${registration.runtime.provider}/${registration.runtime.model}`,
      provider: registration.runtime.provider,
      model: registration.runtime.model,
    }, usage)];
  }
  if (worker.adapter === 'chatgpt') {
    return [withResource({ id: 'chatgpt/account-defaults', provider: 'chatgpt', model: 'account-defaults' }, usage)];
  }

  const base = await readConfig(join(codexHome, 'config.toml')) ?? {};
  const rules = await loadExecutionRouterRules(rulesPath);
  const candidates: ModelCandidate[] = [];
  if (base.model) {
    const provider = base.provider ?? 'openai';
    if (nonOpenAiModelAuthorized(provider, base.model, rules.text)) candidates.push(withResource({ id: `default:${provider}/${base.model}`, provider, model: base.model, reasoning: base.reasoning }, usage));
  }
  let files: string[] = [];
  try { files = (await readdir(codexHome)).filter(name => name.endsWith('.config.toml')).sort(); } catch { /* no profiles */ }
  for (const file of files) {
    const config = await readConfig(join(codexHome, file));
    if (!config?.model) continue;
    const profile = basename(file, '.config.toml');
    const provider = config.provider ?? base.provider ?? 'openai';
    if (!nonOpenAiModelAuthorized(provider, config.model, rules.text)) continue;
    candidates.push(withResource({ id: `${profile}:${provider}/${config.model}`, provider, model: config.model, profile, reasoning: config.reasoning ?? base.reasoning }, usage));
  }
  if (candidates.length === 0) candidates.push(withResource({ id: 'default:openai/gpt-5.6-luna', provider: 'openai', model: 'gpt-5.6-luna' }, usage));
  return candidates.filter((candidate, index, all) => all.findIndex(item => item.id === candidate.id) === index);
}

function sameRoute(candidate: ModelCandidate, route: Partial<Pick<RoutingDecision, 'provider' | 'model' | 'profile'>>): boolean {
  return (!route.provider || candidate.provider === route.provider)
    && (!route.model || candidate.model === route.model)
    && (route.profile === undefined || candidate.profile === route.profile);
}

function eligibleModels(candidates: readonly ModelCandidate[], constraints?: ModelRoutingOptions['constraints'], policy?: LoadedRoutingPolicy, excludedRoutes: ModelRoutingOptions['excludedRoutes'] = []): ModelCandidate[] {
  return candidates.filter(candidate => {
    if (candidate.resourceHealthy === false) return false;
    if (excludedRoutes.some(route => sameRoute(candidate, route))) return false;
    if (policy && !policyAllows(candidate, policy.policy)) return false;
    if (constraints?.provider && candidate.provider !== constraints.provider) return false;
    if (constraints?.model && candidate.model !== constraints.model) return false;
    if (constraints?.profile && candidate.profile !== constraints.profile) return false;
    if (constraints?.reasoning && candidate.reasoning && candidate.reasoning !== constraints.reasoning) return false;
    return true;
  });
}

function deterministicModel(candidates: readonly ModelCandidate[], taskKind?: string, policy?: LoadedRoutingPolicy): ModelCandidate {
  return [...candidates].map((candidate, index) => ({ candidate, index })).sort((left, right) => {
    const pressure = (item: ModelCandidate): number => item.resourceUsedPercent === undefined ? 1 : item.resourceUsedPercent >= 90 ? 2 : 0;
    return pressure(left.candidate) - pressure(right.candidate) || (policy ? policyRank(right.candidate, taskKind, policy.policy) - policyRank(left.candidate, taskKind, policy.policy) : 0) || left.index - right.index;
  })[0].candidate;
}

export async function routeModel(
  worker: WorkerCandidate,
  candidates: readonly ModelCandidate[],
  options: ModelRoutingOptions = {},
): Promise<ModelRoutingDecision> {
  const policy = await loadRoutingPolicy(options.policyPath, options.rulesPath);
  const eligible = eligibleModels(candidates, options.constraints, policy, options.excludedRoutes);
  if (eligible.length === 0) throw new Error(`No eligible model profile is usable by worker ${worker.workerId}`);
  const taskKind = typeof options.taskFacts?.kind === 'string' ? options.taskFacts.kind : undefined;
  const deterministic = deterministicModel(eligible, taskKind, policy);
  const choice: DecisionChoice = eligible.length === 1
    ? { choice: deterministic.id, evidence: { mode: options.decisionMode ?? 'off', fallback: true } as const }
    : await chooseWithDecision(
      options.decisionEngine,
      options.decisionMode ?? 'off',
      {
        facts: JSON.parse(JSON.stringify({
          task: options.taskFacts ?? {},
          environment_policy: { structured_policy: policy.snapshot, rules: policy.rules.text },
          prior_decision_id: options.priorDecisionId ?? null,
          prior_failure: options.priorFailure ?? null,
          worker: { id: worker.workerId, adapter: worker.adapter, capabilities: [...worker.capabilities] },
          candidates: eligible.map(item => ({ id: item.id, provider: item.provider, model: item.model, profile: item.profile ?? null, reasoning: item.reasoning ?? null, resourceHealthy: item.resourceHealthy ?? null, resourceUsedPercent: item.resourceUsedPercent ?? null, resourceRemainingPercent: item.resourceRemainingPercent ?? null, resourceResetAt: item.resourceResetAt ?? null, resourceResetInMinutes: item.resourceResetInMinutes ?? null, resourceWindows: item.resourceWindows ?? null })),
        })) as import('./decision.js').JsonValue,
      },
      { type: 'choice', question: 'Which eligible model profile is best suited to execute this task? Apply hard gates first, then explicit task constraints, then current environment policy; consider every quota window and never violate task fit or continuity.', choices: eligible.map(item => item.id) },
      () => deterministic.id,
    );
  const selected = eligible.find(item => item.id === choice.choice) ?? deterministic;
  const routing: RoutingDecision = {
    provider: selected.provider,
    model: selected.model,
    profile: selected.profile,
    reasoning: options.constraints?.reasoning ?? selected.reasoning,
    decidedBy: choice.evidence.engine && !choice.evidence.fallback ? 'model-router:laya' : 'model-router',
    decidedAt: new Date().toISOString(),
    decisionEvidence: choice.evidence,
  };
  const audit = makeDecisionAudit({
    task: options.auditTask,
    worker: { id: worker.workerId, adapter: worker.adapter, capabilities: [...worker.capabilities] },
    contract: { question: 'model-profile-selection', task: options.taskFacts ?? {}, constraints: options.constraints ?? {}, excludedRoutes: options.excludedRoutes ?? [] },
    policy,
    candidates,
    eligibleCandidates: eligible,
    selected,
    routing,
    priorDecisionId: options.priorDecisionId,
    priorFailure: options.priorFailure,
  });
  routing.decisionId = audit.decision_id;
  if (options.auditStore) await options.auditStore.append(audit);
  return {
    candidate: selected,
    routing,
    audit,
  };
}
