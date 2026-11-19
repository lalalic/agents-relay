// Both public src/local-job-registry.ts functions against the real same
// isolated SQLite database. No live Store, GitHub, or production Relay data.
import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,rmSync,chmodSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {findJobIdSnapshot,createJobIdRegistryResolver} from '../../dist/local-job-registry.js';
const root=resolve(import.meta.dirname,'../..');const binary=join(root,'rust/target/debug/relay-rust2-parity');
const temp=mkdtempSync(join('/tmp','r2-local-job-registry-'));
chmodSync(temp,0o755);const directory=join(temp,'stores');mkdirSync(directory);
test.after(()=>rmSync(temp,{recursive:true,force:true}));
const stamp='2026-11-18T19:00:00.000Z';
const fixtures=[
 ['101','ACTIVE'],['102','COMPLETED'],['103','CANCELLED'],['104','DRAFT'],
 ['105','PAUSED'],['106','ACTIVE']
];
const job=(id,state)=>({id,state,title:`fixture-${id}`,repository:`repo-${id}`,prNumber:0,
 projectRoot:join(temp,`repo-${id}`),tasks:[],plans:[],createdAt:stamp,updatedAt:stamp});
for(const [id,state]of fixtures){
 const scoped=new SQLiteRelayStore(join(temp,'relay.sqlite'),id);
 await scoped.saveJob(job(id,state));scoped.close();
}
// In production, the owning Relay daemon keeps a writable WAL connection
// and its shared memory open while read-only inventory consumers observe it.
const owningWriter=new SQLiteRelayStore(join(temp,'relay.sqlite'),'101');
test.after(()=>owningWriter.close());
async function original(id){
 const selected=await findJobIdSnapshot(directory,id);
 const cached=new Map();const resolver=createJobIdRegistryResolver(directory,cached,{noGitHub:true});
 const first=await resolver(id),second=await resolver(id);
 for(const db of cached.values())db.close();
 return {selected:selected?{job:selected.job,path:selected.snapshot.path}:null,
  resolved:first?{job:first.job,path:first.relay.path,scope:first.relay.scopeJobId}:null,
  sameInstance:first?.relay===second?.relay,cacheCount:cached.size};
}
function rust(id){
 const proc=spawnSync(binary,[],{cwd:root,input:JSON.stringify({op:'certLocalJobRegistry',jobId:id,directory})+'\n',encoding:'utf8',timeout:12000});
 assert.equal(proc.status,0,proc.stderr);return JSON.parse(proc.stdout.trim());
}
test('read-only immutable Job ID resolver source and cache reuse, Node/Rust',async()=>{
 for(const id of [...fixtures.map(pair=>pair[0]),'999','nonexistent','0',...Array.from({length:30},(_,i)=>String(200+i))]){
  const actual=rust(id);
  let expected;try{expected={ok:true,value:await original(id)};}catch(error){expected={ok:false,error:error.message};}
  assert.deepEqual(actual,expected,`Job ID ${id}`);
 }
});
