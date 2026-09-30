import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
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
  decision_input?: { facts: Record<string, unknown>; contract: { type: string; question: string; choices: string[] } };
};
export type DecisionOutcomeRecord = {
  record_type: 'outcome'; schema_version: number; outcome_id: string; decision_id: string; timestamp: string;
  kind: 'launch_failure' | 'provider_failure' | 'runtime_failure' | 'auth_config_failure' | 'task_started' | 'semantic_failure' | 'timeout' | 'cancelled' | 'success';
  summary: string; evidence?: Record<string, unknown>;
};

export interface DecisionAuditStore { append(record: DecisionAuditRecord | DecisionOutcomeRecord): Promise<void>; read(): Promise<Array<DecisionAuditRecord | DecisionOutcomeRecord>>; }

export class JsonlDecisionAuditStore implements DecisionAuditStore {
  constructor(readonly path: string) {}
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
export function outcomeForDecision(decisionId: string, kind: DecisionOutcomeRecord['kind'], summary: string, evidence?: Record<string, unknown>): DecisionOutcomeRecord { return { record_type: 'outcome', schema_version: DECISION_AUDIT_SCHEMA_VERSION, outcome_id: randomUUID(), decision_id: decisionId, timestamp: new Date().toISOString(), kind, summary, evidence }; }

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
  decisionRequest: { facts: import('./decision.js').JsonValue };
  decisionContract: { type: 'choice'; question: string; choices: readonly string[] };
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
      facts: input.decisionRequest.facts as Record<string, unknown>,
      contract: {
        type: input.decisionContract.type,
        question: input.decisionContract.question,
        choices: [...input.decisionContract.choices],
      },
    },
    worker_candidates: input.workers.map(workerAuditCandidate),
    worker_gate_results: input.workerGateEvaluations.map(item => ({
      worker_id: item.workerId,
      eligible: item.eligible,
      rejection_reasons: [...item.rejectionReasons],
    })),
  };
}
