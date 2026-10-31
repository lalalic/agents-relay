import { readFileSync } from 'node:fs';
import { GraphRuntime, type GraphDecision } from './workflow/graph-v2.js';
import { dispatchWorkflowGraphSync } from './workflow/dispatcher.js';

export type PoolGraphState = 'AVAILABLE' | 'WAITING' | 'LEASED' | 'QUARANTINED';
export type PoolGraphEvent =
  | 'pool.claim' | 'pool.enqueue' | 'pool.expired' | 'pool.cancel' | 'pool.unavailable'
  | 'pool.sessionBound' | 'pool.threadBound' | 'pool.activity'
  | 'pool.terminalVerified' | 'pool.outcomeUnknown' | 'pool.stopVerified' | 'pool.poll' | 'pool.progressObserved';

const actions = ['assign','reject','enqueue','dequeue','bindSession','bindThread','touch','release','quarantine','releaseQuarantine','keepQuarantine','recoverTurn','keepMonitoring','extendTimeout'];
const events: PoolGraphEvent[] = [
  'pool.claim','pool.enqueue','pool.expired','pool.cancel','pool.unavailable','pool.sessionBound',
  'pool.threadBound','pool.activity','pool.terminalVerified','pool.outcomeUnknown','pool.stopVerified','pool.poll','pool.progressObserved',
];
export const browserPoolGraph = new GraphRuntime(
  readFileSync(new URL('../workflow/browser-worker-pool.mmd', import.meta.url),'utf8'),
  {
    states: new Set<PoolGraphState>(['AVAILABLE','WAITING','LEASED','QUARANTINED']),
    guards: {providerHealthy: facts => facts.durableFacts.providerHealthy === true, recoveryDue: facts => facts.durableFacts.recoveryDue === true, freshOutput: facts => facts.durableFacts.freshOutput === true},
    actions: Object.fromEntries(actions.map(name => [`pool.${name}`,{id:`pool.${name}`}])) ,
    events: Object.fromEntries(events.map(name => [name,{id:name}])),
  },
);
/** Graph owns permission and the effect selected; SQLite executes the effect atomically. */
export function requirePoolDecision(
  state: PoolGraphState,event: PoolGraphEvent,expectedAction: string,providerHealthy = true,
):GraphDecision & {accepted:true} {
  const decision = dispatchWorkflowGraphSync(browserPoolGraph,{initialState:state,input:{transport:'event',id:event,payload:null},durableFacts:{providerHealthy},graphName:'browser-worker-pool'});
  if (!decision.accepted || decision.actions.length !== 1 || decision.actions[0].id !== `pool.${expectedAction}`)
    throw new Error(`Browser Pool Graph rejected ${state}/${event}: expected pool.${expectedAction}`);
  return decision;
}

/** The executable Graph selects the next monitoring action; no browser heartbeat counts as task progress. */
export function monitorPoolDecision(recoveryDue:boolean): 'recoverTurn' | 'keepMonitoring' {
  const decision=dispatchWorkflowGraphSync(browserPoolGraph,{initialState:'LEASED',input:{transport:'event',id:'pool.poll',payload:null},durableFacts:{recoveryDue},graphName:'browser-worker-pool'});
  if (!decision.accepted || decision.target!=='LEASED' || decision.actions.length!==1)throw Error('Invalid Pool monitoring graph');
  const id=decision.actions[0].id;
  if (id==='pool.recoverTurn')return 'recoverTurn';
  if (id==='pool.keepMonitoring')return 'keepMonitoring';
  throw Error(`Unknown Pool monitoring action ${id}`);
}

/** Only verified new assistant output can extend Relay's inactivity deadline. */
export function progressPoolDecision(freshOutput:boolean): 'extendTimeout' | 'keepMonitoring' {
  const decision=dispatchWorkflowGraphSync(browserPoolGraph,{initialState:'LEASED',input:{transport:'event',id:'pool.progressObserved',payload:null},durableFacts:{freshOutput},graphName:'browser-worker-pool'});
  if (!decision.accepted || decision.target!=='LEASED' || decision.actions.length!==1)throw Error('Invalid Pool progress graph');
  const id=decision.actions[0].id;
  if(id==='pool.extendTimeout')return 'extendTimeout';
  if(id==='pool.keepMonitoring')return 'keepMonitoring';
  throw Error(`Unknown Pool progress action ${id}`);
}
