import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';

const exe=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
function call(db,command,...params) {
  const result=spawnSync(exe,['store',command,'--db',db,...params],{encoding:'utf8',maxBuffer:4*1024*1024});
  assert.equal(result.status,0,`rust store: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
const timestamp='2026-11-13T16:00:00.000Z';
const task=(jobId,id,dependencies=[])=>({
  jobId,id,parentTaskId:null,dependencies,capabilities:[],adapter:'orchestrator',input:'replay',
  state:dependencies.length?'DRAFT':'QUEUED',attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,
  executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,
  createdAt:timestamp,updatedAt:timestamp,continuation:null,continuationDeliveredAt:null
});
const job=(id)=>({id,title:`Rust parity ${id}`,repository:'local-repo',projectRoot:process.cwd(),prNumber:0,
  state:'ACTIVE',reviewEnabled:false,continuation:null,createdAt:timestamp,updatedAt:timestamp,
  tasks:[task(id,'1'),task(id,'2',['1'])]});

test('Rust SQLite reader matches live TypeScript RelayStore snapshots without mutating isolated DB',async()=>{
  const root=mkdtempSync(join(tmpdir(),'agents-relay-rust-sqlite-'));
  const db=join(root,'relay.sqlite');
  let store;
  try {
    store=new SQLiteRelayStore(db);
    await store.saveJob(job('100'));
    await store.saveJob(job('101'));
    const nodeJobs=await store.listJobs();
    assert.equal(nodeJobs.length,2);
    // Close the writer to ensure WAL state is committed before comparing data.
    store.close();store=null;
    const size=statSync(db).size;
    const listing=call(db,'list','--limit','20','--offset','0');
    assert.deepEqual(new Set(listing.map(x=>x.jobId)),new Set(['100','101']));
    for(const record of listing){
      const node=nodeJobs.find(j=>j.id===record.jobId);
      assert.equal(record.job.id,node.id);
      assert.equal(record.job.state,node.state);
      assert.deepEqual(record.job.tasks.map(x=>x.id),node.tasks.map(x=>x.id));
      assert.deepEqual(call(db,'get','--job-id',record.jobId),record);
    }
    assert.equal(call(db,'get','--job-id','missing'),null);
    assert.equal(call(db,'list','--limit','1','--offset','1').length,1);
    assert.equal(statSync(db).size,size,'Rust reader may not modify SQLite');
    console.log('Rust Store parity verified: 2 TS-created jobs, pagination, exact snapshots, read-only DB');
  } finally {store?.close();rmSync(root,{recursive:true,force:true});}
});
