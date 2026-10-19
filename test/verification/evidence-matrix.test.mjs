import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceGate} from './evidence-matrix.mjs';
const make=category=>({id:'gate-check',category,expectedTrace:[],expectedTerminal:'COMPLETED'});
test('L2 refuses PASS from mock provider or unmatched Relay ingress',()=>{
 const simulated={actualTerminal:'COMPLETED',productionPath:true,realProvider:false,realAdapter:true,acceptedByRelay:true};
 assert.equal(evidenceGate(make('L2'),simulated).outcome,'NOT_RUN');
 assert.equal(evidenceGate(make('L2'),{...simulated,realProvider:true,acceptedByRelay:false}).outcome,'NOT_RUN');
 assert.equal(evidenceGate(make('L2'),{...simulated,realProvider:true}).outcome,'PASS');
});
test('L3 requires causal Graph, Scheduler, SQLite predicates and authoritative terminal',()=>{
 const evidence={productionPath:true,actualTerminal:'COMPLETED',graphTransitions:true,schedulerTransitions:true,sqlitePredicates:false};
 assert.equal(evidenceGate(make('L3'),evidence).outcome,'NOT_RUN');
 assert.equal(evidenceGate(make('L3'),{...evidence,sqlitePredicates:true}).outcome,'PASS');
 assert.equal(evidenceGate(make('L3'),{...evidence,sqlitePredicates:true,actualTerminal:'BLOCKED'}).outcome,'FAIL');
});
test('L1 requires executed contract checks',()=>{
 assert.equal(evidenceGate(make('L1'),{productionPath:true,actualTerminal:'COMPLETED'}).outcome,'NOT_RUN');
 assert.equal(evidenceGate(make('L1'),{productionPath:true,actualTerminal:'COMPLETED',contractAssertions:true}).outcome,'PASS');
});
