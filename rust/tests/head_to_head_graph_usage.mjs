// Node/Rust reverse symbol index for src/workflow/usage-index.ts, using the same canonical executable .mmd directory and synthetic graphs.
import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';import {fileURLToPath} from 'node:url';
import {buildWorkflowUsageIndex,executableGraphs,whereWorkflowSymbol,defaultWorkflowDirectory} from '../../dist/workflow/usage-index.js';
import {parseGraphV2} from '../../dist/workflow/graph-v2.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..'),bin=resolve(root,'rust/target/debug/relay-rust2-parity');let ready=false;
function rust(req){if(!ready){const result=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(result.status,0,result.stderr);ready=true;}
 const r=spawnSync(bin,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim());}
function node(req){try{const graphs=req.directory?executableGraphs(req.directory):new Map(req.graphs.map(item=>[item.name,parseGraphV2(item.source)]));
 const index=buildWorkflowUsageIndex(graphs);return {ok:true,value:req.id?whereWorkflowSymbol(index,req.id,req.kind):index};
 }catch(error){return {ok:false,error:error.message}}}
const knownDirectory=defaultWorkflowDirectory();
test('the entire canonical executable Graph source inventory has identical reverse symbol index',()=>{
 const request={op:'workflowUsageIndex',directory:knownDirectory};const expected=node(request),actual=rust(request);
 assert.deepEqual(actual,expected,'canonical Graph usage index mismatch');
 console.log(`Verified ${expected.value?.length??0} Node/Rust canonical workflow symbol usages from ${knownDirectory}`);
});
const samples=[
 'flowchart LR\n%% relay: initial a\na["state: ACTIVE"]\nb["state: COMPLETED"]\na -->|on: finished| b',
 'flowchart TD\n%% relay: initial a\na["state: QUEUED"]\ng["guard: ready"]\nb["state: RUNNING"]\na -->|on: dispatch| g\ng -->|true| b\ng -->|false| a',
 'flowchart LR\n%% relay: initial a\na["state: ACTIVE"]\nx["action: effect.apply"]\ne["emit: task.completed"]\nb["state: COMPLETED"]\na -->|on: ready| x\nx -->|emit: task.completed| e\nx -->|to: COMPLETED| b'
];
let seed=0xb331adbc;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;},pick=xs=>xs[rand(xs.length)];
const requests=[];
for(let i=0;i<480;i++){
 const graphs=Array.from({length:1+rand(5)},(_,j)=>({name:`${String.fromCharCode(97+j)}-${i%9}.mmd`,source:pick(samples)}));
 const id=pick(['ACTIVE','READY','ready','effect.apply','task.completed','finished','COMPLETED','dispatch',undefined]);
 const kind=pick(['state','guard','action','request','event',undefined]);
 requests.push({op:'workflowUsageIndex',graphs,id,kind});
}
test('static Graph symbol usage positions and read-only filters match Node',()=>{
 for(const [i,request] of requests.entries()){
   assert.deepEqual(rust(request),node(request),`usage ${i}: ${JSON.stringify(request).slice(0,500)}`);
 }
 console.log(`Verified ${requests.length} Node/Rust synthetic workflow source and filtered index fixtures`);
});
