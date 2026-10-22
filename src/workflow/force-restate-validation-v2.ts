import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';
import { dispatchWorkflowGraphSync } from './dispatcher.js';
const source=readFileSync(new URL('../../workflow/force-restate-validation.mmd',import.meta.url),'utf8');
export const forceRestateValidationV2=new GraphRuntime(source,{
 states:new Set(['idle','check_completed','check_runnable','check_blocked','accepted','blocked','rejected']),
 guards:{authoritativeCompleted:f=>f.durableFacts.authoritativeCompleted===true,runnableWork:f=>f.durableFacts.runnableWork===true,verifiedTroubleshooterBlock:f=>f.durableFacts.verifiedTroubleshooterBlock===true},
 actions:{'forceRestate.rejectPlan':{id:'forceRestate.rejectPlan'}},events:{'forceRestate.validate':{id:'forceRestate.validate'}},
});
export function decideForceRestateValidation(facts:Readonly<Record<string,unknown>>):GraphDecision{return dispatchWorkflowGraphSync(forceRestateValidationV2,{initialState:'idle',input:{transport:'event',id:'forceRestate.validate',payload:{}},durableFacts:facts,graphName:'force-restate-validation',isTransientState:state=>state.startsWith('check_'),maxSteps:10});}
