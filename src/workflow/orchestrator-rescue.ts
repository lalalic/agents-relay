import { readFileSync } from 'node:fs';
import type { Task } from '../types.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { tryTransitionTaskEvent } from '../scheduler.js';
import { taskOverallTimeoutMs } from '../types.js';

export const STALE_ORCHESTRATOR_TASK_MS = 30 * 60 * 1000;
export type OrchestratorRescueState = 'idle' | 'check' | 'external_completed' | 'skip' | 'rescued';

const source = readFileSync(new URL('../../workflow/orchestrator-rescue.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }): boolean => facts.durableFacts[name] === true;

export const orchestratorRescueV2 = new GraphRuntime(source, {
  states: new Set<OrchestratorRescueState>(['idle', 'check', 'external_completed', 'skip', 'rescued']),
  guards: {
    legacyActive: boolGuard('legacyActive'),
    externallyCompleted: boolGuard('externallyCompleted'),
    rescuable: boolGuard('rescuable'),
  },
  actions: {
    'task.applyExternalCompletion': { id: 'task.applyExternalCompletion' },
    'task.rescueOrchestrator': { id: 'task.rescueOrchestrator' },
  },
  events: { 'orchestrator.rescue.reconcile': { id: 'orchestrator.rescue.reconcile' } },
});

export function orchestratorRescueFacts(task: Task, now: number): Readonly<Record<string, unknown>> {
  const legacyActive = task.kind !== 'planner' && task.adapter === 'orchestrator'
    && (task.state === 'QUEUED' || task.state === 'RUNNING');
  return {
    legacyActive,
    externallyCompleted: legacyActive && task.result !== null,
    rescuable: legacyActive && task.result === null
      && (!task.leaseExpiresAt || Date.parse(task.leaseExpiresAt) <= now),
  };
}

export function decideOrchestratorRescue(task: Task, now: number): GraphDecision {
  return dispatchWorkflowGraphSync(orchestratorRescueV2, {
    initialState: 'idle', input: { transport: 'event', id: 'orchestrator.rescue.reconcile', payload: {} },
    durableFacts: orchestratorRescueFacts(task, now), graphName: 'orchestrator-rescue',
    isTransientState: state => state === 'check', maxSteps: 4,
  });
}

export function prepareOrchestratorRepair(task: Task, now: number): {
  repaired: boolean; externallyCompleted: boolean; ageMs: number;
} {
  const decision = decideOrchestratorRescue(task, now);
  const externallyCompleted = decision.accepted
    && decision.actions.some(action => action.id === 'task.applyExternalCompletion');
  const rescued = externallyCompleted
    || (decision.accepted && decision.actions.some(action => action.id === 'task.rescueOrchestrator'));
  const ageMs = now - Date.parse(task.createdAt);
  if (decision.accepted && externallyCompleted) {
    tryTransitionTaskEvent(task, 'task.completed');
    task.leaseOwner = null;
    task.leaseExpiresAt = null;
    task.executionId = null;
    task.threadId = null;
    task.updatedAt = new Date(now).toISOString();
    return { repaired: true, externallyCompleted: true, ageMs };
  }
  if (!rescued) return { repaired: false, externallyCompleted: false, ageMs };
  if (task.state === 'RUNNING') {
    tryTransitionTaskEvent(task, 'execution.orphaned', { retryAvailable: task.attempt < task.maxAttempts });
  }
  task.adapter = 'codex';
  task.workerRequirements = { capabilities: [...task.capabilities] };
  task.workerSelection = undefined;
  task.routing = undefined;
  task.leaseOwner = null;
  task.leaseExpiresAt = null;
  task.executionId = null;
  task.threadId = null;
  task.timeoutMs = taskOverallTimeoutMs(task.storySize ?? 'M');
  task.updatedAt = new Date(now).toISOString();
  return { repaired: true, externallyCompleted: false, ageMs };
}
