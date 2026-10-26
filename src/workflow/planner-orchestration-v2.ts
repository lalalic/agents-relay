import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';
import type { Job } from '../types.js';
import { isEffectivelyBlocked, unblockNeedsNewPlan, unconsumedUnblockTrigger } from '../unblock.js';

export type PlannerOrchestrationState =
  | 'idle' | 'check_legacy_pending' | 'check_recover' | 'check_plan_failure' | 'check_plan_recovery' | 'check_plan_recovery_exists' | 'check_seed' | 'check_planner'
  | 'check_resolution_ownership' | 'check_blocked' | 'check_work' | 'check_materialized' | 'check_objective'
  | 'wait' | 'recovered' | 'created';

const source = readFileSync(new URL('../../workflow/planner-orchestration.mmd', import.meta.url), 'utf8');
const boolGuard = (name: string) => (facts: { readonly durableFacts: Readonly<Record<string, unknown>> }) => facts.durableFacts[name] === true;

export const plannerOrchestrationV2 = new GraphRuntime(source, {
  states: new Set<PlannerOrchestrationState>([
    'idle','check_legacy_pending','check_recover','check_plan_failure','check_plan_recovery','check_plan_recovery_exists','check_seed','check_planner','check_resolution_ownership',
    'check_blocked','check_work','check_materialized','check_objective','wait','recovered','created',
  ]),
  guards: {
    legacyPlanningPending: boolGuard('legacyPlanningPending'),
    recoverablePendingPlan: boolGuard('recoverablePendingPlan'),
    terminalPlanFailure: boolGuard('terminalPlanFailure'),
    planRecoveryExists: boolGuard('planRecoveryExists'),
    planRecoveryVerified: boolGuard('planRecoveryVerified'),
    hasSeedWork: boolGuard('hasSeedWork'),
    noActivePlanner: boolGuard('noActivePlanner'),
    resolutionOwnedByTroubleshooter: boolGuard('resolutionOwnedByTroubleshooter'),
    noBlockedWork: boolGuard('noBlockedWork'),
    noActiveImplementation: boolGuard('noActiveImplementation'),
    continuationMaterialized: boolGuard('continuationMaterialized'),
    objectiveUnsatisfied: boolGuard('objectiveUnsatisfied'),
  },
  actions: {
    'planner.createRecovery': { id: 'planner.createRecovery' },
    'planner.recoverPending': { id: 'planner.recoverPending' },
    'planner.createRound': { id: 'planner.createRound' },
  },
  events: { 'planner.reconcile': { id: 'planner.reconcile' } },
});

export async function dispatchPlannerOrchestration(facts:Readonly<Record<string,unknown>>, executeAction?:(actionId:string)=>ActionReceipt|Promise<ActionReceipt>):Promise<GraphDecision>{
  return dispatchWorkflowGraph(plannerOrchestrationV2,{initialState:'idle',input:{transport:'event',id:'planner.reconcile',payload:{}},durableFacts:facts,graphName:'planner-orchestration',isTransientState:state=>state.startsWith('check_'),maxSteps:14,executeAction});
}
export function decidePlannerOrchestration(facts:Readonly<Record<string,unknown>>):GraphDecision{
  return dispatchWorkflowGraphSync(plannerOrchestrationV2,{initialState:'idle',input:{transport:'event',id:'planner.reconcile',payload:{}},durableFacts:facts,graphName:'planner-orchestration',isTransientState:state=>state.startsWith('check_'),maxSteps:14});
}


export function plannerOrchestrationFacts(job: Job, recoverablePendingPlan: boolean): Readonly<Record<string, unknown>> {
  const scopedTasks = job.tasks;
  const scopedPlans = (job.plans ?? [])
    .sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
  const latestPlan = scopedPlans.at(-1);
  const failedPlan = latestPlan?.status === 'FAILED' ? latestPlan : null;
  const recovery = failedPlan ? job.tasks.find(task => task.agentName === 'troubleshooter' && task.recoveryPlanId === failedPlan.id) : undefined;
  const recoveryVerified = recovery?.state === 'SUCCEEDED'
    && recovery.result?.data?.verified === true
    && typeof recovery.result?.data?.evidence === 'string'
    && recovery.result.data.evidence.trim().length > 0;
  const legacyLatest = scopedPlans.length === 0
    ? scopedTasks.filter(task => task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1)
    : undefined;
  const latestId = latestPlan?.id ?? legacyLatest?.id;
  const latestObjective = latestPlan?.objectiveStatus ?? legacyLatest?.plannerResult?.objective_status;
  return {
    legacyPlanningPending: job.initialPlanning?.status === 'pending',
    recoverablePendingPlan,
    terminalPlanFailure: Boolean(failedPlan && (!failedPlan.manualPlanning || failedPlan.forceRestate) && failedPlan.trigger.source !== 'unblock'),
    planRecoveryExists: Boolean(recovery),
    planRecoveryVerified: recoveryVerified,
    hasSeedWork: !((job.plans?.length ?? 0) === 0 && job.tasks.filter(task => task.kind !== 'planner').length === 0),
    noActivePlanner: failedPlan?.manualPlanning ? false : unblockNeedsNewPlan(job) || !unconsumedUnblockTrigger(job) ? !scopedPlans.some(plan => plan.status === 'PLANNING') : false,
    noBlockedWork: Boolean(unconsumedUnblockTrigger(job)) || !scopedTasks.some(task => task.kind !== 'planner' && isEffectivelyBlocked(task)),
    noActiveImplementation: !scopedTasks.some(task => task.kind !== 'planner' && (['QUEUED', 'RUNNING'].includes(task.state) || (task.state === 'DRAFT' && !task.unblock))),
    resolutionOwnedByTroubleshooter: scopedTasks.some(task => task.kind !== 'planner' && task.resolution?.owner === 'troubleshooter' && ['active', 'waiting'].includes(task.resolution.state)),
    continuationMaterialized: Boolean(unconsumedUnblockTrigger(job)) || !(latestObjective === 'in_progress' && latestId && !job.tasks.some(task => task.kind !== 'planner' && task.planningDecisionId === latestId)),
    objectiveUnsatisfied: latestObjective !== 'satisfied',
  };
}
