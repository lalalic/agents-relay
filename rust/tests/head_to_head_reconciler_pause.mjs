// Direct Node/Rust differential for src/reconciler-pause.ts, using only in-memory fake cancellation callbacks.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {cancelPausedGenerations} from '../../dist/reconciler-pause.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
let compiled=false;
function rust(job){
 if(!compiled){const build=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(build.status,0,build.stderr);compiled=true;}
 const result=spawnSync(binary,[],{input:JSON.stringify({op:'cancelPausedGenerations',job})+'\n',encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,`${result.error}: ${result.stderr}`);return JSON.parse(result.stdout.trim());
}
function node(job){
 const calls=[];
 try{cancelPausedGenerations(job,(taskId,executionId)=>calls.push({kind:'task',taskId,executionId}),planId=>calls.push({kind:'plan',planId}));return {ok:true,value:calls};}
 catch(error){return {ok:false,error:error.message};}
}
let seed=0x2e250b11;
function rand(max){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%max;}
const choose=values=>values[rand(values.length)];
const scenarios=[
 {id:'1',pause:null,tasks:[{id:'t1',pausedExecution:{id:'e1'}}]},
 {id:'1',pause:false,tasks:[{id:'t1',pausedExecution:{id:'e1'}}]},
 {id:'1',pause:true,tasks:[],plans:[]},
 {id:'1',pause:{at:'now'},tasks:[{id:'t1',pausedExecution:{id:'e1'}},{id:'t2',pausedExecution:null}],plans:[{id:'p1',pausedExecutionId:'pe1'}]},
 {id:'1',pause:'paused',tasks:[{id:'t1',pausedExecution:{id:'e1'}},{id:'t2',pausedExecution:{id:'e2'}}],plans:[{id:'p1',pausedExecutionId:'e3'},{id:'p2',pausedExecutionId:''}]},
];
for(let i=0;i<900;i++){
 const paused=choose([true,false,null,{},'paused',0]);
 const tasks=Array.from({length:rand(15)},(_,j)=>({id:`task-${i}-${j}`,pausedExecution:choose([undefined,null,false,{id:`exec-${j}`},{id:`exec-${j}-v2`}])}));
 const plans=Array.from({length:rand(12)},(_,j)=>({id:`plan-${i}-${j}`,pausedExecutionId:choose([null,false,undefined,`plan-exec-${j}`])}));
 scenarios.push({id:String(i),pause:paused,tasks,plans:choose([undefined,[],plans])});
}
test('durable paused generations are cancelled in exact Node Task-then-Plan order',()=>{
 for(let i=0;i<scenarios.length;i++){
  const original=node(scenarios[i]);assert.equal(original.ok,true);
  assert.deepEqual(rust(scenarios[i]),original,`paused Job fixture ${i}`);
 }
 console.log(`Verified ${scenarios.length} Node/Rust pause-generation cases with no live process signals`);
});
