import test from './test-runtime.js';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SQLiteRelayStore} from '../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../dist/local-authority-store.js';
import {InMemoryStore} from '../dist/store.js';
import {managedReconciler} from './test-runtime.js';
import {MemoryEventBus} from '../dist/events.js';

const timestamp='2026-10-19T17:00:00.000Z';
const job={id:'outbox-production',title:'outbox production proof',repository:'local/isolated',prNumber:0,state:'ACTIVE',autoMerge:true,reviewEnabled:false,plans:[{id:'plan-1',round:1,status:'SUCCEEDED',trigger:{source:'initial'},objectiveStatus:'satisfied',plannerResult:{objective_status:'satisfied',next_tasks:[]}}],headSha:'head-immutable',createdAt:timestamp,updatedAt:timestamp,localMerge:{sourceRef:'refs/heads/source',targetRef:'refs/heads/main',sourceSha:'head-immutable',status:'pending',attempts:0},tasks:[{jobId:'outbox-production',id:'worker',kind:'work',agentName:'implementation',adapter:'chatgpt',output:{kind:'task_pr'},input:'done',dependencies:[],capabilities:[],parentTaskId:null,state:'SUCCEEDED',attempt:1,maxAttempts:3,executionId:null,leaseOwner:null,leaseExpiresAt:null,timeoutMs:900000,createdAt:timestamp,updatedAt:timestamp}]};

test('production Reconciler persists Graph-selected outcome and event atomically; restart drains after publish outage without repeating Git',async()=>{
 const folder=mkdtempSync(join(tmpdir(),'workflow-production-outbox-'));
 const path=join(folder,'authority.sqlite');
 let sqlite=new SQLiteRelayStore(path,'outbox-production');
 let store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 let attempts=0;const git=()=>{attempts++;return {sourceSha:'head-immutable',mergedCommitSha:'merged-once'};};
 const bus=new MemoryEventBus(); const original=bus.publish.bind(bus);let rejectNext=true;
 bus.publish=async event=>{if(event.type==='job.merge.succeeded'&&rejectNext){rejectNext=false;throw Error('transport unavailable after SQLite commit');}return original(event);};
 let runtime=managedReconciler(store,{owner:'outbox-test',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true,localMergeEffect:git,projectPathForJob:()=>folder});
 try{
  await store.saveJob(structuredClone(job));
  await assert.rejects(runtime.reconcile('outbox-production'),/transport unavailable/);
  assert.equal(attempts,1);
  const db=new DatabaseSync(path,{readOnly:true});
  const state=await sqlite.loadJob('outbox-production');
  assert.equal(state.localMerge.status,'succeeded');
  const rows=db.prepare("SELECT state,event_key,event_id FROM workflow_event_outbox").all();
  assert.equal(rows.length,1);assert.equal(rows[0].state,'pending');
  db.close();
  await runtime.close();sqlite.close();
  sqlite=new SQLiteRelayStore(path,'outbox-production');
  store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
  const observed=[];const unsubscribe=await bus.subscribeAll(async ev=>{if(ev.type==='job.merge.succeeded')observed.push(ev.event_id)});
  runtime=managedReconciler(store,{owner:'outbox-test',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true,localMergeEffect:git,projectPathForJob:()=>folder});
  await runtime.reconcile('outbox-production');
  await runtime.reconcile('outbox-production');
  await unsubscribe();
  assert.equal(attempts,1,'effect not re-executed on restart');
  assert.equal(observed.length,1,'pending event delivered once');
  assert.equal((await sqlite.loadJob('outbox-production')).state,'COMPLETED');
  const audit=new DatabaseSync(path,{readOnly:true});
  assert.equal(audit.prepare("SELECT COUNT(*) AS n FROM workflow_event_outbox WHERE state='published'").get().n,1);
  audit.close();
 }finally{await runtime.close();sqlite.close();rmSync(folder,{recursive:true,force:true});}
});
