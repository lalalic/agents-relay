import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision, type ActionReceipt } from './graph-v2.js';
import { dispatchWorkflowGraph, dispatchWorkflowGraphSync } from './dispatcher.js';

export type AuthoritativeUnblockState = 'blocked' | 'troubleshooter_queued';

const source=readFileSync(new URL('../../workflow/authoritative-unblock.mmd',import.meta.url),'utf8');
const boolGuard=(name:string)=>(facts:{readonly durableFacts:Readonly<Record<string,unknown>>})=>facts.durableFacts[name]===true;

export const authoritativeUnblockV2=new GraphRuntime(source,{
  states:new Set<AuthoritativeUnblockState>(['blocked','troubleshooter_queued']),
  guards:{blockedTroubleshooter:boolGuard('blockedTroubleshooter')},
  actions:{
    'unblock.retry':{id:'unblock.retry'},
  },
  events:{'task.authoritative_unblock':{id:'task.authoritative_unblock'}},
});

export async function dispatchAuthoritativeUnblock(blockedTroubleshooter:boolean, executeAction?:(actionId:string)=>ActionReceipt|Promise<ActionReceipt>):Promise<GraphDecision>{
  return dispatchWorkflowGraph(authoritativeUnblockV2,{initialState:'blocked',input:{transport:'event',id:'task.authoritative_unblock',payload:{}},graphName:'authoritative-unblock',durableFacts:{blockedTroubleshooter},executeAction});
}
export function decideAuthoritativeUnblock(blockedTroubleshooter:boolean):GraphDecision{
  return dispatchWorkflowGraphSync(authoritativeUnblockV2,{initialState:'blocked',input:{transport:'event',id:'task.authoritative_unblock',payload:{}},graphName:'authoritative-unblock',durableFacts:{blockedTroubleshooter}});
}
