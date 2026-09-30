import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';

export type ScheduledRunGraphState =
  | 'idle' | 'check_unclaimed' | 'check_job' | 'check_active' | 'check_concurrency'
  | 'check_queue' | 'check_missed' | 'skip_idempotent' | 'skip_active' | 'claimed';

const source=readFileSync(new URL('../../workflow/scheduled-run-v2.mmd',import.meta.url),'utf8');
const boolGuard=(name:string)=>(facts:{readonly durableFacts:Readonly<Record<string,unknown>>})=>facts.durableFacts[name]===true;

export const scheduledRunV2=new GraphRuntime(source,{
  states:new Set<ScheduledRunGraphState>([
    'idle','check_unclaimed','check_job','check_active','check_concurrency',
    'check_queue','check_missed','skip_idempotent','skip_active','claimed',
  ]),
  guards:{
    slotDue:boolGuard('slotDue'),
    slotUnclaimed:boolGuard('slotUnclaimed'),
    jobActive:boolGuard('jobActive'),
    hasActiveTasks:boolGuard('hasActiveTasks'),
    concurrencySkip:boolGuard('concurrencySkip'),
    concurrencyQueue:boolGuard('concurrencyQueue'),
    runMissed:boolGuard('runMissed'),
  },
  actions:Object.fromEntries([
    'schedule.skipActiveAdvance','schedule.claimFromSlot','schedule.claimFromNow',
  ].map(id=>[id,{id}])),
  events:{'schedule.tick':{id:'schedule.tick'}},
});

export function decideScheduledRun(facts:Readonly<Record<string,unknown>>):GraphDecision{
  let current:ScheduledRunGraphState='idle';
  for(let step=0;step<8;step+=1){
    const decision=scheduledRunV2.evaluateSync({
      currentState:current,
      input:{transport:'event',id:'schedule.tick',payload:{}},
      durableFacts:facts,
    });
    if(!decision.accepted)return decision;
    const target=decision.target as ScheduledRunGraphState;
    if(!target.startsWith('check_'))return decision;
    current=target;
  }
  return {accepted:false,source:current,reason:'no_transition'};
}
