// New independent adversarial differential gate for Node src/planner-history-cleanup.ts and related Batch 3 ports.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { parsePlannerHistoryCleanup } from '../../dist/planner-history-cleanup.js';
import { preserveReviewRevisionHistory } from '../../dist/review-revision-merge.js';
import { orderGitHubBindingCandidates } from '../../dist/github-binding-order.js';
import { ProjectionFailureDeduplicator } from '../../dist/projection-failure-dedupe.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary = resolve(root,'rust/target/debug/relay-rust2-parity');
const ready = {taskId:'a',outcome:'unresolved',evidence:'x',reason:'evidence'};
const requests=[];
for(const value of [null,false,123,'value',{},[null],[{}],
 [{...ready,targetTaskId:null}],[{...ready,targetTaskId:false}],
 [{...ready,targetTaskId:0}],[{...ready,targetTaskId:'  '}],
 [{...ready,taskId:'\u0085'}], [{...ready,evidence:'\u0085'}],
 [{...ready,outcome:'invalid',targetTaskId:null}],
 [{...ready,outcome:'invalid',targetTaskId:'a'}]]) requests.push({op:'parsePlannerHistoryCleanup',value});
for(const value of [null,false,0,'',[],{},true,[1]]) {
 for(const field of ['reviewRevisionRequests','reviewRevisionRounds']) {
  requests.push({op:'preserveReviewRevisionHistory',local:{[field]:value},merged:{reviewRevisionRequests:[1],reviewRevisionRounds:[2]}});
 }
}
const candidate=(id,createdAt)=>({snapshotPath:`/tmp/${id}`,job:{id,state:'ACTIVE',prNumber:0,createdAt}});
requests.push({op:'orderGitHubBindingCandidates',items:[candidate('b','z'),candidate('a','ä'),candidate('c','B'),candidate('d','a')]});
requests.push({op:'orderGitHubBindingCandidates',items:[candidate('z','2026-11-02'),candidate('a','2026-11-01')]});
requests.push({op:'resetProjectionFailureDeduplicator'});
for(let i=0;i<4097;i++) requests.push({op:'projectionFailureShouldReport',jobId:`job-${i}`,updatedAt:'t',reason:'r',classification:'terminal'});
requests.push({op:'projectionFailureShouldReport',jobId:'job-0',updatedAt:'t',reason:'r',classification:'terminal'});
let dedupe = new ProjectionFailureDeduplicator();
function nodeValue(request) {
 try {
  let value;
  switch(request.op){
   case 'parsePlannerHistoryCleanup': value=parsePlannerHistoryCleanup(request.value);break;
   case 'preserveReviewRevisionHistory':preserveReviewRevisionHistory(request.local,request.merged);value=request.merged;break;
   case 'orderGitHubBindingCandidates':value=orderGitHubBindingCandidates(request.items);break;
   case 'resetProjectionFailureDeduplicator':dedupe=new ProjectionFailureDeduplicator();value=null;break;
   case 'projectionFailureShouldReport':value=dedupe.shouldReport(request.jobId,request.updatedAt,request.reason,request.classification);break;
  }
  return {ok:true,value:value??null};
 }catch(error){return {ok:false,error:error.message};}
}

test('adversarial Node/Rust edge and 4096-capacity eviction parity',()=>{
 const result=spawnSync(binary,[],{input:requests.map(x=>JSON.stringify(x)).join('\n')+'\n',encoding:'utf8',maxBuffer:8*1024*1024});
 assert.equal(result.status,0,`Rust parity CLI failed: ${result.stderr}`);
 const outputs=result.stdout.trim().split('\n');
 assert.equal(outputs.length,requests.length);
 const mismatches=[];
 for(let i=0;i<requests.length;i++){
  const actual=JSON.parse(outputs[i]);
  const expected=nodeValue(requests[i]);
  if(JSON.stringify(actual)!==JSON.stringify(expected)) mismatches.push({index:i,request:requests[i],actual,expected});
 }
 assert.deepEqual(mismatches,[],`${mismatches.length} mismatches`);
 console.log(`${requests.length} adversarial cases matched`);
});
