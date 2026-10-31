import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { browserPoolGraph, requirePoolDecision, monitorPoolDecision, progressPoolDecision } from '../dist/browser-worker-pool-graph.js';

const event=(state,id,providerHealthy=true,recoveryDue=false)=>browserPoolGraph.evaluateSync({
  currentState:state,input:{transport:'event',id,payload:{}},durableFacts:{providerHealthy,recoveryDue},
});
test('L1 browser pool graph has executable branches for queue, admission, circuit and terminal release',()=>{
  const cases=[
    ['AVAILABLE','pool.claim',true,'LEASED','pool.assign'],
    ['AVAILABLE','pool.claim',false,'AVAILABLE','pool.reject'],
    ['AVAILABLE','pool.enqueue',true,'WAITING','pool.enqueue'],
    ['WAITING','pool.claim',true,'LEASED','pool.assign'],
    ['WAITING','pool.claim',false,'WAITING','pool.reject'],
    ['WAITING','pool.expired',true,'AVAILABLE','pool.dequeue'],
    ['WAITING','pool.cancel',true,'AVAILABLE','pool.dequeue'],
    ['WAITING','pool.unavailable',true,'AVAILABLE','pool.dequeue'],
    ['LEASED','pool.sessionBound',true,'LEASED','pool.bindSession'],
    ['LEASED','pool.threadBound',true,'LEASED','pool.bindThread'],
    ['LEASED','pool.activity',true,'LEASED','pool.touch'],
    ['LEASED','pool.terminalVerified',true,'AVAILABLE','pool.release'],
    ['LEASED','pool.outcomeUnknown',true,'QUARANTINED','pool.quarantine'],
    ['QUARANTINED','pool.outcomeUnknown',true,'QUARANTINED','pool.keepQuarantine'],
    ['QUARANTINED','pool.stopVerified',true,'AVAILABLE','pool.releaseQuarantine'],
  ];
  for(const [state,id,healthy,target,action] of cases){
    const result=event(state,id,healthy);
    assert.equal(result.accepted,true,`${state}/${id}`);
    assert.equal(result.target,target,`${state}/${id}`);
    assert.equal(result.actions[0].id,action);
  }
  for(const [state,id] of [['LEASED','pool.claim'],['QUARANTINED','pool.terminalVerified'],['AVAILABLE','pool.terminalVerified']]){
    assert.equal(event(state,id).accepted,false,`${state}/${id}`);
  }
});
test('L1 browser pool monitoring graph selects recovery only when due',()=>{
  assert.equal(monitorPoolDecision(false),'keepMonitoring');
  assert.equal(monitorPoolDecision(true),'recoverTurn');
  assert.equal(event('LEASED','pool.poll',true,true).actions[0].id,'pool.recoverTurn');
  assert.equal(event('LEASED','pool.poll',true,false).actions[0].id,'pool.keepMonitoring');
  assert.throws(()=>requirePoolDecision('QUARANTINED','pool.claim','assign'),/rejected/);
});

test('L1 timeout extension is Graph-gated by independently observed fresh worker output',()=>{
  assert.equal(progressPoolDecision(true),'extendTimeout');
  assert.equal(progressPoolDecision(false),'keepMonitoring');
  assert.equal(event('LEASED','pool.progressObserved',true,false).actions[0].id,'pool.keepMonitoring');
  const a=browserPoolGraph.evaluateSync({currentState:'LEASED',input:{transport:'event',id:'pool.progressObserved',payload:null},durableFacts:{freshOutput:true}});
  assert.equal(a.actions[0].id,'pool.extendTimeout');
});
