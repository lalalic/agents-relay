// New independent adversarial Node/Rust differential cases for Batch 4: regex workers, UTF-16 truncation, and tagged metadata.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {classifyWorkerRejection, classifyChatGptPlatformFailure, PreSubmissionRejection} from '../../dist/worker-rejection.js';
import {parseJobTagJson} from '../../dist/task-tag.js';
import {plannerTaskContext} from '../../dist/planner-task-context.js';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const requests=[];
for(const message of [
 'rate.limit.exceeded','rate limit exceeded','rate-limit exceeded','rate_limit_exceeded',
 'rate.limit exceeded','quota-exceeded','quota.exceeded','insufficient.quota',
 'usage limit reached','Quota_Exceeded','MODEL NOT FOUND','model is not found',
 'model not_found','model-is-not-found','model unsupported','model is unsupported',
 'provider.refused','provider is refused','provider-unavailable','service unavailable',
 'no such model','MODEL.UNAVAILABLE','unknown launch failure','rate limit\u00a0exceeded',
]) requests.push({op:'classifyWorkerRejection',message});
for(const phase of ['launch','delivery','start-ack']) for(const error of [
 'timeout',null,5,{}, {message:'error'}, {message:'error',code:'FAILURE'},
 {status:'rejected',submitted:false,code:'POOL_CAPACITY_FULL',message:'no slot'},
 {status:'rejected',submitted:false,code:'MODEL_UNAVAILABLE',message:'no model'},
 {status:'rejected',submitted:true,code:'MODEL_UNAVAILABLE',message:'submitted'},
]) requests.push({op:'classifyChatGptFailure',phase,error});
for(const raw of [
 '', 'null','[]','{}', '{not valid',
 JSON.stringify({description:'😀'.repeat(251),values:{a:'x'}}),
 JSON.stringify({description:'😀'.repeat(250),values:{a:'x'}}),
 JSON.stringify({description:'hello',values:{a:'😀'.repeat(17)}}),
 JSON.stringify({description:'hello',values:{a:'😀'.repeat(16)}}),
 JSON.stringify({description:'hello',values:{a:'x'}}),
 JSON.stringify({description:'hello',values:{'a.b-3_':'x'}}),
]) requests.push({op:'parseJobTag',raw});
const base={id:'task',title:'test',kind:'work',state:'QUEUED',dependencies:[],input:'content'};
for(const task of [
 base,
 {...base,input:'a'+'😀'.repeat(2000)},
 {...base,input:'😀'.repeat(2001)},
 {...base,input:'\u0085'+ 'x'.repeat(4000)},
 {...base,comments:[{author:'a',text:'a'+'😀'.repeat(500),createdAt:'now'}]},
 {...base,error:'a'+'😀'.repeat(1000)},
 {...base,result:{summary:'a'+'😀'.repeat(2000),data:{ok:true}}},
 {...base,platformFailure:{classification:'outcome_unknown',evidence:'a'+'😀'.repeat(2000),safeToReroute:false}},
]) requests.push({op:'plannerTaskContext',task});
function reference(request){
 try{
  let value;
  switch(request.op){
   case 'classifyWorkerRejection':value=classifyWorkerRejection(request.message);break;
   case 'classifyChatGptFailure':{
    let error=request.error;
    if(error?.status==='rejected'&&error?.submitted===false) error=PreSubmissionRejection.fromPlatformResponse(error)??error;
    value=classifyChatGptPlatformFailure(error,request.phase);break;
   }
   case 'parseJobTag':value=parseJobTagJson(request.raw);break;
   case 'plannerTaskContext':value=plannerTaskContext(request.task);break;
  }
  return {ok:true,value:value===undefined?null:JSON.parse(JSON.stringify(value))};
 }catch(error){return {ok:false,error:error.message};}
}

test('Batch 4 JSON-wire edge cases preserve Node worker and Unicode behavior',()=>{
 const rust=spawnSync(binary,[],{input:requests.map(JSON.stringify).join('\n')+'\n',encoding:'utf8',maxBuffer:6*1024*1024});
 assert.equal(rust.status,0,rust.stderr);
 const lines=rust.stdout.trim().split('\n');
 assert.equal(lines.length,requests.length);
 const mismatches=[];
 for(let i=0;i<requests.length;i++){
  const expected=reference(requests[i]);
  const actual=JSON.parse(lines[i]);
  if(JSON.stringify(actual)!==JSON.stringify(expected))
   mismatches.push({index:i,operation:requests[i].op,error:expected.error||null,actual:JSON.stringify(actual).slice(0,200),expected:JSON.stringify(expected).slice(0,200)});
 }
 assert.deepEqual(mismatches,[],`Unmatched cases: ${mismatches.length}`);
 console.log(`${requests.length} batch 4 adversarial comparisons passed`);
});
