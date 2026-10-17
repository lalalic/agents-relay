import { join } from 'node:path';
import { createIsolatedEnvironment } from './harness.mjs';
import { SQLiteRelayStore } from '../../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../../dist/local-authority-store.js';
import { InMemoryStore } from '../../dist/store.js';
import { Reconciler } from '../../dist/reconciler.js';
import { MemoryEventBus, eventFor } from '../../dist/events.js';
import { executionEventSource } from '../../dist/reconciler.js';

/** Replay canonical external worker events through the real ingress into isolated SQLite. */
export async function replayIngress(fixture) {
  if (!fixture || !Array.isArray(fixture.events) || !fixture.events.length) throw new Error('nonempty events required');
  const isolated = createIsolatedEnvironment();
  const jobId = fixture.jobId || 'replay-fixture';
  const taskId = fixture.taskId || 'worker';
  const executionId = fixture.executionId || 'actual';
  const now = new Date().toISOString();
  const sqlitePath = join(isolated.root, 'replay.sqlite');
  const sqlite = new SQLiteRelayStore(sqlitePath, jobId);
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);
  const task = {jobId,id:taskId,kind:'work',priority:'P1',storySize:'S',agentName:'implementation',
    parentTaskId:null,dependencies:[],capabilities:[],adapter:'chatgpt',input:'fixture',output:{kind:'task_pr'},
    state:'RUNNING',attempt:1,maxAttempts:3,leaseOwner:'fixture',leaseExpiresAt:now,executionId,
    threadId:null,result:null,error:null,timeoutMs:900000,createdAt:now,updatedAt:now,
    executionHistory:[{id:executionId,attempt:1,startedAt:now}]};
  const runner = new Reconciler(store,{owner:'verification-replay',adapters:[],eventBus:new MemoryEventBus(),maxConcurrent:0});
  let closed = false;
  try {
    await store.saveJob({id:jobId,repository:'verification/isolated',prNumber:0,title:'replay',state:'ACTIVE',
      executionMode:'fixed',autoMerge:false,reviewEnabled:false,createdAt:now,updatedAt:now,tasks:[task]});
    const trace=[];
    for (let i=0;i<fixture.events.length;i++) {
      const item=fixture.events[i];
      if (!['task.started','task.completed','task.failed','task.progress','task.heartbeat'].includes(item.type))
        throw new Error('invalid worker event type: '+item.type);
      const source=executionEventSource(jobId,taskId,item.executionId || executionId);
      const event=eventFor(jobId,taskId,null,item.type,item.type==='task.failed'?'failed':'succeeded',
        item.message || item.type,'orchestrator',item.data || {},{id:source});
      event.event_id=item.eventId || `replay-${i}`;
      await runner.handleEvent(event);
      const snapshot=await store.load(jobId);
      trace.push({event:item.type,source,state:snapshot.tasks.find(x=>x.id===taskId).state});
    }
    const first=await store.load(jobId);
    await runner.close();sqlite.close();closed = true;
    const reopened = new SQLiteRelayStore(sqlitePath,jobId);
    try {
      const persisted=await new LocalAuthorityDurableStore(reopened,new InMemoryStore(),undefined,true).load(jobId);
      const actual=persisted.tasks.find(x=>x.id===taskId).state;
      if (actual !== first.tasks.find(x=>x.id===taskId).state) throw new Error('restart persistence mismatch');
      return {scenarioId:fixture.scenarioId || 'ingress-replay',category:'L3',outcome:actual===fixture.expectedTaskState?'PASS':'FAIL',
        expectedTaskState:fixture.expectedTaskState,actualTaskState:actual,jobState:persisted.state,trace,
        reason:actual===fixture.expectedTaskState?null:'DURABLE_STATE_MISMATCH',verifiedBy:'production-ingress-isolated-sqlite'};
    } finally {reopened.close();}
  } finally {await runner.close().catch(()=>{});if (!closed) sqlite.close();isolated.cleanup();}
}
