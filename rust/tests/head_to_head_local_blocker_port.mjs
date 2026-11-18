// Original Node LocalAuthority DurableStore cross-Job blocker workflow versus
// Rust Graph + two independent SQLite DBs. No production Jobs or remote writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-blocker-node-diff-'));
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
const now='2026-11-17T12:00:00.000Z';
const job=(id,repository,prNumber,state='ACTIVE')=>({
 id,repository,prNumber,state,title:'Blocker port fixture',updatedAt:'2026-01-01T00:00:00.000Z',
 tasks:[],plans:[]
});
const make=(options={})=>{
 const blocker=job('40','fixture/blocker',12,options.blockerState??'COMPLETED');
 if(options.blockerMode)blocker.blockerResolutionMode=options.blockerMode;
 const dependent=job('41','fixture/dependent',13,'ACTIVE');
 dependent.tasks.push({
  id:'71',jobId:options.mismatchedJob?'99':'41',
  kind:'work',agentName:'developer',title:'Local fixture',
  state:options.taskState??'DRAFT',
  attempt:options.attempt??0,maxAttempts:3,
  updatedAt:'2026-01-01T00:00:00.000Z',
  error:options.taskState==='FAILED'?'recoverable':'',
  dependencies:[]
 });
 return {op:'apiLocalBlockerPorts',blocker,dependent,
  target:{repository:'fixture/dependent',prNumber:13,jobId:'41',
   taskId:options.invalidTask?'missing':'71',
   ...(options.resolutionMode?{resolutionMode:options.resolutionMode}:{})},
  now,steps:options.steps??['register','resolve-merge'],
  graphDirectory:join(root,'workflow')};
};
const cases=[
 make({}),make({blockerState:'ACTIVE'}),make({blockerState:'DRAFT'}),
 make({steps:['register','register','resolve-merge']}),
 make({steps:['register','resolve-merge','resolve-merge']}),
 make({resolutionMode:'verified',steps:['register','resolve-merge','resolve-verified']}),
 make({resolutionMode:'merge',blockerMode:'verified'}),
 make({taskState:'FAILED'}),make({taskState:'BLOCKED'}),
 make({taskState:'QUEUED'}),make({taskState:'SUCCEEDED'}),
 make({invalidTask:true}),make({mismatchedJob:true}),
 make({steps:['resolve-merge']}),
 make({steps:['register','advance-attempt','resolve-merge']}),
 make({steps:['register','advance-attempt','resolve-verified']}),
];
function canonical(value){
 if(typeof value==='string') {
  return value
   .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z/g,'<timestamp>')
   .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi,'<uuid>');
 }
 if(Array.isArray(value))return value.map(canonical);
 if(value && typeof value==='object')return Object.fromEntries(
  Object.entries(value).map(([key,v])=>[key,canonical(v)]));
 return value;
}
async function node(c,i){
 const first=new SQLiteRelayStore(join(tmp,'b'+i+'.sqlite'));
 const second=new SQLiteRelayStore(join(tmp,'d'+i+'.sqlite'));
 const dependent=new LocalAuthorityDurableStore(second,new InMemoryStore(),undefined,true);
 const blocking=new LocalAuthorityDurableStore(first,new InMemoryStore(),
  (repo,pr)=>{if(repo==='fixture/dependent'&&pr===13)return dependent;
   throw Error('Related Job store fixture missing');},true);
 try{
  await blocking.saveJob(structuredClone(c.blocker));
  await dependent.saveJob(structuredClone(c.dependent));
  const stages=[];
  for(const step of c.steps){
   // Node stores use millisecond source timestamps for merge arbitration;
   // preserve a real happens-before interval across registration/resolution.
   if(step.startsWith('resolve-'))await new Promise(done=>setTimeout(done,4));
   let outcome;
   try{
    const value=step==='register'?await blocking.registerBlockerDependent('40',c.target):
     step==='resolve-merge'?await blocking.resolveBlockerDependents('40','merge'):
     step==='resolve-verified'?await blocking.resolveBlockerDependents('40','verified'):
     step==='advance-attempt'?await (async()=>{
       const job=await dependent.load('41');
       const task=job.tasks[0];
       task.attempt++;
       task.updatedAt='2099-01-01T00:00:00.000Z';
       await dependent.saveTask(task);
     })():undefined;
    outcome={ok:true,value:value??null};
   }catch(error){outcome={ok:false,error:error.message};}
   stages.push({step,outcome});
  }
  return {stages,blocker:await blocking.load('40'),dependent:await dependent.load('41')};
 }finally{first.close();second.close();}
}
test('original Node/Rust blocker registration, release and SQLite recovery',async()=>{
 const expected=[];for(let i=0;i<cases.length;i++)expected.push(canonical(await node(cases[i],i)));
 const process=spawnSync(bin,[],{cwd:root,
  input:cases.map(JSON.stringify).join('\n')+'\n',
  encoding:'utf8',timeout:120000,maxBuffer:20*1024*1024});
 assert.equal(process.status,0,process.stderr||process.error?.message);
 const actual=process.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,cases.length);
 const mismatches=[];
 for(let i=0;i<cases.length;i++){
  if(!actual[i].ok){mismatches.push({i,adapterError:actual[i].error});continue;}
  try{assert.deepEqual(canonical(actual[i].value),expected[i]);}
  catch{mismatches.push({i,scenario:cases[i].steps,
    expected:expected[i],rust:canonical(actual[i].value)});}
 }
 assert.deepEqual(mismatches,[],JSON.stringify(mismatches,null,2));
 console.log('Verified',cases.length,'Node/Rust Cross Job blocker SQLite cases');
});
