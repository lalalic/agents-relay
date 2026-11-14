import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn,execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const binary=resolve(import.meta.dirname,'../target/debug/relay-worker-helper');
const parentScript=resolve(import.meta.dirname,'./fixtures/worker-helper-parent.mjs');
function start(dir,mode){
 const child=spawn(process.execPath,[parentScript,binary,dir,mode],{stdio:['ignore','pipe','pipe']});
 let output='',errors='';
 child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
 child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
 return {child,get output(){return output},get errors(){return errors}};
}
async function until(callback,timeout=6000){
 const limit=Date.now()+timeout;
 while(Date.now()<limit){const value=callback();if(value)return value;await delay(30);}
 throw new Error('timed out waiting for worker helper');
}
function isAlive(pid){
 try{
  const result=execFileSync('/bin/ps',['-p',String(pid),'-o','stat='],{encoding:'utf8',timeout:1500}).trim();
  return result!=='' && !result.startsWith('Z');
 }catch{return false;}
}
test('native helper streams started/finished protocol and preserves worker output',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'relay-helper-test-'));
 const run=start(folder,'normal');
 try{
  const text=await until(()=>run.output.includes('FINISHED ')?run.output:null);
  assert.match(text,/STARTED \d+/);
  const line=text.split('\n').find(x=>x.startsWith('FINISHED '));
  const result=JSON.parse(line.slice('FINISHED '.length));
  assert.equal(result.exitCode,0);
  assert.equal(result.timedOut,false);
  assert.equal(result.cancelled,false);
  assert.equal(readFileSync(join(folder,'worker.out'),'utf8'),'hello');
  assert.equal(readFileSync(join(folder,'worker.err'),'utf8'),'warn');
 }finally{run.child.kill('SIGKILL');rmSync(folder,{recursive:true,force:true});}
});
test('real SIGKILL of parent cancels worker and reaps the process group',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'relay-helper-test-'));
 const run=start(folder,'die');
 let pid=null;
 try{
  const text=await until(()=>run.output.match(/STARTED (\d+)/));
  pid=Number(text[1]);
  assert.ok(pid>1 && isAlive(pid));
  run.child.kill('SIGKILL');
  await until(()=>!isAlive(pid),5500);
  assert.ok(!isAlive(pid),'worker must not survive parent death');
 }finally{
  run.child.kill('SIGKILL');
  if(pid && isAlive(pid)){
    // Only test-owned exact process group; clean up after a failed test.
    try{process.kill(-pid,'SIGKILL');}catch{}
  }
  await delay(80);
  rmSync(folder,{recursive:true,force:true});
 }
});
