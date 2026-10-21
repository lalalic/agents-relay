import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type TroubleshooterGraphState =
  | 'idle' | 'check_ordinary' | 'check_run' | 'check_needs' | 'check_id' | 'check_barrier' | 'skip' | 'create'
  | 'resumed_after_authoritative_unblock' | 'fresh_resolution_proposed' | 'remain_failed_without_original_mutation';

const source=readFileSync(new URL('../../workflow/troubleshooter.mmd',import.meta.url),'utf8');
const boolGuard=(name:string)=>(facts:{readonly durableFacts:Readonly<Record<string,unknown>>})=>facts.durableFacts[name]===true;

export const troubleshooterV2=new GraphRuntime(source,{
  states:new Set<TroubleshooterGraphState>(['idle','check_ordinary','check_run','check_needs','check_id','check_barrier','skip','create','resumed_after_authoritative_unblock','fresh_resolution_proposed','remain_failed_without_original_mutation']),
  guards:{
    failedWork:boolGuard('failedWork'),
    ordinaryWork:boolGuard('ordinaryWork'),
    currentRun:boolGuard('currentRun'),
    needsRecovery:boolGuard('needsRecovery'),
    idUnused:boolGuard('idUnused'),
    noRecoveryBarrier:boolGuard('noRecoveryBarrier'),
    freshConditionVerification:boolGuard('freshConditionVerification'),
    resolutionForCurrentExecution:boolGuard('resolutionForCurrentExecution'),
  },
  actions:{'troubleshooter.create':{id:'troubleshooter.create'},'troubleshooter.proposeFreshResolution':{id:'troubleshooter.proposeFreshResolution'},'troubleshooter.applyAuthorizedResolution':{id:'troubleshooter.applyAuthorizedResolution'}},
  events:{'troubleshooter.reconcile':{id:'troubleshooter.reconcile'},'troubleshooter.resumed':{id:'troubleshooter.resumed'},'task.started':{id:'task.started'},'resolution.propose':{id:'resolution.propose'}},
});

export function dispatchTroubleshooter(facts:Readonly<Record<string,unknown>>, onCreate:()=>void):GraphDecision{
  return dispatchWorkflowGraphSync(troubleshooterV2,{
    initialState:'idle', input:{transport:'event',id:'troubleshooter.reconcile',payload:{}}, durableFacts:facts,graphName:'troubleshooter',
    isTransientState:state=>state.startsWith('check_'), maxSteps:6,
    executeAction:actionId=>{ if(actionId==='troubleshooter.create') onCreate(); else throw new Error('Unsupported troubleshooter graph action '+actionId); return {}; },
  });
}
export function decideTroubleshooter(facts:Readonly<Record<string,unknown>>):GraphDecision{ return dispatchTroubleshooter(facts,()=>{}); }
