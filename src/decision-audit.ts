import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readJsonlNewestFirst } from './audit-tail.js';
import { randomUUID, createHash } from 'node:crypto';
import { ModelCandidate, modelChoiceId } from './model-routing.js';
import type { WorkerCandidate } from './worker-routing.js';
import type { ExecutionRouteEvaluation, WorkerGateEvaluation } from './execution-routing.js';
import type { WorkerRequirements } from './types.js';
import { DecisionEvidence, RoutingDecision, Task } from './types.js';
import { LoadedRoutingPolicy } from './routing-policy.js';

export const DECISION_AUDIT_SCHEMA_VERSION = 5;
export type AuditFailureEvidence = { classification: string; summary: string; sources: string[]; details?: Record<string, unknown> };
export type DecisionAuditRecord = {
  record_type: 'decision'; schema_version: number; decision_id: string; prior_decision_id?: string; timestamp: string;
  correlation: { job_id?: string; task_id?: string; execution_id?: string | null; attempt?: number };
  task: Record<string, unknown>; worker: Record<string, unknown>; contract: Record<string, unknown>;
  policy: { path: string | null; hash: string; snapshot: Record<string, unknown>; rules: { path: string; hash: string; text: string } };
  candidates: Array<Record<string, unknown>>; gate_results: Array<{ candidate_id: string; eligible: boolean; rejection_reasons: string[] }>;
  eligible_candidates: Array<Record<string, unknown>>;
  selected: Record<string, unknown>; engine: string; fallback: { used: boolean; reason?: string };
  decision_evidence?: DecisionEvidence; prior_failure?: AuditFailureEvidence;
  worker_candidates?: Array<Record<string, unknown>>;
  worker_gate_results?: Array<{ worker_id: string; eligible: boolean; rejection_reasons: string[] }>;
  decision_input?: Record<string, unknown>;
};
export type DecisionOutcomeRecord = {
  record_type: 'outcome'; schema_version: number; outcome_id: string; decision_id: string; timestamp: string;
  kind: 'launch_failure' | 'provider_failure' | 'runtime_failure' | 'auth_config_failure' | 'task_started' | 'semantic_failure' | 'task_failure' | 'timeout' | 'blocked' | 'outcome_unknown' | 'cancelled' | 'success';
  summary: string; evidence?: Record<string, unknown>;
};

export interface DecisionAuditStore { append(record: DecisionAuditRecord | DecisionOutcomeRecord): Promise<void>; read(): Promise<Array<DecisionAuditRecord | DecisionOutcomeRecord>>; readRecentRoutes?(limit: number): Promise<RouterRouteResult[]>; }

/** Bounded, terminal execution facts. Pending selections and task.started are not outcomes. */
export type RouterRouteResult = {
  timestamp: string;
  worker: string;
  adapter: string;
  provider: string;
  model: string;
  profile: string | null;
  reasoning: string | null;
  result: 'success' | 'failure' | 'blocked' | 'cancelled' | 'unknown';
  failure_kind: string | null;
  reason: string;
};

function textField(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/** Avoid passing long worker logs, inline credentials or private task content to the decision engine. */
function routeReason(value: string): string {
  return value.replace(/\s+/g, ' ')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[redacted]')
    .replace(/\b((?:api[_ -]?key|secret|password|access[_ -]?token|token|credential|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 240);
}

/**
 * Router facts cross Job boundaries. Never copy arbitrary worker error messages
 * into a later Job's Laya prompt: only deterministic, content-free reason codes
 * may leave this private audit store.
 */
function routerReasonCode(kind: DecisionOutcomeRecord['kind'], summary: string): string {
  if (kind === 'success') return 'task_completed';
  if (kind === 'cancelled') return 'task_cancelled';
  if (kind === 'blocked') return 'task_blocked';
  if (kind === 'outcome_unknown') return 'execution_outcome_unknown';
  if (kind === 'auth_config_failure') return 'authentication_rejected';
  if (kind === 'timeout') return 'worker_timeout';
  if (kind === 'launch_failure') return 'worker_launch_failed';
  if (kind === 'provider_failure') {
    if (/stream disconnected|response\.completed/i.test(summary)) return 'provider_stream_disconnected';
    if (/rate[_ .-]?limit(?:[_ .-]?exceeded)?|HTTP 429/i.test(summary)) return 'provider_rate_limited';
    if (/quota|credits? exhausted/i.test(summary)) return 'provider_quota_exhausted';
    return 'provider_failure';
  }
  if (kind === 'runtime_failure') return 'worker_runtime_failure';
  if (kind === 'semantic_failure') return 'task_semantic_failure';
  return 'task_reported_failure';
}

function routeResult(record: DecisionOutcomeRecord, route: Record<string, unknown>): RouterRouteResult | null {
  const worker = textField(route.worker);
  const adapter = textField(route.adapter);
  const provider = textField(route.provider);
  const model = textField(route.model);
  if (!worker || !adapter || !provider || !model) return null;
  return {
    timestamp: record.timestamp,
    worker, adapter, provider, model,
    profile: textField(route.profile),
    reasoning: textField(route.reasoning),
    result: record.kind === 'success' ? 'success' : record.kind === 'cancelled' ? 'cancelled'
      : record.kind === 'blocked' ? 'blocked' : record.kind === 'outcome_unknown' ? 'unknown' : 'failure',
    failure_kind: ['success', 'cancelled', 'blocked', 'outcome_unknown'].includes(record.kind) ? null : record.kind,
    reason: routerReasonCode(record.kind, record.summary),
  };
}

function outcomeAttemptKey(record: DecisionOutcomeRecord): string {
  const evidence = record.evidence ?? {};
  const attempt = typeof evidence.attempt === 'number' && Number.isSafeInteger(evidence.attempt) ? String(evidence.attempt) : null;
  const execution = textField(evidence.execution_id);
  return JSON.stringify([record.decision_id, execution ?? (attempt ? 'attempt:' + attempt : 'legacy')]);
}

/**
 * Join durable decision and outcome records by decision ID, retaining only the
 * latest terminal outcome per execution attempt. History is global across Jobs and sorted
 * by outcome time, not by when a route was chosen. Only completed attempts count.
 */
export async function recentExecutionRouteResults(store: Pick<DecisionAuditStore, 'read' | 'readRecentRoutes'>, limit = 10): Promise<RouterRouteResult[]> {
  if (store.readRecentRoutes) return store.readRecentRoutes(limit);
  const records = await store.read();
  const decisions = new Map<string, DecisionAuditRecord>();
  const outcomes = new Map<string, { record: DecisionOutcomeRecord; order: number }>();
  records.forEach((record, order) => {
    if (record.record_type === 'decision') {
      decisions.set(record.decision_id, record);
    } else if (record.kind !== 'task_started') {
      // Reused decisions from an authorized retry are separate executions.
      const key = outcomeAttemptKey(record);
      const current = outcomes.get(key);
      if (!current || record.timestamp > current.record.timestamp || (record.timestamp === current.record.timestamp && order > current.order)) {
        outcomes.set(key, { record, order });
      }
    }
  });
  const results: Array<RouterRouteResult & { order: number }> = [];
  for (const { record, order } of outcomes.values()) {
    const decision = decisions.get(record.decision_id);
    const route = decision?.selected;
    const worker = route?.worker && typeof route.worker === 'object' ? route.worker as Record<string, unknown> : undefined;
    const model = route?.model && typeof route.model === 'object' ? route.model as Record<string, unknown> : undefined;
    const result = routeResult(record, {
      worker: worker?.id, adapter: worker?.adapter, provider: model?.provider, model: model?.model,
      profile: model?.profile, reasoning: model?.reasoning,
    });
    if (result) results.push({ ...result, order });
  }
  return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.order - a.order)
    .slice(0, Math.max(0, Math.min(10, Math.trunc(limit))))
    .map(({ order: _order, ...result }) => result);
}

export class JsonlDecisionAuditStore implements DecisionAuditStore {
  constructor(readonly path: string) {}
  /** The normal path reads backward only until ten distinct completed attempts.
   * Legacy outcomes without embedded routing facts use a one-time compatibility
   * fallback to the full audit reader; new outcomes are self-contained. */
  async readRecentRoutes(limit = 10): Promise<RouterRouteResult[]> {
    const cap = Math.max(0, Math.min(10, Math.trunc(limit)));
    if (cap === 0) return [];
    const results: RouterRouteResult[] = [];
    const seen = new Set<string>();
    let needsLegacyJoin = false;
    for await (const record of readJsonlNewestFirst<DecisionAuditRecord | DecisionOutcomeRecord>(this.path)) {
      if (record.record_type !== 'outcome' || record.kind === 'task_started') continue;
      const key = outcomeAttemptKey(record);
      if (seen.has(key)) continue;
      seen.add(key);
      const route = record.evidence?.route;
      const result = route && typeof route === 'object' && !Array.isArray(route)
        ? routeResult(record, route as Record<string, unknown>) : null;
      if (result) results.push(result);
      else needsLegacyJoin = true;
      if (seen.size >= cap) break;
    }
    if (needsLegacyJoin) return recentExecutionRouteResults({ read: () => this.read() }, cap);
    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, cap);
  }
  async append(record: DecisionAuditRecord | DecisionOutcomeRecord): Promise<void> { await mkdir(dirname(this.path), { recursive: true }); await appendFile(this.path, `${JSON.stringify(sanitize(record))}\n`, 'utf8'); }
  async read(): Promise<Array<DecisionAuditRecord | DecisionOutcomeRecord>> {
    try { return (await readFile(this.path, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as DecisionAuditRecord | DecisionOutcomeRecord); } catch { return []; }
  }
}

function sanitize(value: unknown, key = ''): unknown {
  if (/(token|secret|password|credential|authorization|api.?key)/i.test(key)) return '[redacted]';
  if (Array.isArray(value)) return value.map(item => sanitize(item));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v, k)]));
  return value;
}

export function decisionAuditId(): string { return randomUUID(); }
export function auditInputHash(record: DecisionAuditRecord): string { return createHash('sha256').update(JSON.stringify(record)).digest('hex'); }
export function outcomeForDecision(decisionId: string, kind: DecisionOutcomeRecord['kind'], summary: string, evidence?: Record<string, unknown>): DecisionOutcomeRecord { return { record_type: 'outcome', schema_version: DECISION_AUDIT_SCHEMA_VERSION, outcome_id: randomUUID(), decision_id: decisionId, timestamp: new Date().toISOString(), kind, summary: routeReason(summary), evidence }; }

export function taskAuditFacts(task?: Pick<Task, 'jobId' | 'id' | 'attempt' | 'executionId' | 'capabilities' | 'input'>): Record<string, unknown> {
  if (!task) return {};
  return { job_id: task.jobId, task_id: task.id, attempt: task.attempt, execution_id: task.executionId, capabilities: [...task.capabilities], input_class: task.input.slice(0, 80).replace(/\s+/g, ' ') };
}

export function makeDecisionAudit(input: { task?: Pick<Task, 'jobId' | 'id' | 'attempt' | 'executionId' | 'capabilities' | 'input'>; worker: Record<string, unknown>; contract: Record<string, unknown>; policy: LoadedRoutingPolicy; candidates: readonly ModelCandidate[]; eligibleCandidates: readonly ModelCandidate[]; selected: ModelCandidate; routing: RoutingDecision; priorDecisionId?: string; priorFailure?: AuditFailureEvidence }): DecisionAuditRecord {
  const candidate = (item: ModelCandidate): Record<string, unknown> => ({ id: modelChoiceId(item), provider: item.provider, model: item.model, profile: item.profile ?? null, reasoning: item.reasoning ?? null, resourceHealthy: item.resourceHealthy ?? null, resourceUsedPercent: item.resourceUsedPercent ?? null, resourceRemainingPercent: item.resourceRemainingPercent ?? null, resourceResetAt: item.resourceResetAt ?? null, resourceResetInMinutes: item.resourceResetInMinutes ?? null, resourceWindows: item.resourceWindows ?? null });
  const eligibleIds = new Set(input.eligibleCandidates.map(modelChoiceId));
  const gate_results = input.candidates.map(item => {
    const reasons: string[] = [];
    if (item.resourceHealthy === false) reasons.push('resource_unhealthy');
    const constraints = input.contract.constraints as Record<string, unknown> | undefined;
    const excludedRoutes = Array.isArray(input.contract.excludedRoutes) ? input.contract.excludedRoutes as Array<Record<string, unknown>> : [];
    if (excludedRoutes.some(route => (!route.provider || route.provider === item.provider) && (!route.model || route.model === item.model) && (route.profile === undefined || route.profile === item.profile))) reasons.push('prior_failed_route');
    if (typeof constraints?.provider === 'string' && constraints.provider !== item.provider) reasons.push('provider_constraint');
    if (typeof constraints?.model === 'string' && constraints.model !== item.model) reasons.push('model_constraint');
    if (typeof constraints?.profile === 'string' && constraints.profile !== item.profile) reasons.push('profile_constraint');
    if (input.policy.policy.disabledProviders?.includes(item.provider)) reasons.push('policy_disabled_provider');
    if (item.profile && input.policy.policy.disabledProfiles?.includes(item.profile)) reasons.push('policy_disabled_profile');
    return { candidate_id: modelChoiceId(item), eligible: eligibleIds.has(modelChoiceId(item)), rejection_reasons: reasons };
  });
  return { record_type: 'decision', schema_version: DECISION_AUDIT_SCHEMA_VERSION, decision_id: decisionAuditId(), prior_decision_id: input.priorDecisionId, timestamp: input.routing.decidedAt, correlation: { job_id: input.task?.jobId, task_id: input.task?.id, execution_id: input.task?.executionId, attempt: input.task?.attempt }, task: taskAuditFacts(input.task), worker: input.worker, contract: input.contract, policy: { path: input.policy.path, hash: input.policy.hash, snapshot: input.policy.snapshot as Record<string, unknown>, rules: input.policy.rules }, candidates: input.candidates.map(candidate), gate_results, eligible_candidates: input.eligibleCandidates.map(candidate), selected: candidate(input.selected), engine: input.routing.decidedBy, fallback: { used: input.routing.decisionEvidence?.fallback ?? false, reason: input.routing.decisionEvidence?.error }, decision_evidence: input.routing.decisionEvidence, prior_failure: input.priorFailure };
}


type ExecutionAuditRoute = { id: string; worker: WorkerCandidate; model: ModelCandidate };

function workerAuditCandidate(worker: WorkerCandidate): Record<string, unknown> {
  return {
    id: worker.workerId,
    adapter: worker.adapter,
    runtime: worker.runtime ?? null,
    availability: worker.availability ?? null,
    capabilities: [...worker.capabilities],
    trustDomains: worker.trustDomains ?? [],
    region: worker.region ?? null,
    labels: worker.labels ?? {},
    resourceProvider: worker.resourceProvider ?? null,
    resourceHealthy: worker.resourceHealthy ?? null,
    resourceUsedPercent: worker.resourceUsedPercent ?? null,
    resourceRemainingPercent: worker.resourceRemainingPercent ?? null,
    resourceResetAt: worker.resourceResetAt ?? null,
    resourceResetInMinutes: worker.resourceResetInMinutes ?? null,
    resourceWindows: worker.resourceWindows ?? null,
    browserWorkspaceCapacity: worker.browserWorkspaceCapacity ?? null,
  };
}


function executionRouteAuditCandidate(route: ExecutionAuditRoute): Record<string, unknown> {
  return {
    id: route.id,
    worker: workerAuditCandidate(route.worker),
    model: {
      id: route.model.id,
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
  };
}

export function makeExecutionDecisionAudit(input: {
  task?: Pick<Task, 'jobId' | 'id' | 'attempt' | 'executionId' | 'capabilities' | 'input'>;
  workers: readonly WorkerCandidate[];
  requirements: WorkerRequirements;
  evaluations: readonly ExecutionRouteEvaluation[];
  workerGateEvaluations: readonly WorkerGateEvaluation[];
  selected: ExecutionAuditRoute;
  contract: Record<string, unknown>;
  policy: LoadedRoutingPolicy;
  routing: RoutingDecision;
  decisionStages: Array<{
    name: string;
    facts: import('./decision.js').JsonValue;
    contract: { type: 'choice'; question: string; choices: string[] };
    result: { choice: string; probabilities?: Record<string, number>; bypassed?: boolean };
  }>;
}): DecisionAuditRecord {
  const routeRecords = input.evaluations.map(item => executionRouteAuditCandidate(item.route));
  const eligibleRouteRecords = input.evaluations.filter(item => item.eligible).map(item => executionRouteAuditCandidate(item.route));
  const selectedRecord = executionRouteAuditCandidate(input.selected);
  return {
    record_type: 'decision',
    schema_version: DECISION_AUDIT_SCHEMA_VERSION,
    decision_id: decisionAuditId(),
    timestamp: input.routing.decidedAt,
    correlation: {
      job_id: input.task?.jobId,
      task_id: input.task?.id,
      execution_id: input.task?.executionId,
      attempt: input.task?.attempt,
    },
    task: taskAuditFacts(input.task),
    worker: workerAuditCandidate(input.selected.worker),
    contract: input.contract,
    policy: {
      path: input.policy.path,
      hash: input.policy.hash,
      snapshot: input.policy.snapshot as Record<string, unknown>,
      rules: input.policy.rules,
    },
    candidates: routeRecords,
    gate_results: input.evaluations.map(item => ({
      candidate_id: item.route.id,
      eligible: item.eligible,
      rejection_reasons: [...item.rejectionReasons],
    })),
    eligible_candidates: eligibleRouteRecords,
    selected: selectedRecord,
    engine: input.routing.decidedBy,
    fallback: { used: input.routing.decisionEvidence?.fallback ?? false, reason: input.routing.decisionEvidence?.error },
    decision_evidence: input.routing.decisionEvidence,
    decision_input: {
      type: 'merged_choice_decision',
      stages: input.decisionStages.map(stage => ({
        name: stage.name,
        facts: stage.facts,
        contract: {
          type: stage.contract.type,
          question: stage.contract.question,
          choices: [...stage.contract.choices],
        },
        result: {
          choice: stage.result.choice,
          probabilities: stage.result.probabilities ?? null,
          bypassed: stage.result.bypassed ?? false,
        },
      })),
    },
    worker_candidates: input.workers.map(workerAuditCandidate),
    worker_gate_results: input.workerGateEvaluations.map(item => ({
      worker_id: item.workerId,
      eligible: item.eligible,
      rejection_reasons: [...item.rejectionReasons],
    })),
  };
}
