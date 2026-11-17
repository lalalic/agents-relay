// Node/Rust head-to-head fixtures for src/execution-event-identity.ts: exact worker source identity, extract-and-bind and in-memory terminal dedupe only.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';import {resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {executionEventSource,eventSourceId,executionIdFromSource,claimTerminalExecution,terminalExecutionClaimed} from '../../dist/execution-event-identity.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');let built=false;
function rust(req){
 if(!built){const b=spawnSync('cargo',['build','--offline','--manifest-path','rust/Cargo.toml'],{cwd:root,encoding:'utf8',timeout:90000});assert.equal(b.status,0,b.stderr);built=true;}
 const out=spawnSync(binary,[],{input:JSON.stringify(req)+'\n',encoding:'utf8',timeout:10000,maxBuffer:3*1024*1024});
 assert.equal(out.status,0,`${out.error}: ${out.stderr}`);return JSON.parse(out.stdout.trim());
}
function node(req){try{
 let value;
 switch(req.op){
  case 'executionEventSource':value=executionEventSource(req.jobId,req.taskId,req.executionId);break;
  case 'eventSourceId':value=eventSourceId(req.event);break;
  case 'executionIdFromSource':value=executionIdFromSource(req.sourceId,req.jobId,req.taskId);break;
  case 'terminalClaimScenario':for(const id of req.claims)claimTerminalExecution(id);value=req.checks.map(c=>terminalExecutionClaimed(c.jobId,c.taskId,c.executionId));break;
 }
 return {ok:true,value:value===undefined?null:value};
 }catch(e){return {ok:false,error:e.message}}
}
let seed=0xa5b82711;const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};const one=xs=>xs[rand(xs.length)];
const requests=[];
const names=['1','42','job 2','🐼','/','', 'a/b','run.with.dot','0','1001'];
for(let i=0;i<750;i++){
 const jobId=one(names),taskId=one(names),executionId=one(names);
 const generated=executionEventSource(jobId,taskId,executionId);
 requests.push({op:'executionEventSource',jobId,taskId,executionId});
 requests.push({op:'eventSourceId',event:one([{source:{id:generated}}, {source:{id:3}}, {source:{id:null}}, {source:{}}, {}, {source:null}])});
 requests.push({op:'executionIdFromSource',sourceId:one([generated,`job/${jobId}/task/${taskId}/execution/`,undefined,null,
  `job/${jobId}/task/other/execution/${executionId}`,`job/${jobId}/task/${taskId}/execution/b${executionId}`]),jobId,taskId});
}
for(let i=0;i<275;i++){
 const jobId=`job-${i}`,taskId=`task-${i}`,executionId=`execution-${i}`;
 const source=executionEventSource(jobId,taskId,executionId);
 requests.push({op:'terminalClaimScenario',claims:one([[],[source],[source,source],[source,'job/x/task/y/execution/z']]),
  checks:[{jobId,taskId,executionId},{jobId,taskId,executionId:executionId+'-stale'}, {jobId:'other',taskId,executionId}]});
}
test('execution source and terminal claim identity match Node across 2,525 isolated fixtures',()=>{
 for(const [i,req] of requests.entries())assert.deepEqual(rust(req),node(req),`execution identity fixture ${i}: ${JSON.stringify(req)}`);
 console.log(`Verified ${requests.length} Node/Rust execution-event identity and terminal claim fixtures`);
});
