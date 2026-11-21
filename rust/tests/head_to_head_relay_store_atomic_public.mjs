// Real original Node SQLiteRelayStore vs Rust SQLiteRelayStore public class.
// Independent in-memory SQLite, no live providers, no external network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const stamp='2026-11-20T00:00:00.000Z';
const job={id:'17',repository:'fixture',prNumber:0,
 projectRoot:'/tmp/rust2-relay-store-atomic-fixture',title:'Store',
 state:'ACTIVE',createdAt:stamp,updatedAt:stamp,tasks:[],plans:[],review:null};
const agent={id:'agent-z',name:'Z',capabilities:['review'],role:'worker',
 responsibility:'Fixture',endpoint:{kind:'adapter',target:'test'},
 availability:'available'};
const projection=(key,operation='save_task')=>({
 idempotencyKey:key,operation,payload:{operation,value:{id:key}},
 coalesceKey:operation==='save_task'?'task/17/2':undefined
});
const external=projection('create-pr-once','create_pull_request');
const denied=projection('external-not-allowed','save_task');
const event=n=>({key:'job/17/worker/2/'+n,
 event:{type:'task.progress',job_id:'17',task_id:'2',
 event_id:'test-event-'+n,seq:n,message:'workflow-event'}});
const E1=event(1),E2=event(2);
const scenarios=[];
for(const scope of [null,'17']){
 scenarios.push({scope,job,actions:[
  {method:'loadJob'},{method:'loadAgents'},{method:'counts'},
  {method:'saveJob'},
  {method:'saveJobWithProjection',request:{operation:'save_task',payload:{x:1}}},
  {method:'loadJob'},{method:'counts'},
  {method:'saveJobWithProjection',request:projection('write-job')},
  {method:'counts'},
  {method:'saveAgentWithProjection',agent,request:{operation:'save_agent',payload:{x:1}}},
  {method:'loadAgents'},{method:'counts'},
  {method:'saveAgentWithProjection',agent,request:projection('save-agent','save_agent')},
  {method:'loadAgents'},{method:'counts'},
  {method:'enqueueProjection',request:projection('coalesced-A')},
  {method:'enqueueProjection',request:projection('coalesced-B')},
  {method:'counts'},
  {method:'enqueueExternalActionOnce',request:denied},
  {method:'enqueueExternalActionOnce',request:external},
  {method:'enqueueExternalActionOnce',request:external},
  {method:'counts'}
 ]});
 scenarios.push({scope,job,actions:[
  {method:'saveJob'},
  {method:'commitWorkflowMutationWithEvents',version:1,events:[E1]},
  {method:'loadJob'},
  {method:'commitWorkflowMutationAndEvents',version:2,events:[E2]},
  {method:'loadJob'},
  {method:'commitWorkflowMutationAndEvents',version:3,events:[E2]},
  {method:'loadJob'},
  {method:'mutateJob',version:4},{method:'loadJob'},
  {method:'counts'}
 ]});
}
async function metric(store,action,ok,value){
 const [record,agents,pending,terminal,conflict]=await Promise.all([
  store.loadJob('17'),store.loadAgents(),
  store.pendingProjectionCount(),store.terminalProjectionCount(),
  store.conflictProjectionCount()]);
 const exists=store.db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name='workflow_event_outbox'").get();
 const workflowOutboxCount=exists?
  store.db.prepare('SELECT COUNT(*) AS n FROM workflow_event_outbox').get()?.n??0:0;
 return {method:action.method,ok,value:ok?value:null,
  jobRevision:record?.revision??null,jobPresent:record!==null,
  agentIds:agents?.map(a=>a.id)??null,
  counts:{pending,terminal,conflict},workflowOutboxCount};
}
async function original(f){
 const store=new SQLiteRelayStore(':memory:',f.scope??undefined),rows=[];
 try{
  for(const action of f.actions){
   let value=null,ok=true;
   try{
    switch(action.method){
     case 'saveJob':await store.saveJob(structuredClone(f.job));break;
     case 'saveJobWithProjection':await store.saveJobWithProjection(
      structuredClone(f.job),action.request);break;
     case 'saveAgentWithProjection':await store.saveAgentWithProjection(
      structuredClone(action.agent),action.request);break;
     case 'enqueueProjection':await store.enqueueProjection(action.request);break;
     case 'enqueueExternalActionOnce':
      value=await store.enqueueExternalActionOnce(action.request);break;
     case 'commitWorkflowMutationWithEvents':await store.commitWorkflowMutationWithEvents(
      '17',current=>({next:{...current,revision:action.version},events:action.events}));break;
     case 'commitWorkflowMutationAndEvents':await store.commitWorkflowMutationAndEvents(
      '17',current=>({...current,revision:action.version}),action.events);break;
     case 'mutateJob':await store.mutateJob('17',
      current=>({...current,revision:action.version}));break;
     case 'loadJob':value=(await store.loadJob('17'))?.revision??null;break;
     case 'loadAgents':value=(await store.loadAgents())?.map(a=>a.id)??null;break;
     case 'counts':value={pending:await store.pendingProjectionCount(),
      terminal:await store.terminalProjectionCount(),
      conflict:await store.conflictProjectionCount()};break;
     default:throw Error('Unknown Store public action');
    }
   }catch(error){ok=false;}
   rows.push(await metric(store,action,ok,value));
  }
 }finally{store.close();}
 return rows;
}
test('original Node/Rust SQLiteRelayStore atomic facade transactions, rollback and workflow callbacks',async()=>{
 const expected=[];for(const scenario of scenarios)expected.push(await original(scenario));
 const result=spawnSync(bin,[],{cwd:root,input:scenarios.map(s=>
  JSON.stringify({...s,op:'relayStoreAtomicPublic'})).join('\n')+'\n',
  encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const received=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(received.length,scenarios.length);
 const mismatches=[];
 for(let i=0;i<scenarios.length;i++){
  if(!received[i]?.ok){mismatches.push({scenario:i,error:received[i]});continue;}
  for(let j=0;j<expected[i].length;j++){
   try{assert.deepEqual(received[i].value[j],expected[i][j]);}
   catch{mismatches.push({scenario:i,step:j,action:scenarios[i].actions[j],
    node:expected[i][j],rust:received[i].value[j]});break;}
  }
 }
 assert.deepEqual(mismatches,[],JSON.stringify(mismatches.slice(0,10),null,2));
 console.log('Verified '+scenarios.length+' original Node/Rust Store class scenarios with '+
  scenarios.reduce((sum,s)=>sum+s.actions.length,0)+' atomic public operations');
});
