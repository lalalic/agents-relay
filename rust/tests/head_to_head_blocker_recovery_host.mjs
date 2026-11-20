// The ORIGINAL Node ensureBlockerRecovery() and real Rust isolated-write
// WorkspaceControlBackend::blocker_ensure(). Independent disposable Git roots;
// both start from the original Node-created single-SQLite schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {ensureBlockerRecovery} from '../../dist/blocker-recovery.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const now='2026-11-19T00:00:00.000Z';
const work=mkdtempSync(join(tmpdir(),'rust2-blocker-diff-'));
function fixture(name){
 const base=join(work,name),stores=join(base,'stores');mkdirSync(stores,{recursive:true});
 for(const repository of ['dependent','target']){
  const path=join(base,repository);mkdirSync(path);
  execFileSync('git',['init','-q','--initial-branch=main',path]);
 }
 return {base,stores};
}
// Canonical test fixture has exactly the same durable inputs for each runtime.
async function setup(f){
 const job={id:'17',title:'Dependent Job',repository:'dependent',prNumber:0,
  projectRoot:join(f.base,'dependent'),state:'ACTIVE',
  tasks:[{id:'5',jobId:'17',title:'Failed work',kind:'work',agentName:'developer',
    state:'FAILED',attempt:2,maxAttempts:2,dependencies:[],capabilities:[],
    input:'Build recovery',output:null,createdAt:now,updatedAt:now}],
  plans:[],createdAt:now,updatedAt:now};
 const db=new SQLiteRelayStore(join(f.base,'relay.sqlite'),'17');
 try{await db.saveJob(job);}finally{db.close();}
}
function request(f){return {requestId:'native-request-00001',
 targetRepository:'target',targetProjectRoot:join(f.base,'target'),
 dependentRepository:'dependent',dependentJobId:'17',dependentTaskId:'5',
 origin:'planner',resolutionMode:'merge',authorized:true,
 authorizedRepositories:['dependent','target'],title:'Recover dependent build',
 reason:'A durable target dependency blocked dependent Task 5',
 objective:`Recover target repository in an independent Job to unblock dependent Task 5: ${'recovery context '.repeat(10)}`,
 storeDirectory:f.stores,now};}
async function native(f,input){
 const command={op:'batchAPublicParity',method:'blockerEnsureNative',
  storeDirectory:f.stores,input};
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
  input:JSON.stringify(command)+'\n',timeout:30000,maxBuffer:8e6});
 assert.equal(run.status,0,run.stderr);
 const outer=JSON.parse(run.stdout.trim());
 assert.equal(outer.ok,true,JSON.stringify(outer));
 return outer.value;
}
async function original(input){try{return {ok:true,value:{receipt:await ensureBlockerRecovery(input)}}}
 catch(error){return {ok:false,error:error.message}}}
async function load(f,id){let db=new SQLiteRelayStore(join(f.base,'relay.sqlite'),id);
 try{return await db.loadJob(id);}finally{db.close();}}
function projection(job){return {
 id:job.id,title:job.title,state:job.state,
 blockerResolutionMode:job.blockerResolutionMode,
 blockerRecoveryRequest:job.blockerRecoveryRequest,
 unblocks:job.unblocks,
};}
test('original Node and native Rust blocker creation and restart share receipt, fingerprint and durable relation',async()=>{
 const a=fixture('node'),b=fixture('rust');await setup(a);await setup(b);
 for(let round=1;round<=2;round++){
  const node=await original(request(a)),rust=await native(b,request(b));
  assert.equal(node.ok,true,`Node round ${round}: ${JSON.stringify(node)}`);
  assert.equal(rust.ok,true,`Rust round ${round}: ${JSON.stringify(rust)}`);
  assert.deepEqual(rust.value.receipt,node.value.receipt,`receipt round ${round}`);
  const id=rust.value.receipt.blockerJobId;
  const originalBlocker=await load(a,id),nativeBlocker=await load(b,id);
  assert.deepEqual(projection(nativeBlocker),projection(originalBlocker),
   `durable blocker Graph projection round ${round}`);
  const originalDependent=await load(a,'17'),nativeDependent=await load(b,'17');
  assert.deepEqual(nativeDependent.tasks[0].blockerRecoveryReceipt,
   originalDependent.tasks[0].blockerRecoveryReceipt,
   `durable dependent receipt round ${round}`);
  // The native SQLite port also commits blockedBy in the SAME transaction as
  // its inverse relation; the original Node implementation can leave it
  // missing because it uses separate cross-Job writes. This is deliberately
  // stronger than the original's observed durability, not an accidental delta.
  assert.equal(nativeDependent.tasks[0].blockedBy?.jobId,id,
   `native atomic dependent binding round ${round}`);
 }
});
test('original Node and Rust reject unauthorized and malformed blocker requests without durable writes',async()=>{
 for(const kind of ['authorization','requestId','reason']){
  const a=fixture(`node-${kind}`),b=fixture(`rust-${kind}`);
  await setup(a);await setup(b);
  const na=request(a),ra=request(b);
  if(kind==='authorization'){na.authorized=false;ra.authorized=false;}
  if(kind==='requestId'){na.requestId='unsafe';ra.requestId='unsafe';}
  if(kind==='reason'){na.reason='short';ra.reason='short';}
  const node=await original(na),rust=await native(b,ra);
  assert.equal(node.ok,false,JSON.stringify(node));
  assert.equal(rust.ok,false,JSON.stringify(rust));
  assert.equal(rust.error,node.error,`negative ${kind}`);
  assert.deepEqual((await load(a,'17')).tasks,(await load(b,'17')).tasks);
 }
});
process.on('exit',()=>rmSync(work,{recursive:true,force:true}));
