import { readFileSync } from 'node:fs';
import type { Job, Task, TaskResolution, TaskResolutionPath, TaskResolutionProposal } from '../types.js';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';

export const TASK_RESOLUTION_PATHS: readonly TaskResolutionPath[] = [
  'exact_original_retry', 'same_job_dependency', 'blocker_job_dependency', 'escalation_gate', 'cancel_supersede',
];

const source = readFileSync(new URL('../../workflow/task-resolution.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }): boolean => facts.durableFacts[name] === true;
export const taskResolutionV2 = new GraphRuntime(source, {
  states: new Set(['unresolved', 'check_owner', 'check_path', 'resolved']),
  guards: {
    recoveryOwnerAvailable: boolGuard('recoveryOwnerAvailable'), plannerOwnerAvailable: boolGuard('plannerOwnerAvailable'),
    exactOriginalRetry: boolGuard('exactOriginalRetry'), sameJobDependency: boolGuard('sameJobDependency'),
    blockerJobDependency: boolGuard('blockerJobDependency'), escalationGate: boolGuard('escalationGate'), genuinelyObsolete: boolGuard('genuinelyObsolete'),
  },
  actions: Object.fromEntries(['resolution.activateRecovery','resolution.attachSameJobDependency','resolution.registerBlockerDependency','resolution.createEscalationGate','resolution.cancelSupersede'].map(id => [id, { id }])),
  events: { 'resolution.propose': { id: 'resolution.propose' } },
});

export function unresolvedTask(task: Task): boolean { return task.kind !== 'planner' && !['SUCCEEDED', 'CANCELLED'].includes(task.state); }
export function validateResolutionProposal(job: Job, original: Task, proposal: TaskResolutionProposal): void {
  if (!TASK_RESOLUTION_PATHS.includes(proposal.path)) throw new Error(`Unknown task resolution path ${proposal.path}`);
  if (proposal.path === 'exact_original_retry' && original.state !== 'FAILED') throw new Error('Exact-original retry requires a FAILED original Task');
  if (proposal.path === 'same_job_dependency' && (!proposal.targetTaskId || !job.tasks.some(task => task.id === proposal.targetTaskId && task.jobId === job.id))) throw new Error('Same-Job dependency resolution requires an existing target Task in the same Job');
  if (proposal.path === 'blocker_job_dependency' && (!proposal.targetJobId || !proposal.mode)) throw new Error('Blocker-Job dependency resolution requires targetJobId and merge or verified mode');
  if (proposal.path === 'escalation_gate' && (!proposal.rootCause || !proposal.solution)) throw new Error('Escalation gate resolution requires rootCause and solution');
  if (proposal.path === 'cancel_supersede' && !proposal.rootCause) throw new Error('Cancellation/supersession requires an explicit obsolescence rootCause');
}
export function resolutionFacts(task: Task, proposal: TaskResolutionProposal, owner: TaskResolution['owner']): Readonly<Record<string, unknown>> {
  return { recoveryOwnerAvailable: owner === 'troubleshooter', plannerOwnerAvailable: owner !== null && owner !== 'troubleshooter', exactOriginalRetry: proposal.path === 'exact_original_retry', sameJobDependency: proposal.path === 'same_job_dependency', blockerJobDependency: proposal.path === 'blocker_job_dependency', escalationGate: proposal.path === 'escalation_gate', genuinelyObsolete: proposal.path === 'cancel_supersede', unresolved: unresolvedTask(task) };
}
export function decideTaskResolution(task: Task, proposal: TaskResolutionProposal, owner: TaskResolution['owner']): GraphDecision {
  return dispatchWorkflowGraphSync(taskResolutionV2, { initialState: 'unresolved', input: { transport: 'event', id: 'resolution.propose', payload: proposal }, durableFacts: resolutionFacts(task, proposal, owner), graphName: 'task-resolution', isTransientState: state => state === 'check_owner' || state === 'check_path', maxSteps: 4 });
}

export type TaskResolutionEffects = {
  activateRecovery?: () => void | Promise<void>;
  attachSameJobDependency?: () => void | Promise<void>;
  registerBlockerDependency?: () => void | Promise<void>;
  createEscalationGate?: () => void | Promise<void>;
  cancelSupersede?: () => void | Promise<void>;
};

export function dispatchTaskResolutionSync(
  task: Task, proposal: TaskResolutionProposal, owner: TaskResolution['owner'], effects: TaskResolutionEffects,
): GraphDecision {
  const handlers: Record<string, (() => void) | undefined> = {
    'resolution.activateRecovery': effects.activateRecovery as (() => void) | undefined,
    'resolution.attachSameJobDependency': effects.attachSameJobDependency as (() => void) | undefined,
    'resolution.registerBlockerDependency': effects.registerBlockerDependency as (() => void) | undefined,
    'resolution.createEscalationGate': effects.createEscalationGate as (() => void) | undefined,
    'resolution.cancelSupersede': effects.cancelSupersede as (() => void) | undefined,
  };
  return dispatchWorkflowGraphSync(taskResolutionV2, {
    initialState: 'unresolved', input: { transport: 'event', id: 'resolution.propose', payload: proposal },
    durableFacts: resolutionFacts(task, proposal, owner), graphName: 'task-resolution',
    isTransientState: state => state === 'check_owner' || state === 'check_path', maxSteps: 6,
    executeAction: actionId => { const handler=handlers[actionId]; if(!handler) throw new Error(`Task resolution effect ${actionId} is unavailable`); handler(); return {}; },
  });
}

export async function dispatchTaskResolution(
  task: Task, proposal: TaskResolutionProposal, owner: TaskResolution['owner'], effects: TaskResolutionEffects,
): Promise<GraphDecision> {
  const handlers: Record<string, (() => void | Promise<void>) | undefined> = {
    'resolution.activateRecovery': effects.activateRecovery,
    'resolution.attachSameJobDependency': effects.attachSameJobDependency,
    'resolution.registerBlockerDependency': effects.registerBlockerDependency,
    'resolution.createEscalationGate': effects.createEscalationGate,
    'resolution.cancelSupersede': effects.cancelSupersede,
  };
  return dispatchWorkflowGraph(taskResolutionV2, {
    initialState: 'unresolved',
    input: { transport: 'event', id: 'resolution.propose', payload: proposal },
    durableFacts: resolutionFacts(task, proposal, owner),
    graphName: 'task-resolution',
    isTransientState: state => state === 'check_owner' || state === 'check_path',
    maxSteps: 6,
    executeAction: async actionId => {
      const handler = handlers[actionId];
      if (!handler) throw new Error(`Task resolution effect ${actionId} is unavailable`);
      await handler();
      return {} as ActionReceipt;
    },
  });
}

export function materializeResolution(task: Task, proposal: TaskResolutionProposal, owner: TaskResolution['owner'], now = new Date().toISOString()): TaskResolution {
  return { ...proposal, state: proposal.path === 'escalation_gate' || proposal.path === 'blocker_job_dependency' ? 'waiting' : 'active', owner, updatedAt: now };
}

/** Apply the graph-selected ownership to the original durable Task under the
 * caller's existing atomic store boundary. This does not create replacement
 * identity; the original remains the semantic owner of the outcome. */
export function attachResolutionOwnership(job: Job, child: Task, proposal: TaskResolutionProposal, owner: TaskResolution['owner']): Task {
  const original = proposal.targetTaskId ? job.tasks.find(task => task.id === proposal.targetTaskId) : undefined;
  if (!original) throw new Error(`Resolution target ${proposal.targetTaskId ?? '(missing)'} not found`);
  if (proposal.path !== 'same_job_dependency') throw new Error(`Planner child resolution ${proposal.path} cannot materialize replacement work; use the dedicated resolution effect`);
  const normalized = { ...proposal, targetTaskId: child.id };
  const decision = dispatchTaskResolutionSync(original, normalized, owner, { attachSameJobDependency: () => {
    if (!original.dependencies.includes(child.id)) original.dependencies = [...original.dependencies, child.id];
    original.resolution = { ...materializeResolution(original, normalized, owner), state: 'waiting' };
  } });
  if (!decision.accepted) throw new Error(`Task resolution graph rejected same-Job dependency for ${original.id}`);
  return original;
}

export function claimExactOriginalRecovery(original: Task, recovery: Task): void {
  original.resolution = materializeResolution(original, { path: 'exact_original_retry', targetTaskId: original.id, rootCause: original.failureReason ?? original.error ?? 'durable failure', solution: `Troubleshooter ${recovery.id} diagnosis and exact-original recovery` }, 'troubleshooter');
}
