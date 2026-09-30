import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';
import type { Job } from '../types.js';
import { isEffectivelyBlocked } from '../unblock.js';

export type PlannerOrchestrationState =
  | 'idle' | 'check_legacy_pending' | 'check_recover' | 'check_seed' | 'check_planner'
  | 'check_blocked' | 'check_work' | 'check_materialized' | 'check_objective'
  | 'wait' | 'recovered' | 'created';

const source = readFileSync(new URL('../../workflow/planner-orchestration.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const plannerOrchestrationV2 = new GraphRuntime(source, {
  states: new Set<PlannerOrchestrationState>([
    'idle','check_legacy_pending','check_recover','check_seed','check_planner',
    'check_blocked','check_work','check_materialized','check_objective','wait','recovered','created',
  ]),
  guards: {
    autonomousJob: boolGuard('autonomousJob'),
    legacyPlanningPending: boolGuard('legacyPlanningPending'),
    recoverablePendingPlan: boolGuard('recoverablePendingPlan'),
    hasSeedWork: boolGuard('hasSeedWork'),
    noActivePlanner: boolGuard('noActivePlanner'),
    noBlockedWork: boolGuard('noBlockedWork'),
    noActiveImplementation: boolGuard('noActiveImplementation'),
    continuationMaterialized: boolGuard('continuationMaterialized'),
    objectiveUnsatisfied: boolGuard('objectiveUnsatisfied'),
  },
  actions: {
    'planner.recoverPending': { id: 'planner.recoverPending' },
    'planner.createRound': { id: 'planner.createRound' },
  },
  events: { 'planner.reconcile': { id: 'planner.reconcile' } },
});

export async function dispatchPlannerOrchestration(facts:Readonly<Record<string,unknown>>, executeAction?:(actionId:string)=>ActionReceipt|Promise<ActionReceipt>):Promise<GraphDecision>{
  return dispatchWorkflowGraph(plannerOrchestrationV2,{initialState:'idle',input:{transport:'event',id:'planner.reconcile',payload:{}},durableFacts:facts,isTransientState:state=>state.startsWith('check_'),maxSteps:9,executeAction});
}
export function decidePlannerOrchestration(facts:Readonly<Record<string,unknown>>):GraphDecision{
  return dispatchWorkflowGraphSync(plannerOrchestrationV2,{initialState:'idle',input:{transport:'event',id:'planner.reconcile',payload:{}},durableFacts:facts,isTransientState:state=>state.startsWith('check_'),maxSteps:9});
}


export function plannerOrchestrationFacts(job: Job, recoverablePendingPlan: boolean): Readonly<Record<string, unknown>> {
  const slot = job.schedule?.currentRunSlot ? Date.parse(job.schedule.currentRunSlot) : Number.NaN;
  const scopedTasks = Number.isFinite(slot) ? job.tasks.filter(task => Date.parse(task.createdAt) >= slot) : job.tasks;
  const scopedPlans = (job.plans ?? []).filter(plan => !Number.isFinite(slot) || Date.parse(plan.createdAt) >= slot)
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
  const latestPlan = scopedPlans.at(-1);
  const legacyLatest = scopedPlans.length === 0
    ? scopedTasks.filter(task => task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1)
    : undefined;
  const latestId = latestPlan?.id ?? legacyLatest?.id;
  const latestObjective = latestPlan?.objectiveStatus ?? legacyLatest?.plannerResult?.objective_status;
  return {
    autonomousJob: job.executionMode === 'autonomous',
    legacyPlanningPending: job.initialPlanning?.status === 'pending',
    recoverablePendingPlan,
    hasSeedWork: !((job.plans?.length ?? 0) === 0 && job.tasks.filter(task => task.kind !== 'planner').length === 0),
    noActivePlanner: !scopedPlans.some(plan => plan.status === 'PLANNING'),
    noBlockedWork: !scopedTasks.some(task => task.kind !== 'planner' && isEffectivelyBlocked(task)),
    noActiveImplementation: !scopedTasks.some(task => task.kind !== 'planner' && ['DRAFT', 'QUEUED', 'RUNNING'].includes(task.state)),
    continuationMaterialized: !(latestObjective === 'in_progress' && latestId && !job.tasks.some(task => task.kind !== 'planner' && task.planningDecisionId === latestId)),
    objectiveUnsatisfied: latestObjective !== 'satisfied',
  };
}
