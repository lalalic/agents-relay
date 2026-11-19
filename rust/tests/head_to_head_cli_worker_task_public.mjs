// Three original Node CLI Worker Task exports against canonical native Graph,
// using completely independent per-fixture SQLite stores and deterministic input.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';import {resolve,join} from 'node:path';
import * as source from '../../dist/cli-worker-task.js';
const root=resolve(import.meta.dirname,'../..'),binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join(tmpdir(),'rust2-cli-worker-task-'));
test.after(()=>rmSync(temp,{recursive:true,force:true}));
const at='2026-11-18T20:00:00.000Z';
const job=()=>({id:'17',repository:'fixture',title:'Fixture',priority:'P2',state:'ACTIVE',projectRoot:'/tmp/fixture',
  prNumber:0,createdAt:at,updatedAt:at,tasks:[],plans:[]});
const cases=[];const add=(action,args,dependencies=[])=>cases.push({op:'certCliWorkerTask',action,args,dependencies,job:job(),now:at});
for(const kind of ['','adapter_failure','model_failure','provider_failure','task_failure','unknown','incorrect']){
 const args=kind?['--failure-kind',kind]:[];
 add('diagnosis',args);
 add('diagnosis',[...args,'--reason','route failure','--evidence','actual process','--reroute','--exclude-current-route']);
}
for(const raw of [null,'{','{}','null','[]','{"mode":"all"}','{"mode":"strict","dependencies":[]}','{"kind":"commit","required":true}', '[1]']){
 const args=raw===null?[]:['--dependency-validity',raw];
 add('validity',args,['2','3']);
}
const base=['--input','Do actual work','--output','file','--output-path','/tmp/rust2-test-result.json'];
for(const extra of [[],['--adapter','chatgpt'],['--adapter','z'],['--adapter','orchestrator'],
 ['--adapter','codex','--story-size','S'],['--story-size','L','--priority','P0'],
 ['--model','gpt-6','--provider','openai','--reasoning','high'],
 ['--adapter','chatgpt','--model','gpt-6','--chatgpt-tab-close-policy','after-terminal'],
 ['--title','New Task','--agent','implementation','--project','demo'],
 ['--draft'],['--task-id','27'],['--deps','2,3'],['--timeout','0'],
 ['--output','local-git'],['--output','wrong'],['--story-size','INVALID'],
 ['--priority','P9'],['--model','gpt-6','--profile','x'],
 ['--provider','z'],['--input',''],['--agent-graph','invalid Mermaid']]){
 add('create',[...base,...extra]);
}
for(let i=0;i<cases.length;i++){
 if(cases[i].action==='create'){
  const dirNode=join(temp,'node-'+i,'stores'),dirRust=join(temp,'rust-'+i,'stores');
  mkdirSync(dirNode,{recursive:true});mkdirSync(dirRust,{recursive:true});
  cases[i].storeDirNode=dirNode;cases[i].storeDirRust=dirRust;
 }
}
function clean(v){return JSON.parse(JSON.stringify(v,(key,value)=>
  key==='updatedAt' && typeof value==='string'&&/^20\d\d-/.test(value)?'<clock>':value));}
async function node(q){
 try{let value;
  if(q.action==='diagnosis')value=source.recoveryDiagnosisFromArgs(q.args);
  else if(q.action==='validity')value=source.dependencyValidityFromArgs(q.args,q.dependencies);
  else value=await source.workerTaskFromArgs(q.job,[...q.args,'--store-dir',q.storeDirNode],q.now);
  return {ok:true,value:clean(value??null)};
 }catch(error){return {ok:false,error:error.message}}
}
function rust(q){
 const req={...q,storeDir:q.storeDirRust};
 if(q.action==='create')req.args=[...q.args,'--store-dir',q.storeDirRust];
 const p=spawnSync(binary,[],{cwd:root,input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:18000});
 assert.equal(p.status,0,p.stderr);
 const result=JSON.parse(p.stdout.trim());if(result.ok)result.value=clean(result.value);return result;
}
test('Node/Rust public CLI Worker Task diagnosis, dependency validity and Graph create parity',async()=>{
 for(let i=0;i<cases.length;i++){
  const expected=await node(cases[i]),actual=rust(cases[i]);
  assert.deepEqual(actual,expected,`Fixture ${i}: ${JSON.stringify(cases[i].args)}\nactual=${JSON.stringify(actual)}\nexpected=${JSON.stringify(expected)}`);
 }
 console.log(`PASS ${cases.length} original Node/Rust worker CLI public API fixtures`);
});
