import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {refreshTaskDependencies} from '../../dist/task-transitions.js';
const exe=resolve(import.meta.dirname,'../target/debug/agents-relay-rust');
const graph=resolve(import.meta.dirname,'../../workflow/task-lifecycle.mmd');
const stamp='2026-11-13T20:00:00.000Z';
function task(id,state,dependencies=[]){return {jobId:'91',id,parentTaskId:null,dependencies,capabilities:[],adapter:'orchestrator',input:'reconcile',state,
  attempt:0,maxAttempts:2,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1000,
  createdAt:stamp,updatedAt:stamp,continuation:null,continuationDeliveredAt:null};}
test('Rust Task dependency scheduler suggestions equal TS Graph reconciling Task states',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'relay-rust-authority-'));
  const db=join(dir,'relay.sqlite');let store;
  try{
    store=new SQLiteRelayStore(db);
    const job={id:'91',title:'Graph scheduler fixture',repository:'example',projectRoot:dir,
      state:'ACTIVE',prNumber:0,reviewEnabled:false,continuation:null,createdAt:stamp,updatedAt:stamp,
      tasks:[task('1','SUCCEEDED'),task('2','DRAFT',['1']),task('3','QUEUED',['2']),task('4','DRAFT')]};
    await store.saveJob(job);store.close();store=null;
    const result=spawnSync(exe,['scheduler','inspect','--graph',graph,'--db',db,'--job-id','91'],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const rust=JSON.parse(result.stdout);
    assert.deepEqual(rust.proposals.map(p=>[p.taskId,p.source,p.target]),[['2','DRAFT','QUEUED'],['3','QUEUED','DRAFT']]);
    // Compare to the existing TypeScript Task Graph's actual mutation behavior.
    const ts=structuredClone(job);refreshTaskDependencies(ts);
    for(const proposal of rust.proposals){
      const item=ts.tasks.find(t=>t.id===proposal.taskId);
      assert.equal(item.state,proposal.target,`Task ${proposal.taskId}`);
    }
    console.log('Rust scheduler proposal parity: Task dependencies and canonical Graph transitions');
  }finally{store?.close();rmSync(dir,{recursive:true,force:true});}
});
