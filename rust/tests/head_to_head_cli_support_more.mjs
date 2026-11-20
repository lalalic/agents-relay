// Direct ORIGINAL CLI support remaining filesystem/number APIs against Rust.
// Uses two caller-owned files; never opens a production database or server.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {textOption,saveLocal} from '../../dist/cli-support.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join(tmpdir(),'rust2-cli-support-more-'));
test.after(()=>rmSync(temp,{force:true,recursive:true}));
const textFile=join(temp,'args-text.txt');
writeFileSync(textFile,'中文 - accent é - emoji 🍀\n','utf8');
const absent=join(temp,'does-not-exist.txt');
const requests=[];
for(const args of [
 [],['--text','hello'],['--text','中文 🍀'],['--text-file',textFile],
 ['--text-file',absent],['--text-file'],['--text','inline','--text-file',textFile],
 ['--text-file',textFile,'--text','inline'],['--text','--text-file'],
 ['--text','  multiple spaces\n'],['--text',''],['--text-file',''],
]){
 requests.push({method:'textOption',args,inlineFlag:'--text',fileFlag:'--text-file'});
}
for(const payload of [
 {id:'a',state:'ACTIVE',tasks:[],plans:[]},
 {title:'中文 - emoji 🍀',value:1.25,more:['\n','é','u\u2028v']},
 {description:'\n\r\t\\\b\f',bool:true,nul:null},
 {arr:[1,2,3],nested:{a:'yes',b:'no'}},
 {num:0,zero:-0,fraction:0.0000001,large:9007199254740992}
]){
 for(const target of [null,'owned-file']){
  requests.push({method:'saveLocal',file:target,payload});
 }
}
function normalize(value){
 if(value&&typeof value==='object')return JSON.parse(JSON.stringify(value));
 return value;
}
async function original(r,index){
 try{
  let output;
  if(r.method==='textOption')output=await textOption(r.args,r.inlineFlag,r.fileFlag);
  else {
   const path=r.file?join(temp,'node-save-'+index+'.json'):null;
   if(path)writeFileSync(path,'before','utf8');
   await saveLocal(path,r.payload);
   output={beforeChanged:Boolean(path),contents:path?readFileSync(path,'utf8'):null};
  }
  return {ok:true,value:normalize(output)};
 }catch(e){return {ok:false,error:e.message};}
}
function native(r,index){
 const request={op:'cliSupportMore',method:r.method,
  ...(r.args?{args:r.args}:{}),...('inlineFlag'in r?{inlineFlag:r.inlineFlag}:{}),
  ...('fileFlag'in r?{fileFlag:r.fileFlag}:{}),
  ...('payload'in r?{job:r.payload}:{}),
  file:r.file?join(temp,'rust-save-'+index+'.json'):null};
 if(r.file)writeFileSync(request.file,'before','utf8');
 const proc=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:12000,
  input:JSON.stringify(request)+'\n'});
 assert.equal(proc.status,0,proc.stderr);
 const result=JSON.parse(proc.stdout.trim());
 assert.equal(result.ok,true,JSON.stringify(result));
 return result.value;
}
test('original active textOption and saveLocal byte-precise Node/Rust',async()=>{
 for(let i=0;i<requests.length;i++){
  const r=requests[i],node=await original(r,i),rust=native(r,i);
  assert.deepEqual(rust,node,'case '+i+': '+JSON.stringify(r));
 }
});
