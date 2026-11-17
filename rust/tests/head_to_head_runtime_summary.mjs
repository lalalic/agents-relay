// Direct Node/Rust differential: src/runtime-summary.ts, fixed clock, only live leased executions; no live processes queried.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {summarizeRuntime} from '../../dist/runtime-summary.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),binary=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);ready=true;}
 const r=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000});assert.equal(r.status,0,`${r.error}: ${r.stderr}`);return JSON.parse(r.stdout.trim());}
function node(req){try{return {ok:true,value:summarizeRuntime(req.jobs,req.now)}}catch(e){return {ok:false,error:e.message}}}
let seed=0x147f513f;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};const pick=a=>a[rand(a.length)];
const now=Date.parse('2026-11-17T04:00:00.000Z');
const future=new Date(now+3600000).toISOString(),past=new Date(now-3600000).toISOString(),boundary=new Date(now).toISOString();
const cases=[];
for(let i=0;i<700;i++){
 const jobs=Array.from({length:rand(8)},(_,j)=>({id:`job-${i}-${j}`,title:`Job ${i}-${j}`,repository:'repo-'+j,prNumber:rand(5),state:pick(['ACTIVE','ACTIVE','ACTIVE','DRAFT','COMPLETED','CANCELLED']),
  tasks:Array.from({length:rand(18)},(_,k)=>({id:`task-${i}-${j}-${k}`,state:pick(['RUNNING','RUNNING','RUNNING','QUEUED','SUCCEEDED','FAILED']),
    adapter:pick(['codex','chatgpt','orchestrator','terminal','other']),agentName:pick([null,'worker','reviewer','coordinator']),
    workerSelection:pick([null,undefined,{adapter:'codex'},{adapter:'chatgpt'},{adapter:'orchestrator'},{adapter:null}]),
    executionId:pick([null,undefined,'',`exec-${k}`]),leaseOwner:pick([null,undefined,'','relay']),
    leaseExpiresAt:pick([null,undefined,'',past,future,boundary,'invalid']),
    routing:pick([null,undefined,{provider:'openrouter',model:'gpt-6'},{provider:'local',model:'qwen3.5'},{provider:'remote',model:'glm-5'},{provider:'local',model:''}])}))}));
 cases.push({op:'summarizeRuntime',jobs,now});
}
test('runtime summary ignores ghost RUNNING tasks and matches Node worker and model counting',()=>{
 for(const [i,scenario] of cases.entries()){
  const req=JSON.parse(JSON.stringify(scenario));
  assert.deepEqual(rust(req),node(req),`runtime summary fixture ${i}`);
 }
 console.log(`Verified ${cases.length} Node/Rust lease-fenced runtime summary fixtures`);
});
