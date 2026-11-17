// Direct Node/Rust differential for src/local-merge-lock.ts: real isolated filesystem locks, collision, stale recovery, owner-safe cleanup and errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync,spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,existsSync,readFileSync,writeFileSync,utimesSync,rmSync} from 'node:fs';
import {tmpdir,hostname} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {withLocalMergeLock} from '../../dist/local-merge-lock.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const binary=resolve(root,'rust/target/debug/relay-rust2-parity');
const name='refs/heads/main';
const lockPath=(dir,target)=>join(dir,'agents-relay-merge-'+createHash('sha256').update(target).digest('hex').slice(0,24)+'.lockdir');
function rust(request){
 const result=spawnSync(binary,[],{input:JSON.stringify({op:'withLocalMergeLock',...request})+'\n',encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,`Rust process failed ${result.error}: ${result.stderr}`);
 return JSON.parse(result.stdout.trim());
}
function temp(){return mkdtempSync(join(tmpdir(),'rust2-merge-lock-'))}
function nodeLock(dir,target,opts={}){
 try {
  const value=withLocalMergeLock(dir,target,()=>{
   const lock=lockPath(dir,target),owner=JSON.parse(readFileSync(join(lock,'owner.json'),'utf8'));
   const result={locked:existsSync(lock),ownerTarget:owner.targetRef,ownerHostValid:typeof owner.host==='string',ownerValid:Number.isInteger(owner.pid)};
   if(opts.mutateOwner)writeFileSync(join(lock,'owner.json'),'{"pid":1}');
   if(opts.failure)throw Error(opts.failure);
   return result;
  },opts.timeoutMs??15000);
  return {ok:true,value};
 } catch(error){return {ok:false,error:error.message};}
}

test('basic local merge lock matches Node, isolates refs and always releases on success/error',()=>{
 const dir=temp();
 try {
  for(const target of [name,'refs/heads/feature-one','refs/tags/release','branch/中文🙂',name]){
   assert.deepEqual(rust({commonDir:dir,targetRef:target}),nodeLock(dir,target));
   assert.equal(existsSync(lockPath(dir,target)),false);
  }
  for(const failure of ['expected failure','error with 中文🙂']){
   assert.deepEqual(rust({commonDir:dir,targetRef:name,failure}),nodeLock(dir,name,{failure}));
   assert.equal(existsSync(lockPath(dir,name)),false);
  }
  const ownerMismatch=nodeLock(dir,name,{mutateOwner:true});
  assert.equal(ownerMismatch.ok,true);
  assert.equal(existsSync(lockPath(dir,name)),true);
  rmSync(lockPath(dir,name),{recursive:true,force:true});
  const rustMismatch=rust({commonDir:dir,targetRef:name,mutateOwner:true});
  assert.deepEqual(rustMismatch,ownerMismatch);
  assert.equal(existsSync(lockPath(dir,name)),true);
  console.log('Verified 7 uncontended/failure cases plus 2 protected owner mutations');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

test('Rust blocked by Node owner and Node blocked by Rust owner',async()=>{
 const dir=temp();
 try {
  const nodeResult=withLocalMergeLock(dir,name,()=>{
   const blocked=rust({commonDir:dir,targetRef:name,timeoutMs:60});
   assert.deepEqual(blocked,{ok:false,error:'Local merge target locked: '+name});
   return true;
  });
  assert.equal(nodeResult,true);
  assert.equal(existsSync(lockPath(dir,name)),false);

  const child=spawn(binary,[],{stdio:['pipe','pipe','pipe']});
  let output='',stderr='';
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',part=>output+=part);child.stderr.on('data',part=>stderr+=part);
  child.stdin.end(JSON.stringify({op:'withLocalMergeLock',commonDir:dir,targetRef:name,holdMs:300})+'\n');
  let seen=false;
  for(let i=0;i<40;i++){
   if(existsSync(lockPath(dir,name))){seen=true;break;}
   await new Promise(resolve=>setTimeout(resolve,10));
  }
  assert.equal(seen,true,'Rust must own lock before Node tests contention');
  assert.deepEqual(nodeLock(dir,name,{timeoutMs:50}),{ok:false,error:'Local merge target locked: '+name});
  const code=await new Promise((resolve,reject)=>child.once('error',reject).once('close',resolve));
  assert.equal(code,0,stderr);
  assert.equal(JSON.parse(output.trim()).ok,true);
  assert.equal(existsSync(lockPath(dir,name)),false);
  console.log('Verified both Node→Rust and Rust→Node cross-process contention');
 }finally{rmSync(dir,{recursive:true,force:true})}
});

function precreate(dir,target,owner,ageMs=5000){
 const lock=lockPath(dir,target);mkdirSync(lock);
 if(owner!==undefined)writeFileSync(join(lock,'owner.json'),owner);
 const stamp=new Date(Date.now()-ageMs);utimesSync(lock,stamp,stamp);
}
test('stale/corrupt/orphaned locks recover, but a live current PID never gets reaped',()=>{
 let checked=0;
 const cases=[
  {owner:undefined,shouldPass:true},
  {owner:'{broken',shouldPass:true},
  {owner:JSON.stringify({pid:999999999,host:hostname(),startedAt:'2020-01-01T00:00:00.000Z',targetRef:name}),shouldPass:true},
  {owner:undefined,ageMs:150,shouldPass:false},
  {owner:JSON.stringify({pid:process.pid,host:hostname(),startedAt:'2020-01-01T00:00:00.000Z',targetRef:name}),shouldPass:false},
  {owner:JSON.stringify({pid:999999999,host:'remote.other.host',startedAt:'2020-01-01T00:00:00.000Z',targetRef:name}),shouldPass:false},
 ];
 for(const fixture of cases){
  const nDir=temp(),rDir=temp();
  try {
   precreate(nDir,name,fixture.owner,fixture.ageMs??5000);precreate(rDir,name,fixture.owner,fixture.ageMs??5000);
   const expected=nodeLock(nDir,name,{timeoutMs:90});
   const actual=rust({commonDir:rDir,targetRef:name,timeoutMs:90});
   assert.deepEqual(actual,expected,`Stale case ${checked}`);
   assert.equal(actual.ok,fixture.shouldPass);
   checked++;
  }finally{rmSync(nDir,{recursive:true,force:true});rmSync(rDir,{recursive:true,force:true})}
 }
 console.log(`Verified ${checked} stale-or-live recovery/timeout cases`);
});
