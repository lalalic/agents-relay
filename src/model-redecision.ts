import { DecisionAuditStore, AuditFailureEvidence, DecisionAuditRecord, outcomeForDecision } from './decision-audit.js';
import { discoverModelCandidates, ModelRoutingDecision, routeModel } from './model-routing.js';
import { AgentRegistration, Task, RoutingDecision } from './types.js';
import { readUsageSnapshot, UsageSnapshotProvider } from './usage.js';
import { WorkerCandidate } from './worker-routing.js';
import { DecisionEngine, DecisionMode } from './decision.js';

export type FailureClassification = 'model_provider_runtime' | 'worker_tool_infrastructure' | 'semantic_task' | 'timeout_unknown';
export type FailureEvidence = AuditFailureEvidence & { classification: FailureClassification };

export type FailureEvidenceInput = { events: readonly { type: string; message?: string; data?: Record<string, unknown> }[]; logs?: readonly string[]; taskError?: string | null };

/** Classify from durable lifecycle evidence and logs; task.error is only a supporting hint. */
export function classifyFailureEvidence(input: FailureEvidenceInput): FailureEvidence {
  const text = [...input.events.map(event => `${event.type} ${event.message ?? ''} ${JSON.stringify(event.data ?? {})}`), ...(input.logs ?? [])].join('\n').toLowerCase();
  const model = /model|provider|laya|launch|auth|credential|configuration|incompatible|rate.?limit|quota|unavailable/.test(text);
  const infra = /worker|tool|daemon|relay|network|socket|nats|checkout|filesystem/.test(text);
  const semantic = /assert|test failed|implementation|compile|typescript|syntax|semantic/.test(text);
  const timeout = /timeout|timed out|deadline/.test(text);
  if (model && !infra) return { classification: 'model_provider_runtime', summary: 'Durable events/logs indicate the selected model/provider/runtime path failed.', sources: ['task.events', 'worker.logs'] };
  if (infra) return { classification: 'worker_tool_infrastructure', summary: 'Durable events/logs indicate worker, tool, or infrastructure failure unrelated to model choice.', sources: ['task.events', 'worker.logs'] };
  if (semantic) return { classification: 'semantic_task', summary: 'Durable events/logs indicate meaningful task execution failed semantically.', sources: ['task.events', 'worker.logs'] };
  if (timeout) return { classification: 'timeout_unknown', summary: 'Timeout evidence is insufficient to attribute failure to model choice.', sources: ['task.events', 'worker.logs'] };
  return { classification: 'timeout_unknown', summary: input.events.length === 0 && !input.logs?.length ? 'No durable event or log evidence was supplied.' : 'Failure attribution is unknown from the available evidence.', sources: ['task.events', 'worker.logs'] };
}

export type ModelRedecisionOptions = {
  task: Task;
  worker: WorkerCandidate;
  registered: readonly AgentRegistration[];
  usage: UsageSnapshotProvider;
  auditStore?: DecisionAuditStore;
  decisionEngine?: DecisionEngine;
  decisionMode?: DecisionMode;
  policyPath?: string;
  rulesPath?: string;
  evidence: FailureEvidence;
  updateRouting: (task: Task, routing: RoutingDecision) => Promise<void>;
};

export type ModelRedecisionResult = ModelRoutingDecision & { freshUsageGeneratedAt: string };

/** Re-route only. This action never retries or changes the Task lifecycle. */
export async function redecideFailedTask(options: ModelRedecisionOptions): Promise<ModelRedecisionResult> {
  if (options.evidence.classification !== 'model_provider_runtime') throw new Error('Model re-decision requires model/provider/runtime evidence');
  const usage = await readUsageSnapshot(options.usage);
  const candidates = await discoverModelCandidates(options.worker, options.registered, usage, undefined, options.rulesPath);
  const result = await routeModel(options.worker, candidates, {
    decisionEngine: options.decisionEngine,
    decisionMode: options.decisionMode,
    policyPath: options.policyPath,
    rulesPath: options.rulesPath,
    auditStore: options.auditStore,
    auditTask: options.task,
    taskFacts: { kind: options.task.kind ?? 'work', capabilities: options.task.capabilities, taskCapabilities: options.task.taskCapabilities, workerCapabilities: options.task.workerCapabilities, input: options.task.input, prior_routing: options.task.routing ?? null, fresh_usage_generated_at: usage.generatedAt },
    priorDecisionId: options.task.routing?.decisionId,
    priorFailure: options.evidence,
    excludedRoutes: options.task.routing ? [{ provider: options.task.routing.provider, model: options.task.routing.model, profile: options.task.routing.profile }] : [],
  });
  await options.updateRouting(options.task, result.routing);
  if (options.auditStore && options.task.routing?.decisionId) await options.auditStore.append(outcomeForDecision(options.task.routing.decisionId, 'provider_failure', options.evidence.summary, { classification: options.evidence.classification, fresh_usage_generated_at: usage.generatedAt }));
  return { ...result, freshUsageGeneratedAt: usage.generatedAt };
}
