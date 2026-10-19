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
