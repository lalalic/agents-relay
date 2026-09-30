import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';

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

export function decideTroubleshooter(facts:Readonly<Record<string,unknown>>):GraphDecision{
  let current:TroubleshooterGraphState='idle';
  for(let step=0;step<6;step+=1){
    const decision=troubleshooterV2.evaluateSync({
      currentState:current,
      input:{transport:'event',id:'troubleshooter.reconcile',payload:{}},
      durableFacts:facts,
    });
    if(!decision.accepted)return decision;
    const target=decision.target as TroubleshooterGraphState;
    if(!target.startsWith('check_'))return decision;
    current=target;
  }
  return {accepted:false,source:current,reason:'no_transition'};
}
