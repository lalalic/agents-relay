// Node source: src/adapters.ts ensureChatGptWebHelmReady. Compare actual Node
// owned-process execution against Rust injected-equivalent CLI observations;
// fake local executables only, never WebHelm sessions or a real provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,chmodSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {ensureChatGptWebHelmReady} from '../../dist/adapters.js';
const root=resolve(import.meta.dirname,'../..');
const binary=join(root,'rust/target/debug/relay-rust2-parity');
const tmp=mkdtempSync(join(tmpdir(),'rust2-webhelm-preflight-'));
test.after(()=>rmSync(tmp,{recursive:true,force:true}));
const fixtures=[];
const profiles=[
 '{"platform":"chatgpt"}',
 'diagnostic message\n{"platform":"chatgpt"}',
 '{"platform":"z"}',
 '{"platform":null}',
 '{"other":"chatgpt"}',
 'not valid JSON',
 'warn\n{"platform":"chatgpt"}\n',
];
const statuses=[
 '{"daemon":{"running":true}}',
 '{"daemon":{"running":false}}',
 '{"daemon":{"running":1}}',
 '{"daemon":null}',
 '{"other":true}',
 'garbage',
 'warn\n{"daemon":{"running":true}}',
];
for(const profileOutput of profiles)
 for(const statusOutput of statuses)
   fixtures.push({op:'webhelmReadyParity',profileOutput,statusOutput});
function shellLiteral(value){return "'"+value.replaceAll("'","'\\''")+"'";}
async function original(fixture,index){
 const path=join(tmp,'fake-'+index+'.sh'),calls=join(tmp,'calls-'+index+'.log');
 writeFileSync(path,`#!/bin/sh\nprintf '%s\\n' "$*" >> ${shellLiteral(calls)}\nif [ "$1" = "platform" ]; then printf '%s\\n' ${shellLiteral(fixture.profileOutput)}; else printf '%s\\n' ${shellLiteral(fixture.statusOutput)}; fi\n`);
 chmodSync(path,0o700);
 let outcome;
 try{await ensureChatGptWebHelmReady(path);outcome={ok:true};}
 catch(error){outcome={ok:false,error:error.message};}
 const observed=readFileSync(calls,'utf8').trim().split('\n');
 return {calls:observed,outcome};
}
test('49 actual Node owned-process WebHelm preflight vs Rust status parser cases',async()=>{
 const expected=[];
 for(const [index,fixture] of fixtures.entries())expected.push(await original(fixture,index));
 const run=spawnSync(binary,[],{cwd:root,encoding:'utf8',
   input:fixtures.map(JSON.stringify).join('\n')+'\n',timeout:120000,maxBuffer:2*1024*1024});
 assert.equal(run.status,0,run.stderr||run.error?.message);
 const actual=run.stdout.trim().split('\n').map(JSON.parse);
 assert.equal(actual.length,fixtures.length);
 const mismatch=[];
 for(let i=0;i<fixtures.length;i++){
  try{assert.deepEqual(actual[i],{ok:true,value:expected[i]});}
  catch{mismatch.push({fixture:fixtures[i],node:expected[i],rust:actual[i]});}
 }
 assert.deepEqual(mismatch.slice(0,7),[],`${mismatch.length} preflight mismatches`);
 console.log('Verified 49 actual Node WebHelm owned-process status observations against native Rust API');
});
