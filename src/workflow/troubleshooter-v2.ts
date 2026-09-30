import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';

export type TroubleshooterGraphState =
  | 'idle' | 'check_ordinary' | 'check_run' | 'check_needs' | 'check_id' | 'check_barrier' | 'skip' | 'create';

const source=readFileSync(new URL('../../workflow/troubleshooter-v2.mmd',import.meta.url),'utf8');
const boolGuard=(name:string)=>(facts:{readonly durableFacts:Readonly<Record<string,unknown>>})=>facts.durableFacts[name]===true;

export const troubleshooterV2=new GraphRuntime(source,{
  states:new Set<TroubleshooterGraphState>(['idle','check_ordinary','check_run','check_needs','check_id','check_barrier','skip','create']),
  guards:{
    failedOrBlocked:boolGuard('failedOrBlocked'),
    ordinaryWork:boolGuard('ordinaryWork'),
    currentRun:boolGuard('currentRun'),
    needsRecovery:boolGuard('needsRecovery'),
    idUnused:boolGuard('idUnused'),
    noRecoveryBarrier:boolGuard('noRecoveryBarrier'),
  },
  actions:{'troubleshooter.create':{id:'troubleshooter.create'}},
  events:{'troubleshooter.reconcile':{id:'troubleshooter.reconcile'}},
});

export function dispatchTroubleshooter(facts:Readonly<Record<string,unknown>>, onCreate:()=>void):GraphDecision{
  return dispatchWorkflowGraphSync(troubleshooterV2,{
    initialState:'idle', input:{transport:'event',id:'troubleshooter.reconcile',payload:{}}, durableFacts:facts,
    isTransientState:state=>state.startsWith('check_'), maxSteps:6,
    executeAction:actionId=>{ if(actionId==='troubleshooter.create') onCreate(); else throw new Error('Unsupported troubleshooter graph action '+actionId); return {}; },
  });
}
export function decideTroubleshooter(facts:Readonly<Record<string,unknown>>):GraphDecision{ return dispatchTroubleshooter(facts,()=>{}); }
