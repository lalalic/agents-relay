import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {DurableWorkflowPublication} from '../dist/workflow/durable-publication.js';
test('crash before publish replays pending event after reopening SQLite',async()=>{
 const db=new DatabaseSync(':memory:');
 new DurableWorkflowPublication(db).enqueue('attempt/1','objective.verified',{job:'1'});
 const restarted=new DurableWorkflowPublication(db);
 const published=[];
 assert.equal(await restarted.replay(async event=>published.push(event)),1);
 assert.equal(await restarted.replay(async event=>published.push(event)),0);
 assert.equal(published.length,1);
 assert.throws(()=>restarted.enqueue('attempt/1','another',{}),/collision/);
});
test('failed publication remains pending for replay',async()=>{
 const db=new DatabaseSync(':memory:');const outbox=new DurableWorkflowPublication(db);
 outbox.enqueue('key','event',{ok:true});
 await assert.rejects(outbox.replay(async()=>{throw new Error('crash')}),/crash/);
 assert.equal(outbox.pending().length,1);
 assert.equal(await outbox.replay(async()=>{}),1);
});
test('SQLite state transition and outbox are atomic on enqueue collision', () => {
 const db=new DatabaseSync(':memory:'); db.exec('CREATE TABLE state(value TEXT NOT NULL); INSERT INTO state VALUES (\'ACTIVE\')');
 const outbox=new DurableWorkflowPublication(db);
 outbox.commitTransitionAndEvents(()=>db.exec("UPDATE state SET value='COMPLETED'"),[{key:'k',eventId:'ok',payload:{x:1}}]);
 assert.equal(db.prepare('SELECT value FROM state').get().value,'COMPLETED');
 db.exec("UPDATE state SET value='ACTIVE'");
 assert.throws(()=>outbox.commitTransitionAndEvents(()=>db.exec("UPDATE state SET value='COMPLETED'"),[{key:'k',eventId:'different',payload:{x:2}}]),/collision/);
 assert.equal(db.prepare('SELECT value FROM state').get().value,'ACTIVE');
 assert.equal(outbox.pending().length,1);
});
test('durable event key enables idempotent consumer across publish-before-ack crash',async()=>{
 const db=new DatabaseSync(':memory:');const outbox=new DurableWorkflowPublication(db);
 outbox.enqueue('stable-key','changed',{value:1});
 const received=new Set();let notifications=0;
 await assert.rejects(outbox.replay(async event=>{if(!received.has(event.key)){received.add(event.key);notifications++}throw new Error('ack crashed')}),/ack crashed/);
 assert.equal(outbox.pending().length,1);
 await outbox.replay(async event=>{if(!received.has(event.key)){received.add(event.key);notifications++}});
 assert.equal(notifications,1);
});
