import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
import {Reconciler} from '../../dist/reconciler.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const at='2026-11-18T09:00:00.000Z';
const base=(state='DRAFT',pause=null)=>({id:'1',repository:'fixture',prNumber:0,
 title:'Direct reconcile',objective:'Complete work',state,createdAt:at,updatedAt:at,
 tasks:[],plans:[],reviewEnabled:false,pause,headSha:null});
const cases=[
 {job:base('DRAFT')},{job:base('COMPLETED')},{job:base('CANCELLED')},
 {job:base('ACTIVE',{reason:'manual'})},
 {job:{...base('ACTIVE',{reason:'manual'}),headSha:'head-old'}},
 {job:{...base('DRAFT'),headSha:'head-old'}},
 {job:{...base('DRAFT'),headSha:'head-old'},head:'head-new'},
 {job:{...base('COMPLETED'),headSha:'head-old'},head:'head-new'},
 {job:{...base('ACTIVE',{reason:'paused'}),headSha:'head-old'},head:'head-new'},
 {job:base('ACTIVE')},
 {job:{...base('ACTIVE'),headSha:'head-old'},head:'head-new'},
];
function normalize(value){
 if(Array.isArray(value))return value.map(normalize);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value)
  .map(([k,v])=>[k,/At$/.test(k)&&typeof v==='string'&&/^20\d\d-/.test(v)?'<time>':normalize(v)]));
 return value;
}
function rust(){
 const child=spawnSync(bin,[],{cwd:root,encoding:'utf8',timeout:120000,
  input:cases.map(f=>JSON.stringify({op:'apiReconcilerReconcile',root,jobId:'1',...f})).join('\n')+'\n',maxBuffer:8*1024*1024});
 assert.equal(child.status,0,child.stderr||child.error?.message);
 return child.stdout.trim().split('\n').map(JSON.parse).map(r=>normalize(r.value));
}
async function node(f){
 let job=structuredClone(f.job);const calls=[];
 const store={load:async id=>{calls.push(['load',id]);return structuredClone(job);},
  saveJob:async value=>{calls.push(['persist',value.id]);job=structuredClone(value);}};
 const rec=new Reconciler(store,{owner:'fixture',adapters:[],noGitHub:true,emit:async()=>{}});
 rec.currentHeadSha=async()=>f.head??null;
 const outcome=await rec.reconcile('1').then(value=>({ok:true,value}),
  error=>({ok:false,error:error.message}));
 await rec.close();
 return normalize({outcome,job});
}
function firstDiff(a,b,path='root'){
 if(typeof a!==typeof b||a===null||b===null)return JSON.stringify(a)===JSON.stringify(b)?null:{path,a,b};
 if(typeof a!=='object')return Object.is(a,b)?null:{path,a,b};
 for(const key of [...new Set([...Object.keys(a),...Object.keys(b)])].sort()){
  if(!(key in a)||!(key in b))return {path:path+'.'+key,a:a[key],b:b[key]};
  const diff=firstDiff(a[key],b[key],path+'.'+key);if(diff)return diff;
 }return null;
}
test('Reconciler.reconcile direct Node/Rust real entrypoint semantics',async()=>{
 const actual=rust(),expected=[];
 for(const f of cases)expected.push(await node(f));
 const differences=[];
 for(let i=0;i<cases.length;i++){
  const d=firstDiff(expected[i],{outcome:actual[i].outcome,job:actual[i].job});
  if(d)differences.push({case:i,...d});
 }
 assert.deepEqual(differences,[],JSON.stringify(differences,null,2));
 console.log('Verified',cases.length,'durable reconcile direct original Node/Rust cases');
});
