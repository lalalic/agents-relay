// Direct DAG completion error port, including negative file I/O.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const {dagCompletionError}=await import('../dist/dag-result-contract.js');
const bin=resolve('rust/target/debug/relay-rust2-parity');
const root=mkdtempSync(join(tmpdir(),'rust2-wave3-dag-'));
let total=0;
const rust=task=>{
 const p=spawnSync(bin,[],{input:JSON.stringify({op:'deliveryWave2',case:'dagResult',task})+'\n',
  encoding:'utf8',timeout:30000,env:{...process.env,AGENTS_RELAY_STORE_DIR:join(root,'store')}});
 assert.equal(p.status,0,p.stderr);
 const value=JSON.parse(p.stdout);
 if(!value.ok)throw new Error(value.error);
 return value.value;
};
let seed=0x48d1929;
const rnd=()=>{seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0};
try{
 for(let i=0;i<90;i++){
   const task={dagNode:{nodeId:'fixture'},output:{kind:'file',path:join(root,'missing-'+rnd())}};
   const n=await dagCompletionError(task);
   const r=rust(task);
   assert.equal(r,n,'missing file '+i);total++;
 }
 for(const contents of [
   '{}','null','[]','"text"','42','{"status":"FAILED","output":{},"artifacts":[]}',
   '{"status":"COMPLETED","output":[],"artifacts":[]}',
   '{"status":"COMPLETED","output":{},"artifacts":null}',
   '{"status":"COMPLETED","output":{},"artifacts":[1]}',
   '{"status":"COMPLETED","output":{},"artifacts":[]}',
   '{"status":"COMPLETED","output":{},"artifacts":{"readme":"doc"}}'
 ]){
   const target=join(root,'result-'+total+'.json');writeFileSync(target,contents);
   const task={dagNode:{nodeId:'fixture'},output:{kind:'file',path:target}};
   const n=await dagCompletionError(task);
   const r=rust(task);
   assert.deepEqual(r,n,'fixture '+contents);total++;
 }
 for(const task of [
   {dagNode:null},{dagNode:{},output:{kind:'task_pr'}},
   {dagNode:false,output:{kind:'file',path:'not-here'}},
   {dagNode:{},output:{kind:'file',path:join(root,'missing')}},
 ]){
   const n=await dagCompletionError(task),r=rust(task);
   assert.equal(r,n);total++;
 }
 console.log('PASS Rust2 Wave3 DAG Node/Rust negative filesystem differential '+total);
}finally{rmSync(root,{recursive:true,force:true});}
