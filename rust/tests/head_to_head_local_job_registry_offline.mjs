// Offline and read-only Node-created SQLite inventory: direct ORIGINAL Node
// findJobIdSnapshot vs compiled Rust with no active writable WAL owner.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,chmodSync,existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {findJobIdSnapshot} from '../../dist/local-job-registry.js';
const root=resolve(import.meta.dirname,'../..');
const bin=join(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join(tmpdir(),'rust2-local-registry-offline-'));
const stores=join(temp,'stores');mkdirSync(stores);
const db=join(temp,'relay.sqlite');
const job=id=>({id,title:'Offline-'+id,repository:'offline',prNumber:0,
 projectRoot:join(temp,'offline'),state:'ACTIVE',tasks:[],plans:[],
 createdAt:'2026-11-20T00:00:00.000Z',updatedAt:'2026-11-20T00:00:00.000Z'});
test.after(()=>{
 chmodSync(temp,0o755);chmodSync(stores,0o755);
 if(existsSync(db))chmodSync(db,0o644);
 rmSync(temp,{force:true,recursive:true});
});
async function compare(id){
 let expected;
 try{
  const value=await findJobIdSnapshot(stores,id);
  expected={ok:true,value:value?{job:value.job,path:value.snapshot.path}:null};
 }catch(e){expected={ok:false,error:e.message};}
 const run=spawnSync(bin,[],{cwd:root,encoding:'utf8',
  input:JSON.stringify({op:'certLocalJobReadOnlySnapshot',directory:stores,jobId:id})+'\n',timeout:14000});
 assert.equal(run.status,0,run.stderr);
 const actual=JSON.parse(run.stdout.trim());
 if(expected.ok){assert.deepEqual(actual,expected,'offline ID '+id);}
 else{assert.equal(actual.ok,false,'must fail closed on invalid SQLite offline '+id);}
}
test('offline Node/Rust strictly read-only inventory without WAL/shared-memory owner',async()=>{
 for(const id of ['15','missing'])await compare(id);
 const scoped=new SQLiteRelayStore(db,'15');
 await scoped.saveJob(job('15'));
 scoped.close();
 assert.equal(existsSync(db),true);
 assert.equal(existsSync(db+'-shm'),false,'read-only test must have no shared-memory owner');
 assert.equal(existsSync(db+'-wal'),false,'test must use checkpointed offline database');
 for(const id of ['15','missing','0'])await compare(id);
 // Both readers must succeed with no writable directory and no running owner.
 chmodSync(db,0o444);chmodSync(stores,0o555);chmodSync(temp,0o555);
 for(const id of ['15','missing'])await compare(id);
 chmodSync(temp,0o755);chmodSync(stores,0o755);chmodSync(db,0o644);
});
