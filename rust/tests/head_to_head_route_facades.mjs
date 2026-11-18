// Node source: src/{worker-routing,model-routing,execution-routing}.ts.
// Compare canonical public router results against Rust, using temporary
// policy/rules files, deterministic candidates and no decision engine/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {routeWorker} from '../../dist/worker-routing.js';
import {routeModel} from '../../dist/model-routing.js';
import {routeExecution} from '../../dist/execution-routing.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-router-facade-'));
test.after(()=>rmSync(tmp,{force:true,recursive:true}));
const policyPath=join(tmp,'no-policy.json'),rulesPath=join(tmp,'no-rules.md');
// Node and Rust discover the same empty, sandboxed Codex profile home.
process.env.CODEX_HOME=tmp;
let seed=0x18743;function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
function pick(xs){return xs[rand()%xs.length];}
const workers=[
 {workerId:'codex',adapter:'codex',runtime:'codex',capabilities:['model','codex','coding','filesystem'],availability:'available'},
 {workerId:'chatgpt',adapter:'chatgpt',runtime:'chatgpt',capabilities:['model','chatgpt'],availability:'available'},
 {workerId:'z',adapter:'z',runtime:'z',capabilities:['model','z'],availability:'available'},
];
const models=[
 {id:'default:openai/a',provider:'openai',model:'a',profile:'openai',reasoning:'high'},
 {id:'default:openai/b',provider:'openai',model:'b',profile:'openai',reasoning:'low'},
 {id:'default:z/c',provider:'z',model:'c',reasoning:'low'},
];
const fixtures=[];
for(let i=0;i<60;i++){
 const candidates=Array.from({length:1+rand()%3},(_,n)=>({...workers[n],resourceHealthy:pick([true,true,true,false])}));
 const requirements=pick([{}, {runtime:'codex'}, {runtime:'chatgpt'}, {capabilities:['coding']}, {capabilities:['model']}, {runtime:'invalid'}]);
 fixtures.push({op:'routeFacade',kind:'worker',candidates,requirements,options:{rulesPath,decisionMode:'off'},policyPath,rulesPath,home:tmp,nowMs:Date.now()});
}
for(let i=0;i<30;i++){
 const candidates=Array.from({length:1+rand()%3},(_,n)=>models[n]);
 const worker=pick(workers);
 const constraints=pick([{}, {provider:'openai'}, {model:'missing'}, {reasoning:'high'}]);
 fixtures.push({op:'routeFacade',kind:'model',worker,candidates,requirements:{},options:{policyPath,rulesPath,decisionMode:'off',constraints},policyPath,rulesPath,home:tmp,nowMs:Date.now()});
}
for(let i=0;i<15;i++){
 const candidates=workers.slice(0,1+rand()%3);
 const requirements=pick([{}, {runtime:'codex'},{capabilities:['nonexistent']}]);
 fixtures.push({op:'routeFacade',kind:'execution',candidates,requirements,options:{policyPath,rulesPath,decisionMode:'off',registered:[],routingConstraints:{}},policyPath,rulesPath,home:tmp,nowMs:Date.now()});
}
function normalize(value){
 const result=JSON.parse(JSON.stringify(value));
 if(!result||typeof result!=='object')return result;
 for(const route of [result.routing,result.candidate?.routing]){
  if(route?.decidedAt!==undefined)route.decidedAt='NORMALIZED';
  if(route&&'decisionId' in route)delete route.decisionId;
 }
 if(result.selection?.selectedAt)result.selection.selectedAt='NORMALIZED';
 if('audit' in result)result.audit=null;
 return result;
}
async function original(f){
 try{
  let value;
  if(f.kind==='worker')value=await routeWorker(f.candidates,f.requirements,f.options);
  else if(f.kind==='model')value=await routeModel(f.worker,f.candidates,f.options);
  else value=await routeExecution(f.candidates,f.requirements,f.options);
  return {ok:true,value:normalize(value)};
 }catch(e){return {ok:false,error:e.message};}
}
test('public routeWorker, routeModel, and routeExecution use same hard gates and deterministic fallback as Rust',async()=>{
 const expected=[];for(const f of fixtures)expected.push(await original(f));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
  input:fixtures.map(JSON.stringify).join('\n')+'\n',maxBuffer:12*1024*1024,timeout:120000});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const mismatches=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:{outcome:expected[i]}});}
  catch{mismatches.push({index:i,fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatches.slice(0,6),[],`${mismatches.length} mismatches out of ${fixtures.length} authoritative Node API cases`);
 console.log(`Validated ${fixtures.length} Node/Rust public Worker/Model/Execution route fixtures`);
});
