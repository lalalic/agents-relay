import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';

export type BlockerResolutionGraphState =
  | 'waiting' | 'check_target' | 'check_autonomous' | 'check_effective' | 'check_already_unblocked'
  | 'check_draft' | 'check_blocked' | 'check_failed' | 'check_unblocked' | 'wait' | 'obsolete' | 'resumed';

const source=readFileSync(new URL('../../workflow/blocker-resolution-v2.mmd',import.meta.url),'utf8');
const boolGuard=(name:string)=>(facts:{readonly durableFacts:Readonly<Record<string,unknown>>})=>facts.durableFacts[name]===true;

export const blockerResolutionV2=new GraphRuntime(source,{
  states:new Set<BlockerResolutionGraphState>([
    'waiting','check_target','check_autonomous','check_effective','check_already_unblocked',
    'check_draft','check_blocked','check_failed','check_unblocked','wait','obsolete','resumed',
  ]),
  guards:{
    resolutionAllowed:boolGuard('resolutionAllowed'),
    targetMatches:boolGuard('targetMatches'),
    autonomousJob:boolGuard('autonomousJob'),
    effectivelyBlocked:boolGuard('effectivelyBlocked'),
    alreadyUnblocked:boolGuard('alreadyUnblocked'),
    isDraft:boolGuard('isDraft'),
    isBlocked:boolGuard('isBlocked'),
    isFailed:boolGuard('isFailed'),
    isUnblocked:boolGuard('isUnblocked'),
  },
  actions:Object.fromEntries([
    'blocker.autonomousUnblock','blocker.acceptExistingUnblock','blocker.releaseDraft',
    'blocker.unblockTask','blocker.retryFailed','blocker.retryUnblocked',
  ].map(id=>[id,{id}])),
  events:{'blocker.resolved':{id:'blocker.resolved'}},
});

export async function dispatchBlockerResolution(facts:Readonly<Record<string,unknown>>, executeAction?:(actionId:string)=>ActionReceipt|Promise<ActionReceipt>):Promise<GraphDecision>{
  return dispatchWorkflowGraph(blockerResolutionV2,{initialState:'waiting',input:{transport:'event',id:'blocker.resolved',payload:{}},durableFacts:facts,isTransientState:state=>state.startsWith('check_'),maxSteps:10,executeAction});
}
export function decideBlockerResolution(facts:Readonly<Record<string,unknown>>):GraphDecision{
  return dispatchWorkflowGraphSync(blockerResolutionV2,{initialState:'waiting',input:{transport:'event',id:'blocker.resolved',payload:{}},durableFacts:facts,isTransientState:state=>state.startsWith('check_'),maxSteps:10});
}
