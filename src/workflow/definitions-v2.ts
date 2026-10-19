import { ConditionRegistry, booleanCondition } from './conditions.js';
import { readFileSync } from 'node:fs';
import { GraphRuntime, type Graph, type GraphRegistries } from './graph-v2.js';
import {
  WORKFLOW_EFFECT_NAMES,
  WORKFLOW_EVENT_NAMES,
  WORKFLOW_MUTATION_NAMES,
} from './contracts.js';

const TASK_STATES = ['DRAFT','QUEUED','RUNNING','BLOCKED','SUCCEEDED','FAILED','CANCELLED'] as const;
const JOB_STATES = ['DRAFT','ACTIVE','COMPLETED','CANCELLED'] as const;

const conditionRegistry = new ConditionRegistry([
  ...new Set(['dependenciesSatisfied','dependenciesUnsatisfied','runnable','dispatchable','recoverableExecution','troubleshooterRecovery','retryAvailable','autonomousJob','platformFallbackSafe','notMerged','autoMerge','prOpen','reviewDisabled','implementationComplete','headAvailable','mergeCapable','localCompletionAllowed','localMergeReady'])
].map(booleanCondition));
const boolGuard = (name: string) => conditionRegistry.guard(name);
export const lifecycleConditions = conditionRegistry;

function eventRegistry(): GraphRegistries['events'] {
  return Object.fromEntries(WORKFLOW_EVENT_NAMES.map(id => [id, { id }]));
}

function actionRegistry(): GraphRegistries['actions'] {
  return Object.fromEntries(
    [...WORKFLOW_MUTATION_NAMES, ...WORKFLOW_EFFECT_NAMES].map(id => [id, { id }]),
  );
}

function load(name: string, states: readonly string[], guards: GraphRegistries['guards']): GraphRuntime {
  const url = new URL(`../../workflow/${name}.mmd`, import.meta.url);
  return new GraphRuntime(readFileSync(url, 'utf8'), {
    states: new Set(states),
    guards,
    actions: actionRegistry(),
    events: eventRegistry(),
  });
}

export const taskLifecycleV2 = load('task-lifecycle', TASK_STATES, {
  dependenciesSatisfied: boolGuard('dependenciesSatisfied'),
  dependenciesUnsatisfied: boolGuard('dependenciesUnsatisfied'),
  runnable: boolGuard('runnable'),
  dispatchable: boolGuard('dispatchable'),
  recoverableExecution: boolGuard('recoverableExecution'),
  troubleshooterRecovery: boolGuard('troubleshooterRecovery'),
  retryAvailable: boolGuard('retryAvailable'),
  autonomousJob: boolGuard('autonomousJob'),
  platformFallbackSafe: boolGuard('platformFallbackSafe'),
});

export const jobLifecycleV2 = load('job-lifecycle', JOB_STATES, {
  notMerged: boolGuard('notMerged'),
  autoMerge: boolGuard('autoMerge'),
  prOpen: boolGuard('prOpen'),
  reviewDisabled: boolGuard('reviewDisabled'),
  implementationComplete: boolGuard('implementationComplete'),
  headAvailable: boolGuard('headAvailable'),
  mergeCapable: boolGuard('mergeCapable'),
  localCompletionAllowed: boolGuard('localCompletionAllowed'),
  localMergeReady: boolGuard('localMergeReady'),
});

function topologyTargets(graph: Graph, from: string): Set<string> {
  const source = [...graph.nodes.values()].find(node => node.kind === 'state' && node.semanticId === from);
  if (!source) throw new Error(`Unknown workflow state ${from}`);
  const targets = new Set<string>();
  const visit = (nodeId: string, seen: Set<string>): void => {
    if (seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = graph.nodes.get(nodeId);
    if (!node) return;
    if (node.kind === 'state') {
      targets.add(node.semanticId);
      return;
    }
    for (const edge of graph.edges) {
      if (edge.from === nodeId && edge.kind !== 'emit') visit(edge.to, new Set(seen));
    }
  };
  for (const edge of graph.edges) {
    if (edge.from === source.id && (edge.kind === 'on' || edge.kind === 'request')) {
      visit(edge.to, new Set([source.id]));
    }
  }
  return targets;
}

export function assertV2StateTransition(graph: Graph, from: string, to: string, kind: string): void {
  if (from === to) return;
  const states = new Set([...graph.nodes.values()].filter(node => node.kind === 'state').map(node => node.semanticId));
  if (!states.has(from) || !states.has(to)) throw new Error(`Unknown ${kind} state ${!states.has(from) ? from : to}`);
  if (!topologyTargets(graph, from).has(to)) throw new Error(`Invalid ${kind} transition ${from} -> ${to}`);
}
