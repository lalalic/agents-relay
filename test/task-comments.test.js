import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { appendTaskComment, taskCommentContext } from '../dist/task-comments.js';
import { taskExecutionContext } from '../dist/task-context.js';
import { SQLiteRelayStore, mergeInboundJobSnapshot } from '../dist/relay-store.js';

const task = { id:'1', state:'RUNNING', executionId:'e1', input:'immutable', dependencies:[] };
test('Task comments append without mutating original input or execution', () => {
  const job={id:'j',repository:'r/r',tasks:[structuredClone(task)]};
  const a=appendTaskComment(job,'1','first');const b=appendTaskComment(job,'1','second');
  assert.notEqual(a.id,b.id);assert.deepEqual(job.tasks[0].comments.map(c=>c.text),['first','second']);
  assert.equal(job.tasks[0].input,'immutable');assert.equal(job.tasks[0].executionId,'e1');
  assert.match(taskCommentContext(job.tasks[0]),/first/);
  assert.deepEqual(taskExecutionContext(job,'1','e1').comments.map(c=>c.text),['first','second']);
  assert.throws(()=>appendTaskComment(job,'1','  '),/nonempty/);
  assert.throws(()=>appendTaskComment(job,'not-found','x'),/not found/);
});
test('SQLite atomic mutation serializes appended comments',async()=>{
  const store=new SQLiteRelayStore(':memory:');
  const job={id:'j',repository:'r/r',state:'ACTIVE',updatedAt:'2026-01-01T00:00:00Z',tasks:[structuredClone(task)],plans:[]};
  await store.saveJob(job);
  await Promise.all(Array.from({length:12},(_,i)=>store.mutateJob('j',j=>{appendTaskComment(j,'1','comment-'+i);return j;})));
  const saved=await store.loadJob('j');
  assert.equal(saved.tasks[0].comments.length,12);
  assert.equal(new Set(saved.tasks[0].comments.map(c=>c.id)).size,12);
  assert.equal(saved.tasks[0].input,'immutable');
});

test('state updates from stale snapshots cannot erase newly appended comments',async()=>{
  const sqlite=new SQLiteRelayStore(':memory:');
  const { LocalAuthorityDurableStore }=await import('../dist/local-authority-store.js');
  const { InMemoryStore }=await import('../dist/store.js');
  const store=new LocalAuthorityDurableStore(sqlite,new InMemoryStore());
  const timestamp='2026-01-01T00:00:00Z';
  const original={...task,jobId:'comment-job',state:'QUEUED',attempt:0,updatedAt:timestamp,createdAt:timestamp,executionId:null};
  await store.saveJob({id:'comment-job',repository:'r/r',title:'job',state:'ACTIVE',updatedAt:timestamp,createdAt:timestamp,tasks:[original],plans:[]});
  const stale=structuredClone(original);
  await store.mutateJob('comment-job',j=>{appendTaskComment(j,'1','must survive');return j;});
  await store.saveTask({...stale,state:'RUNNING',attempt:1,executionId:'next',updatedAt:'2026-01-02T00:00:00Z'});
  const saved=await store.load('comment-job');
  assert.deepEqual(saved.tasks[0].comments.map(c=>c.text),['must survive']);
  assert.equal(saved.tasks[0].state,'RUNNING');
});

test('inbound stale Task snapshot cannot remove durable comments',()=>{
  const older = { ...task, updatedAt:'2026-01-01T00:00:00Z', comments:[{id:'c1',text:'keep me',author:'cli',createdAt:'2026-01-01T00:00:00Z'}] };
  const newer = { ...task, updatedAt:'2026-01-02T00:00:00Z' };
  const merged=mergeInboundJobSnapshot({id:'j',updatedAt:older.updatedAt,tasks:[older]}, {id:'j',updatedAt:newer.updatedAt,tasks:[newer]});
  assert.deepEqual(merged.tasks[0].comments.map(c=>c.id),['c1']);
});
