import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createIsolatedEnvironment} from './harness.mjs';
import {SQLiteRelayStore} from '../../dist/relay-store.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {InMemoryStore} from '../../dist/store.js';
import {MemoryEventBus,eventFor} from '../../dist/events.js';
import {Reconciler,executionEventSource} from '../../dist/reconciler.js';

const now='2026-10-17T12:00:00.000Z';
const id='l3-ingress';
const task=(name,dependencies=[])=>({jobId:id,id:name,kind:'work',agentName:'implementation',adapter:'chatgpt',input:'scenario',output:{kind:'task_pr'},parentTaskId:null,dependencies,capabilities:[],state:dependencies.length?'DRAFT':'RUNNING',attempt:dependencies.length?0:1,maxAttempts:3,leaseOwner:dependencies.length?null:'sim',leaseExpiresAt:dependencies.length?null:'2099-01-01T00:00:00.000Z',executionId:dependencies.length?null:'exec-a',executionHistory:dependencies.length?[]:[{id:'exec-a',attempt:1,startedAt:now}],threadId:null,result:null,error:null,timeoutMs:900000,createdAt:now,updatedAt:now});

async function fixture(run) {
 const env=createIsolatedEnvironment('relay-l3-ingress-');
 const sqlite=new SQLiteRelayStore(join(env.storeDir,'relay.sqlite'),id);
 const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
 const bus=new MemoryEventBus();
 let reconciler;
 try {
  await store.saveJob({id,title:'L3 ingress simulator',repository:'local/isolated',prNumber:0,state:'ACTIVE',autoMerge:false,reviewEnabled:false,createdAt:now,updatedAt:now,tasks:[task('a'),task('b',['a'])]});
  reconciler=new Reconciler(store,{owner:'l3-test',adapters:[],eventBus:bus,maxConcurrent:0,noGitHub:true});
  const stop=await reconciler.watch(id);
  try {await run({store,bus,reconciler,sqlite,env});} finally {await stop();}
 } finally {await reconciler?.close();sqlite.close();env.cleanup();}
}

async function deliver(bus,type,execution='exec-a',taskId='a') {
 const event=eventFor(id,taskId,null,type,type==='task.failed'?'failed':'succeeded',type,'orchestrator',{}, {id:executionEventSource(id,taskId,execution)});
 await bus.publish(event);
 return event;
}

test('real production event bus ingress and reconciler persist causal dependency release in SQLite',async()=>fixture(async({store,bus,reconciler,sqlite})=>{
 const original=await store.load(id);
 assert.deepEqual(original.tasks.map(t=>t.state),['RUNNING','DRAFT']);
 await deliver(bus,'task.completed');
 await reconciler.idle();
 const saved=await store.load(id);
 assert.equal(saved.tasks[0].state,'SUCCEEDED');
 assert.equal(saved.tasks[1].state,'QUEUED');
 assert.equal(saved.tasks[0].result?.summary,'task.completed');
 assert.equal((await sqlite.loadJob(id)).tasks[1].state,'QUEUED');
 const repeated=await deliver(bus,'task.completed');
 await reconciler.idle();
 assert.equal((await sqlite.loadJob(id)).tasks[0].state,'SUCCEEDED');
 assert.equal((await sqlite.loadJob(id)).tasks[0].result?.summary,'task.completed');
 assert.equal((await reconciler.applyEvent({...repeated,event_id:'stale',source:{id:executionEventSource(id,'a','wrong-generation')}})).applied,false);
}));

test('deliberately broken ingress event fails the authoritative SQLite assertion',async()=>fixture(async({store,bus,reconciler})=>{
 await deliver(bus,'task.completed','wrong-generation');
 await reconciler.idle();
 const observed=await store.load(id);
 assert.equal(observed.tasks[0].state,'RUNNING');
 assert.throws(()=>assert.equal(observed.tasks[0].state,'SUCCEEDED'),/SUCCEEDED/);
}));
