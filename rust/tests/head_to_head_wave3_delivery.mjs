// Wave3 Delivery permanent official verification entrypoint.
// Every child compares authoritative Node modules with Rust using disposable
// paths and fake identity endpoints, never a production store or service.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
for(const name of ['cleanup','auth','managed-resolver','dag','merge-facts']){
  test('Wave3 Delivery '+name+' matches original Node',()=>{
    const store=mkdtempSync(join(tmpdir(),'rust2-wave3-delivery-'));
    try{
      const result=spawnSync(process.execPath,
        [join(root,'test/rust2-wave3-delivery-'+name+'-differential.mjs')],{
        cwd:root,encoding:'utf8',timeout:120_000,
        env:{...process.env,AGENTS_RELAY_STORE_DIR:store},
      });
      assert.equal(result.status,0,
        name+' failed: '+(result.error?.message||'')+'\n'+result.stdout+'\n'+result.stderr);
      assert.match(result.stdout,/PASS Rust2 Wave3/,
        name+' must report actual Node/Rust differential proof');
    }finally{rmSync(store,{recursive:true,force:true});}
  });
}
