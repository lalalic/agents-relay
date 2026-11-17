// FileFeedbackStore isolation + strict Node/Rust differential for error handling,
// durable record, attachment SHA-256, idempotency and rollback without live stores.
import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readdir,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {FileFeedbackStore,readFeedbackAttachment} from '../../dist/feedback.js';
const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const validProvenance={source:'app',product:' ToyAlive ',actorClass:'internal-test',submittedAt:'2026-11-17T08:00:00Z'};
let seed=0x36f7;function next(){seed=(Math.imul(seed,1103515245)+12345)>>>0;return seed;}function choose(arr){return arr[next()%arr.length]}
function scenario(index){const submission={text:choose(['normal feedback',' hello world ','emoji 😀','', 'Bearer abcdef', 'X'.repeat(20)]),idempotencyKey:choose(['fixed',undefined,'']),provenance:{...validProvenance},attachments:choose([[],[{filename:'x?.png',mediaType:'image/png',data:[1,2,3]}],[{filename:'another.image',mediaType:'image/webp',data:[255,0,5,3]}],[{filename:'bad.gif',mediaType:'text/plain',data:[1]}],[{filename:'bad?.png',mediaType:'image/png',data:[]}],[{filename:'ok.png',mediaType:'IMAGE/PNG',data:[4,5,6]}]])};
 const limits=choose([undefined,{maxTextLength:12,maxAttachments:1,maxAttachmentBytes:2},{maxTextLength:25,maxAttachments:0,maxAttachmentBytes:12},{maxTextLength:100,maxAttachments:4,maxAttachmentBytes:16}]);
 if(index%11===0)submission.provenance.product='';
 if(index%17===0)submission.provenance.submittedAt='invalid';
 return {case:index,submission,limits};
}
const scenarios=Array.from({length:84},(_,i)=>scenario(i));
const build=spawnSync('cargo',['build','--offline','--example','worker_c_feedback_parity','--manifest-path','rust/Cargo.toml'],{cwd:repo,encoding:'utf8'});assert.equal(build.status,0,build.stderr);
async function nodeResult(input){const root=await mkdtemp(join(tmpdir(),'rust2-worker-c-node-feedback-'));try{
 const store=new FileFeedbackStore(root,input.limits);
 const submission={...input.submission,attachments:input.submission.attachments.map(v=>({...v,data:Uint8Array.from(v.data)}))};
 try{
   const materialization=await store.submit(submission);const record=materialization.record;
   const attachments=[];for(const item of record.attachments){attachments.push({filename:item.filename,mediaType:item.mediaType,sizeBytes:item.sizeBytes,sha256:item.sha256,bytes:[...await readFeedbackAttachment(root,item)]});}
   const read=await store.read(record.id);const again=await store.submit(submission);
   const normalized=JSON.parse(JSON.stringify(record));
   delete normalized.id;delete normalized.createdAt;delete normalized.triage.updatedAt;
   for(const item of normalized.attachments){delete item.id;delete item.storageRef;delete item.uploadedAt;}
   return {ok:true,record:normalized,attachments,readSame:JSON.stringify(read)===JSON.stringify(record),dedupSame:JSON.stringify(again.record)===JSON.stringify(record)&&again.recordRef===materialization.recordRef,recordExists:!!(await readFile(materialization.recordRef))};
 }catch(error){return {ok:false,error:error.message,rootEntryCount:(await readdir(root)).length}};
}finally{await rm(root,{recursive:true,force:true})}}
test('84 randomized file-backed feedback submissions match native Rust errors and stored bytes',async()=>{
 const exe=join(repo,'rust/target/debug/examples/worker_c_feedback_parity');const input=scenarios.map(JSON.stringify).join('\n')+'\n';
 const proc=spawnSync(exe,[],{input,encoding:'utf8',maxBuffer:12*1024*1024});assert.equal(proc.status,0,proc.stderr);
 const actual=proc.stdout.trim().split('\n').map(JSON.parse);assert.equal(actual.length,scenarios.length);
 const expected=await Promise.all(scenarios.map(nodeResult));
 let match=0;for(let i=0;i<scenarios.length;i++) {try{assert.deepStrictEqual(actual[i],{ok:true,value:expected[i]})}catch(e){throw new Error(`Feedback storage mismatch scenario ${i}: request=${JSON.stringify(scenarios[i]).slice(0,500)} rust=${JSON.stringify(actual[i]).slice(0,650)} node=${JSON.stringify(expected[i]).slice(0,650)} diff=${e.message}`)}match++;}
 console.log(`PASS ${match} Node/Rust temporary-root file storage scenarios`);
});
