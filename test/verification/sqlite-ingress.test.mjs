import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createIsolatedEnvironment, classifyObservedTrace } from './harness.mjs';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { Reconciler } from '../../dist/reconciler.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { executionEventSource } from '../../dist/reconciler.js';

test('L3 real ingress commits correct execution once to isolated SQLite across restart', async () => {
  const isolated = createIsolatedEnvironment();
  const sqlitePath = join(isolated.root, 'relay.sqlite');
  const now = new Date().toISOString();
  const task = {
    jobId:'scenario', id:'task-1', kind:'work',priority:'P1',storySize:'S',
    agentName:'implementation',parentTaskId:null,dependencies:[],capabilities:[],
    adapter:'chatgpt',input:'fixture',output:{kind:'task_pr'},state:'RUNNING',
    attempt:1,maxAttempts:3,leaseOwner:'fixture',leaseExpiresAt:now,
    executionId:'actual',threadId:null,result:null,error:null,timeoutMs:900000,
    createdAt:now,updatedAt:now,executionHistory:[{id:'actual',attempt:1,startedAt:now}]
  };
  let sqlite = new SQLiteRelayStore(sqlitePath, 'scenario');
  let store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);
  await store.saveJob({
    id:'scenario',repository:'test/fixture',prNumber:0,title:'isolated workflow',
    state:'ACTIVE',executionMode:'fixed',autoMerge:false,reviewEnabled:false,
    createdAt:now,updatedAt:now,tasks:[task]
  });
  const runner = new Reconciler(store,{owner:'sqlite-e2e',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
  const send = async (executionId, eventId) => {
    const event = eventFor('scenario','task-1',null,'task.completed','succeeded','done','orchestrator',
      {summary:'mock external result', validation:'pass'},
      {id:executionEventSource('scenario','task-1',executionId)});
    event.event_id = eventId;
    await runner.handleEvent(event);
  };
  try {
    await send('stale','stale-1');
    assert.equal((await store.load('scenario')).tasks[0].state,'RUNNING');
    await send('actual','accepted-1');
    await send('actual','accepted-1');
    assert.equal((await store.load('scenario')).tasks[0].state,'SUCCEEDED');
    await runner.close();
    sqlite.close();
    sqlite = new SQLiteRelayStore(sqlitePath,'scenario');
    store = new LocalAuthorityDurableStore(sqlite,new InMemoryStore(),undefined,true);
    const persisted = await store.load('scenario');
    assert.equal(persisted.tasks[0].state,'SUCCEEDED');
    assert.equal(persisted.tasks.length,1);
    const scenario = {id:'sqlite-ingress',category:'L3',
      expectedTrace:['stale-rejected','terminal-accepted'],expectedTerminal:'ACTIVE'};
    const observed = await classifyObservedTrace(scenario,
      ['stale-rejected','terminal-accepted'],{loadDurableState:()=>store.load('scenario')});
    assert.equal(observed.outcome,'PASS');
  } finally {
    await runner.close().catch(()=>{});
    sqlite.close();
    isolated.cleanup();
  }
});
