import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const dist=process.env.RELAY_A_DIST;
const make=async run=>{
 const {DurableWorkflowPublication}=await import(pathToFileURL(join(dist,'workflow/durable-publication.js')).href);
 const dir=mkdtempSync(join(tmpdir(),'relay-outbox-proof-'));
 const path=join(dir,'store.sqlite');let db=new DatabaseSync(path);
 try{
  db.exec('CREATE TABLE transition_state(id TEXT PRIMARY KEY, state TEXT NOT NULL)');
  const reopen=()=>{db.close();db=new DatabaseSync(path);return {db,outbox:new DurableWorkflowPublication(db)};};
  await run({db,outbox:new DurableWorkflowPublication(db),reopen});
 }finally{try{db.close();}catch{}rmSync(dir,{recursive:true,force:true});}
};
test('A atomic transaction: enqueue collision rolls back transition and keeps prior event', {skip:!dist},async()=>make(async({db,outbox})=>{
 outbox.enqueue('same-key','original',{n:1});
 assert.throws(()=>outbox.commitTransitionAndEvents(()=>db.prepare('INSERT INTO transition_state VALUES(?,?)').run('job','COMPLETED'),[{key:'same-key',eventId:'different',payload:{n:2}}]),/collision/);
 assert.equal(db.prepare('SELECT state FROM transition_state WHERE id=?').get('job'),undefined);
 assert.deepEqual(outbox.pending(),[{key:'same-key',eventId:'original',payload:{n:1}}]);
}));
test('A atomic transition and event survive SQLite restart together', {skip:!dist},async()=>make(async ({db,outbox,reopen})=>{
 outbox.commitTransitionAndEvents(()=>db.prepare('INSERT INTO transition_state VALUES(?,?)').run('job','ACTIVE'),[{key:'job/recovered',eventId:'task.recovered',payload:{job:'job'}}]);
 const next=reopen();
 assert.equal(next.db.prepare('SELECT state FROM transition_state WHERE id=?').get('job').state,'ACTIVE');
 assert.equal(next.outbox.pending().length,1);
}));
test('A publish-before-ack crash replays same event key; consumer must enforce dedup', {skip:!dist},async()=>make(async ({outbox,reopen})=>{
 outbox.enqueue('job/event-1','objective.verified',{job:'job'});
 const delivered=[];const consumerSeen=new Set();
 await assert.rejects(outbox.replay(async event=>{
  delivered.push(event.key);
  if(!consumerSeen.has(event.key))consumerSeen.add(event.key);
  throw new Error('crash after publishing before ack');
 }),/crash/);
 const next=reopen();
 assert.equal(next.outbox.pending().length,1);
 await next.outbox.replay(async event=>{delivered.push(event.key);consumerSeen.add(event.key);});
 assert.deepEqual(delivered,['job/event-1','job/event-1']);
 assert.equal(consumerSeen.size,1);
 assert.equal(next.outbox.pending().length,0);
}));
