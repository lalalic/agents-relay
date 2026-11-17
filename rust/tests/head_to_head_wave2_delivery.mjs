// Integrator runner for seven direct Node/Rust differential scripts porting
// src/{local-git,delivery,host-I/O} modules; ensure official rust2 QA runs all.
// Each child gets a disposable store; never use canonical user lifecycle state.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo=resolve(fileURLToPath(new URL('../..',import.meta.url)));
const scripts=[
 'rust2-wave2-delivery-differential.mjs',
 'rust2-wave2-delivery-migration-differential.mjs',
 'rust2-wave2-delivery-oauth-differential.mjs',
 'rust2-wave2-delivery-helpers-differential.mjs',
 'rust2-wave2-delivery-managed-input-differential.mjs',
 'rust2-wave2-delivery-continuation-differential.mjs',
 'rust2-wave2-delivery-projection-differential.mjs',
];
for(const script of scripts){
 test(`Wave2 Delivery: ${script} matches original Node`,()=>{
   const stores=mkdtempSync(join(tmpdir(),'rust2-wave2-delivery-gate-'));
   try{
     const result=spawnSync(process.execPath,[join(repo,'test',script)],{
       cwd:repo,encoding:'utf8',timeout:120000,
       env:{...process.env,AGENTS_RELAY_STORE_DIR:stores},
     });
     assert.equal(result.status,0,`${script} failed: ${result.error?.message||''}\n${result.stdout}\n${result.stderr}`);
     assert.match(result.stdout,/PASS/,`${script} must report affirmative comparison evidence`);
   }finally{rmSync(stores,{recursive:true,force:true});}
 });
}
