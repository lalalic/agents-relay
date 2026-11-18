// No provider command or model API: the real Node decision path is exercised
// with a deterministic ChatGPT configured worker, fake usage and captured
// update/audit callbacks, then compared to original native Rust selection.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {redecideFailedTask} from '../../dist/model-redecision.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const usage={generatedAt:'2026-11-17T18:00:00.000Z',
 providers:[{id:'openai',label:'OpenAI',usage:{available:false}},
  {id:'zai',label:'Z.ai',usage:{available:false}}],
 credits:[]};
const evidence={classification:'model_provider_runtime',
 summary:'Real worker model path failed',sources:['task.events','worker.logs']};
const task={
 id:'73',jobId:'41',kind:'work',state:'FAILED',input:'Do fixture',
 capabilities:['coding'],attempt:1,maxAttempts:3,
 routing:{provider:'z',model:'legacy-model',decisionId:'old-decision-43'},
};
const worker={workerId:'worker-1',adapter:'chatgpt',capabilities:['coding']};
const fixtures=[];
for(const classification of ['model_provider_runtime',
 'worker_tool_infrastructure','semantic_task','timeout_unknown']){
 for(const withPrior of [true,false]){
  for(const withAudit of [true,false]){
   const f={op:'apiModelRedecision',task:structuredClone(task),
    worker,registered:[],usage,evidence:{...evidence,classification},
    nowMs:1794938400000,
    codexHome:'/tmp/rust2-model-redecision-no-home',
    policyPath:'/tmp/rust2-model-redecision-no-policy',
    rulesPath:'/tmp/rust2-model-redecision-no-rules',
    decisionMode:'off',withAudit};
   if(!withPrior)delete f.task.routing;
   fixtures.push(f);
  }
 }
}
async function node(f){
 let updated=null;
 const audits=[];
 const auditStore=f.withAudit?{append:async(record)=>{audits.push(record);}}:undefined;
 try{
  const result=await redecideFailedTask({
   task:f.task,worker:f.worker,registered:f.registered,usage:{snapshot:async()=>f.usage},
   evidence:f.evidence,
   decisionMode:f.decisionMode,
   auditStore,policyPath:f.policyPath,rulesPath:f.rulesPath,
   updateRouting:async(_task,routing)=>{updated=routing;}
  });
  return {outcome:{ok:true,value:result},updated,audits};
 }catch(error){return {outcome:{ok:false,error:error.message},updated,audits};}
}
function normalize(object){
 const value=structuredClone(object);
 for(const route of [value.updated,value.outcome.value?.routing]){
  if(route){
   if(route.decidedAt)route.decidedAt='<time>';
   if(route.decisionId)route.decisionId='<uuid>';
   if(route.decisionEvidence?.decisionId)route.decisionEvidence.decisionId='<uuid>';
  }
 }
 const all=[...value.audits];
 if(value.outcome.value?.audit)all.push(value.outcome.value.audit);
 for(const audit of all){
  if(audit.outcome_id)audit.outcome_id='<uuid>';
  if(audit.decision_id && audit.record_type==='decision')audit.decision_id='<uuid>';
  if(audit.timestamp)audit.timestamp='<time>';
 }
 return JSON.parse(JSON.stringify(value));
}
test('Node/Rust model re-decision safety, usage freshness and effect ordering',async()=>{
 const expected=[];for(const f of fixtures)expected.push(normalize(await node(f)));
 const process=spawnSync(binary,[],{cwd:root,
  input:fixtures.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:10*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const actual=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const failures=[];
 for(let i=0;i<fixtures.length;i++){
  if(!actual[i].ok){failures.push({i,adapterError:actual[i].error});continue;}
  const result=normalize(actual[i].value);
  try{assert.deepEqual(result,expected[i]);}
  catch{failures.push({i,classification:fixtures[i].evidence.classification,
     withPrior:!!fixtures[i].task.routing,withAudit:fixtures[i].withAudit,
     node:expected[i],rust:result});}
 }
 assert.deepEqual(failures,[],JSON.stringify(failures,null,2));
 console.log('Verified',fixtures.length,'direct Node/Rust model re-decision cases');
});
