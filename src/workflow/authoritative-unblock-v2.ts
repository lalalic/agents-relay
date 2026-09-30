import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './graph-v2.js';

export type AuthoritativeUnblockState = 'blocked' | 'autonomous_replan' | 'fixed_retry';

const source=readFileSync(new URL('../../workflow/authoritative-unblock-v2.mmd',import.meta.url),'utf8');
const boolGuard=(name:string)=>(facts:{readonly durableFacts:Readonly<Record<string,unknown>>})=>facts.durableFacts[name]===true;

export const authoritativeUnblockV2=new GraphRuntime(source,{
  states:new Set<AuthoritativeUnblockState>(['blocked','autonomous_replan','fixed_retry']),
  guards:{autonomousJob:boolGuard('autonomousJob')},
  actions:{
    'unblock.replan':{id:'unblock.replan'},
    'unblock.retry':{id:'unblock.retry'},
  },
  events:{'task.authoritative_unblock':{id:'task.authoritative_unblock'}},
});

export function decideAuthoritativeUnblock(autonomousJob:boolean):GraphDecision{
  return authoritativeUnblockV2.evaluateSync({
    currentState:'blocked',
    input:{transport:'event',id:'task.authoritative_unblock',payload:{}},
    durableFacts:{autonomousJob},
  });
}
