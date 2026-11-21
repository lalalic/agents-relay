// Original Node src/relay-store.ts SQLiteRelayStore vs native Rust on
// independent in-memory SQLite connections; no live jobs or providers.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const a={id:'agent-z',name:'Agent Z',capabilities:['model']};
const b={id:'agent-a',name:'Agent A',capabilities:['review']};
const cases=[];
for(const scope of [undefined,'17']){
 const seedJob=scope?{
  id:'17',repository:'fixture',prNumber:0,projectRoot:'/tmp/rust2-agent-fixture',
  title:'Scoped Agent registry',state:'ACTIVE',tasks:[],plans:[],
  createdAt:'2026-11-20T00:00:00.000Z',
  updatedAt:'2026-11-20T00:00:00.000Z'
 }:undefined;
 const facts=(state,observedAt,head)=>({state,observedAt,head});
 cases.push({scope,seedJob,actions:[
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('OPEN','2026-11-01T00:00:00.000Z',null)},
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('UNKNOWN','2026-11-02T00:00:00.000Z',null)},
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('OPEN','2026-11-03T00:00:00.000Z',
   {ref:'refs/heads/master',sha:'a'.repeat(40)})},
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('CLOSED','2026-11-02T00:00:00.000Z',null)},
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('MERGED','2026-11-04T00:00:00.000Z',null)},
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('CLOSED','2026-11-05T00:00:00.000Z',null)},
  {method:'loadFacts'},
  {method:'saveFacts',facts:facts('MERGED','2026-11-06T00:00:00.000Z',
   {ref:'',sha:'b'.repeat(40)})},
  {method:'loadFacts'},
 ]});
 cases.push({scope,seedJob,actions:[{method:'load'},{method:'save',agents:[]},{method:'load'},{method:'save',agents:[]},{method:'load'}]});
 cases.push({scope,seedJob,actions:[{method:'load'},{method:'upsert',agent:a},{method:'load'},
  {method:'save',agents:[]},{method:'load'},{method:'upsert',agent:b},{method:'load'}]});
 cases.push({scope,seedJob,actions:[
  {method:'save',agents:[a,b]},{method:'load'},
  {method:'save',agents:[a,a]},{method:'load'},
  {method:'save',agents:[]},{method:'load'},
 ]});
 if(scope)cases.push({scope,actions:[
  {method:'load'},{method:'save',agents:[]},{method:'load'},
  {method:'upsert',agent:a},{method:'load'}
 ]});
 cases.push({scope,seedJob,actions:[{method:'save',agents:[a,b]},{method:'load'},
  {method:'save',agents:[{...b,name:'Updated B'}]},{method:'load'},
  {method:'upsert',agent:{...b,name:'Again B'}},{method:'load'},
  {method:'markEvent',eventId:'receipt-1',stream:'nats',sequence:7},
  {method:'markEvent',eventId:'receipt-1',stream:'nats',sequence:7},
  {method:'markEvent',eventId:'receipt-2',stream:null,sequence:null},
 ]});
}
async function original(fixture){
 const store=new SQLiteRelayStore(':memory:',fixture.scope);
 if(fixture.seedJob)await store.saveJob(fixture.seedJob);
 const outcomes=[];
 try{
  for(const action of fixture.actions){
   try{
    let value;
    switch(action.method){
     case 'load': value=await store.loadAgents(); break;
     case 'save': value=await store.saveAgents(action.agents); break;
     case 'upsert': value=await store.upsertAgent(action.agent); break;
     case 'markEvent': value=await store.markEventProcessed(action.eventId,action.stream,action.sequence); break;
     case 'loadFacts': value=await store.loadPullRequestFacts(); break;
     case 'saveFacts': value=await store.savePullRequestFacts(action.facts); break;
    }
    outcomes.push({ok:true,value:value===undefined?null:value});
   }catch(error){outcomes.push({ok:false,error:error.message});}
  }
 }finally{store.close();}
 return outcomes;
}
test('original Node and Rust SQLite agent registry observed-empty, replacement, dedupe, scoped events',async()=>{
 const expected=[];for(const fixture of cases)expected.push(await original(fixture));
 const run=spawnSync(binary,[],{cwd:root,input:cases.map(f=>JSON.stringify({
  op:'relayStoreAgentRegistryParity',...f
 })).join('\n')+'\n',encoding:'utf8',timeout:60000});
 assert.equal(run.status,0,run.stderr);
 const values=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(values.length,cases.length);
 for(let i=0;i<cases.length;i++){
  assert.equal(values[i].ok,true,JSON.stringify(values[i]));
  assert.deepEqual(values[i].value,expected[i],'case '+i+' scope '+(cases[i].scope??'legacy'));
 }
 console.log('Verified '+cases.length+' direct Node/Rust Agent Store scenarios and '+cases.reduce((n,c)=>n+c.actions.length,0)+' operations');
});
