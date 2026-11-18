// Direct real Node src/usage.ts CodexApiUsageReader vs native Rust equivalent.
// Every launched `codex` is a disposable local shell fixture, NEVER Codex CLI.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,mkdirSync,chmodSync,mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {CodexApiUsageReader} from '../../dist/usage.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const folder=mkdtempSync(join(tmpdir(),'rust2-codex-app-server-fake-'));
test.after(()=>rmSync(folder,{force:true,recursive:true}));
const clock='2026-11-17T22:35:00.000Z';
const complete=(five=12.5,weekly=73.5)=>({jsonrpc:'2.0',id:2,result:{rateLimits:{
 primary:{usedPercent:five,windowDurationMins:300,resetsAt:1795000000},
 secondary:{usedPercent:weekly,windowDurationMins:10080,resetsAt:1795600000}}}});
const responses=[
 complete(),
 complete(0,100),
 {id:2,result:{rateLimits:{primary:{usedPercent:50,windowDurationMins:300,resetsAt:1795000000}}}},
 {id:2,result:{rateLimits:{secondary:{usedPercent:3,windowDurationMins:10080,resetsAt:1795000000}}}},
 {id:2,result:{rateLimits:{primary:{usedPercent:-1,windowDurationMins:300},secondary:{usedPercent:55,windowDurationMins:10080}}}},
 {id:2,result:{rateLimits:{primary:{usedPercent:101,windowDurationMins:300},secondary:{usedPercent:55,windowDurationMins:10080}}}},
 {id:2,result:{rateLimits:{primary:{usedPercent:15,windowDurationMins:300},secondary:{usedPercent:55,windowDurationMins:10080}}}},
 {id:2,result:{rateLimits:{primary:{usedPercent:15,windowDurationMins:10080},secondary:{usedPercent:55,windowDurationMins:300}}}},
 {id:2,result:{}},
];
function quoteShell(text){return "'"+text.replaceAll("'","'\\''")+"'";}
const cases=[];
for(let i=0;i<responses.length;i++){
 const directory=join(folder,'case-'+i);mkdirSync(directory);
 const script=join(directory,'codex'),trace=join(directory,'rpc.jsonl');
 const result=JSON.stringify(responses[i]);
 const preamble=`#!/bin/sh\n[ "$1" = app-server ] && [ "$2" = --stdio ] || exit 7\nIFS= read -r initialize || exit 8\nprintf '%s\\n' "$initialize" >> ${quoteShell(trace)}\nIFS= read -r query || exit 9\nprintf '%s\\n' "$query" >> ${quoteShell(trace)}\n`;
 const prefix=i%3===0?`printf '%s\\n' ${quoteShell(JSON.stringify({id:1,result:{hello:'ok'}}))}\n`:'';
 const bad=i%4===0?`printf '%s\\n' ${quoteShell('not json')}\n`:'';
 writeFileSync(script,preamble+prefix+bad+`printf '%s\\n' ${quoteShell(result)}\n`);
 chmodSync(script,0o700);
 cases.push({op:'codexApiUsage',command:script,clock,trace,directory});
}
function readNode(fake){
 return new Promise(async(resolveRead,rejectRead)=>{
  const previous=process.env.PATH;
  process.env.PATH=fake.directory+':'+previous;
  try{
    const reader=new CodexApiUsageReader(()=>new Date(clock));
    const result=await reader.read();
    resolveRead(result);
  }catch(e){rejectRead(e);}finally{process.env.PATH=previous;}
 });
}
function traceLines(path){return readFileSync(path,'utf8').trim().split('\n').map(JSON.parse);}
test('nine owned local fake Codex JSON-RPC app-server quota scenarios match Node and Rust',async()=>{
 const expected=[];
 for(const item of cases){
  expected.push(await readNode(item));
  const rpc=traceLines(item.trace);
  assert.deepEqual(rpc.map(x=>x.id),[1,2]);
  assert.equal(rpc[0].method,'initialize');
  assert.equal(rpc[1].method,'account/rateLimits/read');
 }
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:cases.map(c=>JSON.stringify({op:c.op,command:c.command,clock})).join('\n')+'\n',
  maxBuffer:6*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,cases.length);
 const mismatch=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:expected[i]});}
  catch{mismatch.push({i,node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatch.slice(0,8),[],`${mismatch.length} provider observation mismatches`);
 for(const item of cases){
  const rpc=traceLines(item.trace);
  assert.equal(rpc.length,4,'both Node and Rust must send the same 2 RPC requests');
  assert.equal(rpc[2].method,'initialize');
  assert.equal(rpc[3].method,'account/rateLimits/read');
 }
 console.log(`Verified ${cases.length} original Node/Rust Codex app-server fake-process fixtures without the real Codex CLI`);
});

test('missing Codex executable fails closed immediately with exact Node/Rust reason',async()=>{
 const empty=join(folder,'missing-codex-path');mkdirSync(empty);
 const originalPath=process.env.PATH;
 let node;
 try{
  process.env.PATH=empty;
  node=await new CodexApiUsageReader(()=>new Date(clock)).read();
 }finally{process.env.PATH=originalPath;}
 const request={op:'codexApiUsage',clock,command:join(empty,'codex')};
 const result=spawnSync(binary,[],{cwd:root,encoding:'utf8',timeout:20_000,
  input:JSON.stringify(request)+'\n'});
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const rust=JSON.parse(result.stdout.trim());
 assert.deepEqual(rust,{ok:true,value:node});
 assert.equal(node.available,false);
 assert.equal(node.reason,'Codex app-server could not be started.');
});
