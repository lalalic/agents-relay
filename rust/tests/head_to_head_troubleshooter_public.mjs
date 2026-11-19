// All 6 original Node src/troubleshooter.ts public APIs, including durable
// global SQLite numeric ID reservation and actual Graph-generated recovery.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import * as t from '../../dist/troubleshooter.js';
const root=resolve(import.meta.dirname,'../..');const bin=resolve(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-troubleshooter-h2h-'));
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
const iso='2026-11-18T20:00:00.000Z';
function data(i,storeDir){
 const original={id:'2',jobId:'17',kind:'work',state:['FAILED','BLOCKED','SUCCEEDED','DRAFT','QUEUED'][i%5],
   adapter:'codex',agentName:'implementation',attempt:1+(i%3),maxAttempts:3,
   error:i%2?'execution timed out':'worker_process_failed',dependencies:[],
   createdAt:iso,updatedAt:iso};
 const recovery={id:'3',jobId:'17',kind:'work',state:['SUCCEEDED','FAILED','CANCELLED','QUEUED','RUNNING'][i%5],
   agentName:'troubleshooter',adapter:'codex',parentTaskId:'2',
   recoveryForAttempt:i%4,attempt:i%3,maxAttempts:2,
   error:'recovery failed',createdAt:iso,updatedAt:iso};
 const job={id:'17',repository:'fixture',projectRoot:join(storeDir,'project'),
    title:'Fix failed execution',state:'ACTIVE',priority:'P2',prNumber:0,
    tasks:i%6===0?[original]:[original,recovery],plans:[],
    createdAt:iso,updatedAt:iso};
 if(i%8===0){job.recoveryFailures=[{taskId:'2',recoveryTaskId:'3'}]};
 return {job,original,recovery};
}
function normalize(v){if(typeof v==='string'&&/^20\d\d-\d\d-\d\dT/.test(v))return '<time>';
 if(Array.isArray(v))return v.map(normalize);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).filter(([,x])=>x!==undefined).map(([k,x])=>[k,normalize(x)]));
 return v;}
async function node({job,original,recovery,storeDir}){
 const before=process.env.AGENTS_RELAY_STORE_DIR;process.env.AGENTS_RELAY_STORE_DIR=storeDir;
 try{
  const id=t.troubleshooterTaskId(original,job.repository);
  const reopens=t.pendingTroubleshooterReopens(job);
  const retries=t.pendingTroubleshooterRetries(job);
  const pending=t.pendingTroubleshooterTasks(job);
  const exhausted=t.exhaustedTroubleshooterRecoveries(job);
  const copied=structuredClone(recovery);
  t.refreshTroubleshooterInput(job,original,copied);
  return {ok:true,value:normalize({id,reopens,retries,pending,exhausted,recovery:copied})};
 }catch(error){return {ok:false,error:error.message}}
 finally{if(before===undefined)delete process.env.AGENTS_RELAY_STORE_DIR;else process.env.AGENTS_RELAY_STORE_DIR=before;}
}
const fixtures=[];
for(let i=0;i<35;i++){
 const sourceDir=join(tmp,`node-${i}`,'stores'),rustDir=join(tmp,`rust-${i}`,'stores');
 mkdirSync(sourceDir,{recursive:true});mkdirSync(rustDir,{recursive:true});
 const dataValue=data(i,sourceDir);fixtures.push({i,sourceDir,rustDir,...dataValue});
}
test('35 original Node/Rust public Troubleshooter Graph, recovery and numeric ID cases',async()=>{
 for(const item of fixtures){
  const expected=await node({...item,storeDir:item.sourceDir});
  const rust=spawnSync(bin,[],{cwd:root,encoding:'utf8',input:JSON.stringify({
    op:'certTroubleshooter',storeDir:item.rustDir,job:item.job,
    original:item.original,recovery:item.recovery})+'\n',timeout:15000});
  assert.equal(rust.status,0,rust.stderr);
  const actual=JSON.parse(rust.stdout.trim());
  if(actual.ok)actual.value=normalize(actual.value);
  assert.deepEqual(actual,expected,`Troubleshooter API scenario ${item.i}: Rust=${JSON.stringify(actual)} Node=${JSON.stringify(expected)}`);
 }
 console.log('Verified 35 x 6 Troubleshooter source vs native Rust public API cases');
});
