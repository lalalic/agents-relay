// Original Node src/local-merge-projection.ts vs actual Rust projection reducer
// through isolated local Git/bare-origin. Never uses network or live Relay.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {reconcileCompletedLocalDelivery} from '../../dist/local-merge-projection.js';
const binary=resolve('rust/target/debug/relay-rust2-parity');
const base=mkdtempSync(join(tmpdir(),'rust2-remote-projection-'));
const env={...process.env,GIT_AUTHOR_DATE:'2020-01-02T01:02:03+0000',
 GIT_COMMITTER_DATE:'2020-01-02T01:02:03+0000',GIT_TERMINAL_PROMPT:'0'};
function git(dir,...args){
 const p=spawnSync('git',['-C',dir,...args],{env,encoding:'utf8',timeout:12000});
 assert.equal(p.status,0,p.stderr||p.error?.message);
 return p.stdout.trim();
}
function repo(path,hasOrigin,scenario){
 mkdirSync(path,{recursive:true});
 git(path,'init','-q','-b','main');
 git(path,'config','user.name','Test');git(path,'config','user.email','test@example.invalid');
 writeFileSync(join(path,'base.txt'),'baseline\n');git(path,'add','.');git(path,'commit','-qm','base');
 const first=git(path,'rev-parse','main');
 if(hasOrigin){
  const origin=join(path,'../origin.git');mkdirSync(origin,{recursive:true});
  git(origin,'init','--bare','-q');
  git(path,'remote','add','origin',origin);
  if(scenario!=='origin-empty-main'){
   git(path,'push','-q','origin','main:refs/heads/main');
  }
  if(scenario==='origin-diverged'){
   git(path,'checkout','-qb','remote-only');
   writeFileSync(join(path,'remote.txt'),'remote changes only\n');
   git(path,'add','.');git(path,'commit','-qm','diverged origin main');
   git(path,'push','-q','origin','remote-only:refs/heads/main');
   git(path,'checkout','-q','main');
  }
 }
 git(path,'checkout','-qb','feature');
 writeFileSync(join(path,'feature.txt'),'feature\n');git(path,'add','.');git(path,'commit','-qm','feature');
 git(path,'checkout','-q','main');git(path,'merge','-q','--no-ff','-m','merge source','feature');
 const merged=git(path,'rev-parse','HEAD');
 if(scenario==='reset-local-main'){
   git(path,'reset','--hard',first);
 }
 return {merged,first};
}
const cases=[
 ['no-origin',false,()=>{}],
 ['origin-FF',true,()=>{}],
 ['already-succeeded',true,j=>j.remoteDelivery.status='succeeded'],
 ['already-skipped',false,j=>j.remoteDelivery.status='skipped'],
 ['exhausted',false,j=>j.remoteDelivery.status='exhausted'],
 ['Job-active',false,j=>j.state='ACTIVE'],
 ['missing-merge-status',false,j=>j.localMerge.status='failed'],
 ['missing-remote-marker',false,j=>{delete j.remoteDelivery;}],
 ['stale-merge-SHA',false,j=>j.remoteDelivery.mergedCommitSha='f'.repeat(40)],
 ['max-attempts',false,j=>j.remoteDelivery.attempts=5],
 ['processing-active-lease',false,j=>{j.remoteDelivery.status='processing';j.remoteDelivery.leaseUntil='2036-01-01T00:00:00.000Z'}],
 ['processing-expired-lease',false,j=>{j.remoteDelivery.status='processing';j.remoteDelivery.leaseUntil='2001-01-01T00:00:00.000Z'}],
 ['retry-not-due',false,j=>{j.remoteDelivery.status='failed';j.remoteDelivery.nextRetryAt='2036-01-01T00:00:00.000Z'}],
 ['retry-due',false,j=>{j.remoteDelivery.status='failed';j.remoteDelivery.nextRetryAt='2001-01-01T00:00:00.000Z'}],
 ['origin-empty-main',true,()=>{}],
 ['origin-diverged',true,()=>{}],
 ['reset-local-main',false,()=>{}],
];
function job(merged){return {id:'17',repository:'project',projectRoot:'/unverified',
 state:'COMPLETED',prNumber:0,createdAt:'2026-11-18T00:00:00.000Z',
 updatedAt:'2026-11-18T00:00:00.000Z',tasks:[],plans:[],
 localMerge:{status:'succeeded',targetRef:'refs/heads/main',sourceRef:'refs/heads/feature',mergedCommitSha:merged},
 remoteDelivery:{status:'pending',mergedCommitSha:merged,attempts:0}};}
function check(value,repo){
 const remote=value.remoteDelivery;
 return {jobState:value.state,localStatus:value.localMerge?.status,
  status:remote?.status,attempts:remote?.attempts,error:remote?.error,
  leaseToken:!!remote?.leaseToken,leaseUntil:!!remote?.leaseUntil,
  nextRetryAt:!!remote?.nextRetryAt,
  remoteHead:git(repo,...(['remote'].length?['rev-parse','main']:[]))};
}
async function runNode(job,repo){
 let current=structuredClone(job);
 const store={async mutateJob(_id,change){current=await change(structuredClone(current));return current;}};
 try{await reconcileCompletedLocalDelivery(store,current,repo);
  return {ok:true,value:current};}
 catch(error){return {ok:false,error:error.message};}
}
function runRust(job,repo){
 const proc=spawnSync(binary,[],{env,input:JSON.stringify({op:'nativeRemoteProjectionReconcile',job,repo})+'\n',encoding:'utf8',timeout:20000});
 assert.equal(proc.status,0,proc.stderr||proc.error?.message);
 return JSON.parse(proc.stdout.trim());
}
test.after(()=>rmSync(base,{recursive:true,force:true}));
test('original Node/Rust remote projection: 17 isolated Git/Graph state+retry+origin cases',async()=>{
 for(let i=0;i<cases.length;i++){
  const [name,hasOrigin,mutate]=cases[i];
  const left=join(base,`node-${i}`,'project'),right=join(base,`rust-${i}`,'project');
  const a=repo(left,hasOrigin,name),b=repo(right,hasOrigin,name);
  assert.deepEqual(a,b,`Git fixture hashes for ${name}`);
  const input=job(a.merged);mutate(input);
  const n=await runNode({...structuredClone(input),projectRoot:left},left);
  const r=runRust({...structuredClone(input),projectRoot:right},right);
  assert.equal(r.ok,n.ok,`${name}: rust ${JSON.stringify(r)} node ${JSON.stringify(n)}`);
  if(n.ok){
   const reduce=value=>({state:value.state,local:value.localMerge?.status,
      status:value.remoteDelivery?.status,attempts:value.remoteDelivery?.attempts,
      error:value.remoteDelivery?.error,nextRetry:!!value.remoteDelivery?.nextRetryAt,
      leaseToken:!!value.remoteDelivery?.leaseToken,leaseUntil:!!value.remoteDelivery?.leaseUntil});
   assert.deepEqual(reduce(r.value),reduce(n.value),`${name}: Node/Rust projection state`);
   if(hasOrigin){
    const remoteLeft=join(left,'../origin.git'),remoteRight=join(right,'../origin.git');
    const headMaybe=path=>{
     const p=spawnSync('git',['-C',path,'rev-parse','--verify','refs/heads/main'],
       {env,encoding:'utf8',timeout:10000});
     return p.status===0?p.stdout.trim():null;
    };
    assert.equal(headMaybe(remoteLeft),headMaybe(remoteRight),`${name}: actual remote main`);
   }
  }
 }
 console.log('17 exact Node/Rust remote delivery outcomes verified against disposable Git repositories');
});
