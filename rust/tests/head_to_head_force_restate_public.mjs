// Original Node dist/force-restate.js is used without modifying its body.
// Its imported manual-plan dependency is replaced with a deterministic contract
// spy, compared directly to the public Rust force_restate facade. The same
// native facade is invoked by the real daemon's Graph/SQLite job.plan command.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,copyFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-original-force-'));
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
writeFileSync(join(tmp,'package.json'),JSON.stringify({type:'module'}));
copyFileSync(join(root,'dist/force-restate.js'),join(tmp,'force-restate.js'));
writeFileSync(join(tmp,'manual-plan.js'),`
export async function executeManualPlan(store,jobId,guidance,timeoutMs,launchPlanner,forceRestate){
  if(store.fail)throw Error(store.fail);
  await launchPlanner({id:jobId},{id:'round'});
  return {store:store.marker,jobId,guidance:guidance??null,timeoutMs,
    forceRestate,launcherInvoked:true};
}`);
const {executeForceRestate}=await import('file://'+join(tmp,'force-restate.js'));
const inputs=[];
let seed=0x3924129;function rand(){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;return seed>>>0;}
for(let i=0;i<65;i++)inputs.push({op:'certForceRestate',
  jobId:String(rand()%999999),guidance:rand()%3===0?null:['再做','new plan','','Verify all'][rand()%4],
  timeoutMs:rand()%900000+1,marker:'store-'+i,
  fail:i%9===0?'manual Plan transaction rejected':null});
test('65 original Node/Rust Force Restate public facade forwarding and errors',async()=>{
 const differences=[];
 for(const [i,x] of inputs.entries()){
  let original;
  try{original={ok:true,value:await executeForceRestate({
    store:{marker:x.marker,fail:x.fail},jobId:x.jobId,
    guidance:x.guidance??undefined,timeoutMs:x.timeoutMs,
    launchPlanner:async()=>{}})};}
  catch(e){original={ok:false,error:e.message};}
  const proc=spawnSync(bin,[],{cwd:root,input:JSON.stringify(x)+'\n',
    encoding:'utf8',timeout:10000});
  assert.equal(proc.status,0,proc.stderr);
  const rust=JSON.parse(proc.stdout.trim());
  try{assert.deepEqual(rust,original);}
  catch{differences.push({i,x,original,rust});}
 }
 assert.deepEqual(differences.slice(0,3),[],`${differences.length} original Node/Rust Force Restate mismatches`);
 console.log('Verified',inputs.length,'original Node/Rust Force Restate public facade cases');
});
