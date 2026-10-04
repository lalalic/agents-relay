import { readFileSync } from 'node:fs';
import type { Task } from '../types.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';

export const STALE_ORCHESTRATOR_TASK_MS = 30 * 60 * 1000;
export type OrchestratorRescueState = 'idle' | 'check' | 'skip' | 'rescued';

const source = readFileSync(new URL('../../workflow/orchestrator-rescue.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }): boolean => facts.durableFacts[name] === true;

export const orchestratorRescueV2 = new GraphRuntime(source, {
  states: new Set<OrchestratorRescueState>(['idle', 'check', 'skip', 'rescued']),
  guards: { rescuable: boolGuard('rescuable') },
  actions: { 'task.rescueOrchestrator': { id: 'task.rescueOrchestrator' } },
  events: { 'orchestrator.rescue.reconcile': { id: 'orchestrator.rescue.reconcile' } },
});

export function orchestratorRescueFacts(task: Task, now: number): Readonly<Record<string, unknown>> {
  const createdAt = Date.parse(task.createdAt);
  const oldEnough = Number.isFinite(createdAt) && now - createdAt >= STALE_ORCHESTRATOR_TASK_MS;
  return { rescuable: task.kind !== 'planner' && task.adapter === 'orchestrator' && task.state === 'QUEUED' && task.executionId === null && oldEnough };
}

export function decideOrchestratorRescue(task: Task, now: number): GraphDecision {
  return dispatchWorkflowGraphSync(orchestratorRescueV2, {
    initialState: 'idle', input: { transport: 'event', id: 'orchestrator.rescue.reconcile', payload: {} },
    durableFacts: orchestratorRescueFacts(task, now), graphName: 'orchestrator-rescue',
    isTransientState: state => state === 'check', maxSteps: 2,
  });
}


export function applyOrchestratorRescue(task: Task, now: number): { rescued: boolean; ageMs: number } {
  const decision = decideOrchestratorRescue(task, now);
  const rescued = decision.accepted && decision.actions.some(action => action.id === 'task.rescueOrchestrator');
  const ageMs = now - Date.parse(task.createdAt);
  if (!rescued) return { rescued: false, ageMs };
  task.adapter = 'chatgpt';
  task.workerRequirements = { capabilities: [...task.capabilities], runtime: 'chatgpt' };
  task.workerSelection = undefined;
  task.routing = undefined;
  task.timeoutMs = 0;
  task.updatedAt = new Date(now).toISOString();
  return { rescued: true, ageMs };
}
