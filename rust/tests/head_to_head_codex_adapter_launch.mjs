// Original Node and native Rust public CodexAdapter.launch using only a
// disposable synthetic executable. Never invoke a real Codex CLI/provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,chmodSync,rmSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexAdapter} from '../../dist/adapters.js';

const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const fixtureRoot=mkdtempSync(join(tmpdir(),'rust2-adapter-launch-'));
test.after(()=>rmSync(fixtureRoot,{recursive:true,force:true}));

const cases=[
 {name:'success with thread',out:['{"type":"thread.started","thread_id":"fixture-thread"}'],status:0},
 {name:'success without thread',out:['Not JSON'],status:0},
 {name:'success without trailing newline',out:['{"type":"thread.started","thread_id":"terminal-buffer"}'],status:0,noNewline:true},
 {name:'success multiple thread observations',out:['{"type":"thread.started","thread_id":"thread-A"}','{"type":"thread.started","thread_id":"thread-B"}'],status:0},
 {name:'structured failure priority',out:['{"type":"error","message":"minor"}','{"type":"turn.failed","error":{"message":"clear failure"}}'],status:23},
 {name:'stderr fallback',out:['invalid stdout'],err:'  plain failure  ',status:26},
 {name:'generic nonzero exit',out:['garbage'],status:19},
 {name:'structured failure uses last same-priority',out:['{"type":"turn.failed","error":{"message":"first"}}','{"type":"turn.failed","error":{"message":"second"}}'],status:20}
];

function quote(text){return "'" + String(text).replaceAll("'","'\\''") + "'";}
function fixture(c,i){
 const file=join(fixtureRoot,'mock-'+i+'.sh');
 let body='#!/bin/sh\n';
 for(let n=0;n<c.out.length;n++){
  const ending=n<c.out.length-1||!c.noNewline?'\\n':'';
  body+="printf '%s"+ending+"' "+quote(c.out[n])+'\n';
 }
 if(c.err)body+="printf '%s\\n' "+quote(c.err)+' >&2\n';
 body+='exit '+c.status+'\n';
 writeFileSync(file,body,{mode:0o700});chmodSync(file,0o700);
 return file;
}
async function original(file,task){
 try{
  const execution=new CodexAdapter(file).launch(task,new AbortController().signal);
  await execution.launched;
  const result=await execution.promise;
  return {ok:true,threadId:execution.threadId??null,result,
   processExit:execution.processExit?{
    exitCode:execution.processExit.exitCode,signal:execution.processExit.signal,
    stderr:execution.processExit.stderr,
    terminationReason:execution.processExit.terminationReason
   }:null};
 }catch(error){return {ok:false,error:error.message};}
}
function native(file,task){
 const run=spawnSync(bin,[],{cwd:root,input:JSON.stringify({
  op:'certAdaptersPublic',method:'codexLaunch',command:file,task,context:{}
 })+'\n',encoding:'utf8',timeout:20000});
 assert.equal(run.status,0,run.stderr);
 const outer=JSON.parse(run.stdout.trim());
 assert.equal(outer.ok,true,JSON.stringify(outer));
 return outer.value;
}
test('original Node/Rust CodexAdapter.launch owned fake-process parity',async()=>{
 for(let i=0;i<cases.length;i++){
  const c=cases[i],path=fixture(c,i);
  const task={id:'17',jobId:'9',input:'fake prompt',routing:{
   provider:'fixture',model:'fixture-model',cwd:fixtureRoot},
   state:'QUEUED',attempt:1,maxAttempts:1};
  const expected=await original(path,task);
  const actual=native(path,task);
  assert.deepEqual(actual,expected, i+': '+c.name);
 }
});
