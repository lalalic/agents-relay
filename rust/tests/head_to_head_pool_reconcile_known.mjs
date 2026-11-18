// Node/Rust startup recovery ordering and local-authority guard for Pool.
// Both sides use disposable in-memory Store ports; no active Relay job touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {RepositoryWorkerPool} from '../../dist/pool.js';

const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const job=(id,state='ACTIVE')=>({
 id,state,repository:'fixture/repo',priority:'P2',createdAt:'2026-11-18T09:00:00Z',
 updatedAt:'2026-11-18T09:00:00Z',tasks:[],plans:[],headSha:'fixture',
 reviewEnabled:false,pause:null
});
const cases=[
 {discovered:[],localJobs:[]},
 {discovered:[job('1','DRAFT')],localJobs:[]},
 {discovered:[job('1')],localJobs:[job('1')]},
 {discovered:[job('1'),job('2','COMPLETED')],localJobs:[job('1')]},
 {discovered:[job('1','DRAFT'),job('2')],localJobs:[job('2')]},
 {discovered:[job('2'),job('1')],localJobs:[job('1'),job('2')]},
 {discovered:[job('1')],localJobs:[job('1')],hydrateEnabled:false},
 {discovered:[job('1')],localJobs:[job('1')],recoverEnabled:false},
 {discovered:[job('1')],localJobs:[job('1')],recoverError:'Startup recovery failed'},
 {discovered:[job('1')],localJobs:[]},
 {discovered:[job('2','DRAFT'),job('1')],localJobs:[]},
 {discovered:[job('1')],localJobs:[job('1')],recoveredState:'DRAFT'},
 {discovered:[job('1'),job('1')],localJobs:[job('1')]},
];
async function runNode(f) {
 const calls=[];
 const local=new Map(f.localJobs.map(j=>[j.id,j]));
 const pool=new RepositoryWorkerPool(2,(store,maxConcurrent)=>{
  calls.push(['make',maxConcurrent,store.id]);
  const reconciler={reconcile:async id=>{calls.push(['reconcile',id,maxConcurrent]);}};
  if(f.recoverEnabled!==false){
   reconciler.recoverStartupOrphans=async id=>{
    calls.push(['recover',id]);
    if(f.recoverError)throw Error(f.recoverError);
    return f.recoveredState?{...local.get(id),state:f.recoveredState}:local.get(id);
   };
  }
  return reconciler;
 },async()=>[],async id=>{
  const value=local.get(id);
  if(!value)return null;
  const store={id,load:async()=>value};
  if(f.hydrateEnabled!==false)store.hydrate=async()=>{calls.push(['hydrate',id]);};
  return {job:value,store};
 });
 let outcome={ok:true};
 try{await pool.reconcileKnown(f.discovered.map(job=>({job})));}
 catch(error){outcome={ok:false,error:error.message};}
 return {outcome,calls};
}
test('Node/Rust Pool reconcileKnown startup recovery and missing-local fail-closed',async()=>{
 const expected=[];
 for(const scenario of cases)expected.push(await runNode(scenario));
 const result=spawnSync(bin,[],{cwd:root,
  input:cases.map(f=>JSON.stringify({op:'apiPoolKnown',...f})).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:5*1024*1024
 });
 assert.equal(result.status,0,result.stderr||result.error?.message);
 const lines=result.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(lines.length,cases.length);
 const differences=[];
 for(let i=0;i<cases.length;i++){
  try{assert.deepEqual(lines[i].value,expected[i]);}
  catch{differences.push({i,expected:expected[i],rust:lines[i]});}
 }
 assert.deepEqual(differences,[],JSON.stringify(differences,null,2));
 console.log('Verified',cases.length,'Node/Rust Pool startup-recovery fixtures');
});
