import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';

export type ScheduledRunGraphState =
  | 'idle' | 'check_unclaimed' | 'check_job' | 'check_active' | 'check_concurrency'
  | 'check_queue' | 'check_missed' | 'skip_idempotent' | 'skip_active' | 'claimed';

const source=readFileSync(new URL('../../workflow/scheduled-run.mmd',import.meta.url),'utf8');
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

export async function dispatchScheduledRun(facts:Readonly<Record<string,unknown>>, executeAction?:(actionId:string)=>ActionReceipt|Promise<ActionReceipt>):Promise<GraphDecision>{
  return dispatchWorkflowGraph(scheduledRunV2,{initialState:'idle',input:{transport:'event',id:'schedule.tick',payload:{}},durableFacts:facts,isTransientState:state=>state.startsWith('check_'),maxSteps:8,executeAction});
}
export function decideScheduledRun(facts:Readonly<Record<string,unknown>>):GraphDecision{
  return dispatchWorkflowGraphSync(scheduledRunV2,{initialState:'idle',input:{transport:'event',id:'schedule.tick',payload:{}},durableFacts:facts,isTransientState:state=>state.startsWith('check_'),maxSteps:8});
}
