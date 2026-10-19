import test from 'node:test';
import assert from 'node:assert/strict';
import {evidenceGate} from './evidence-matrix.mjs';
const make=category=>({id:'gate-check',category,expectedTrace:[],expectedTerminal:'COMPLETED'});
test('untrusted caller flags cannot fabricate L1, L2, or L3 success',async()=>{
 const forged={actualTerminal:'COMPLETED',productionPath:true,graphTransitions:true,schedulerTransitions:true,sqlitePredicates:true,realProvider:true,realAdapter:true,acceptedByRelay:true,contractAssertions:true};
 for(const category of ['L1','L2','L3'])assert.equal((await evidenceGate(make(category),forged)).outcome,'NOT_RUN');
});
test('L3 mismatched fixture ID is rejected',async()=>{
 assert.equal((await evidenceGate(make('L3'),{fixture:{id:'wrong'}})).outcome,'FAIL');
});
test('real isolated SQLite replay cannot pass a forged completed objective',async()=>{
 const scenario={...make('L3'),id:'impossible-objective'};
 const fixture={id:'impossible-objective',category:'L3',executionMode:'autonomous',steps:[{type:'task.completed'},{type:'reconcile'}],expected:{jobState:'ACTIVE',tasks:{a:'SUCCEEDED',b:'RUNNING'}}};
 const result=await evidenceGate(scenario,{fixture});
 assert.equal(result.outcome,'FAIL');
 assert.notEqual(result.actualTerminal,'COMPLETED');
});
