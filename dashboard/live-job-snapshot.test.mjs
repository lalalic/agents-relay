import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source=readFileSync(new URL('./dashboard.js',import.meta.url),'utf8');
const start=source.indexOf('function isFreshEnough(');
const end=source.indexOf('\nconst stream=',start);
const helpers=source.slice(start,end);

function harness(initial=[]){
  const context={jobs:initial.map(job=>({...job})),jobSelectionKey:job=>String(job.repository||'')+'|'+String(job.id||''),dedupeJobs:entries=>entries};
  vm.runInNewContext(helpers+';globalThis.api={jobs,isFreshEnough,normalizeJobSnapshot,mergeJobSnapshots,mergeJobList,applyStatePatch,upsertFreshJob};',context);
  return context.api;
}

test('incomplete, duplicate and stale SSE snapshots preserve the latest durable metadata and status',()=>{
  const api=harness([{id:'7',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:00:00Z',tasks:[{id:'1',state:'SUCCEEDED',result:{summary:'kept'}}],publication:{version:'2.0.259',sha:'a'.repeat(40)}}]);
  api.upsertFreshJob({id:'7',repository:'relay',state:'COMPLETED',updatedAt:'2026-11-25T10:01:00Z',tasks:[],publication:null,publicationFailure:null,publicationObservedAt:null});
  assert.equal(api.jobs[0].runtimeStatus,'COMPLETED');
  assert.equal(api.jobs[0].publication.version,'2.0.259');
  assert.equal(api.jobs[0].tasks[0].result.summary,'kept');
  api.upsertFreshJob({id:'7',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T09:59:00Z'});
  assert.equal(api.jobs[0].state,'COMPLETED');
  api.upsertFreshJob({id:'7',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T10:01:00Z'});
  assert.equal(api.jobs[0].state,'COMPLETED');
  api.upsertFreshJob({id:'7',repository:'relay',state:'COMPLETED',updatedAt:'2026-11-25T10:01:00Z'});
  assert.equal(api.jobs[0].runtimeStatus,'COMPLETED');
  api.upsertFreshJob({id:'7',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T10:02:00Z'});
  assert.equal(api.jobs[0].state,'COMPLETED');
  assert.equal(api.jobs[0].updatedAt,'2026-11-25T10:00:00Z');
});

test('publication and merge metadata clear only with a newer authoritative observation',()=>{
  const api=harness([{id:'17',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:00:00Z',publication:{version:'2.0.259'},publicationFailure:{stage:'push'},publicationObservedAt:'2026-11-25T09:00:00Z'}]);
  api.upsertFreshJob({id:'17',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:01:00Z',publication:null,publicationFailure:null,publicationObservedAt:'2026-11-25T08:00:00Z'});
  assert.equal(api.jobs[0].publication.version,'2.0.259');
  assert.equal(api.jobs[0].publicationFailure.stage,'push');
  api.upsertFreshJob({id:'17',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:02:00Z',publication:{version:'2.0.260'},publicationFailure:null,publicationObservedAt:'2026-11-25T11:00:00Z'});
  assert.equal(api.jobs[0].publication.version,'2.0.260');
  assert.equal(api.jobs[0].publicationFailure,null);
});

test('older publication observation cannot replace metadata during a newer Job refresh',()=>{
  const api=harness([{id:'18',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:00:00Z',publication:{version:'2.0.260',sha:'b'.repeat(40)},publicationFailure:null,publicationObservedAt:'2026-11-25T11:00:00Z'}]);
  api.upsertFreshJob({id:'18',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T12:00:00Z',publication:{version:'2.0.259',sha:'a'.repeat(40)},publicationFailure:{stage:'old-push'},publicationObservedAt:'2026-11-25T10:30:00Z'});
  assert.equal(api.jobs[0].updatedAt,'2026-11-25T10:00:00Z');
  assert.equal(api.jobs[0].publication.version,'2.0.260');
  assert.equal(api.jobs[0].publicationFailure,null);
  assert.equal(api.jobs[0].publicationObservedAt,'2026-11-25T11:00:00Z');
  api.upsertFreshJob({id:'18',repository:'relay',state:'COMPLETED',updatedAt:'2026-11-25T13:00:00Z',publication:{version:'2.0.261',sha:'c'.repeat(40)},publicationFailure:null,publicationObservedAt:'2026-11-25T12:30:00Z'});
  assert.equal(api.jobs[0].publication.version,'2.0.261');
});

test('publication without an observation timestamp cannot overwrite verified metadata',()=>{
  const api=harness([{id:'19',repository:'relay',state:'COMPLETED',updatedAt:'2026-11-25T10:00:00Z',publication:{version:'2.0.260'},publicationFailure:null,publicationObservedAt:'2026-11-25T11:00:00Z'}]);
  api.upsertFreshJob({id:'19',repository:'relay',state:'COMPLETED',updatedAt:'2026-11-25T12:00:00Z',publication:{version:'2.0.259'},publicationFailure:{stage:'push'}});
  assert.equal(api.jobs[0].publication.version,'2.0.260');
  assert.equal(api.jobs[0].publicationFailure,null);
  assert.equal(api.jobs[0].publicationObservedAt,'2026-11-25T11:00:00Z');
});

test('terminal snapshots normalize transient and absent runtime status; meaningful failure remains',()=>{
  const api=harness();
  for(const runtimeStatus of [undefined,'IDLE','RUNNING','QUEUED','WAITING','REVIEWING','BLOCKED']){
    api.upsertFreshJob({id:String(api.jobs.length+1),repository:'relay',state:'COMPLETED',runtimeStatus,updatedAt:'2026-11-25T10:00:00Z'});
    assert.equal(api.jobs.at(-1).runtimeStatus,'COMPLETED');
  }
  api.upsertFreshJob({id:'failure',repository:'relay',state:'COMPLETED',runtimeStatus:'FAILED',updatedAt:'2026-11-25T10:00:00Z'});
  assert.equal(api.jobs.at(-1).runtimeStatus,'FAILED');
  api.upsertFreshJob({id:'merge',repository:'relay',state:'COMPLETED',runtimeStatus:'MERGE_PENDING',updatedAt:'2026-11-25T10:00:00Z'});
  assert.equal(api.jobs.at(-1).runtimeStatus,'MERGE_PENDING');
  api.upsertFreshJob({id:'exceptional',repository:'relay',state:'COMPLETED',runtimeStatus:'IDLE',updatedAt:'2026-11-25T10:00:00Z'});
  api.upsertFreshJob({id:'exceptional',repository:'relay',state:'COMPLETED',runtimeStatus:'MERGE_PENDING',updatedAt:'2026-11-25T10:01:00Z'});
  assert.equal(api.jobs.at(-1).runtimeStatus,'MERGE_PENDING');
});

test('refresh race rejects snapshots without timestamps and older timestamped responses',()=>{
  const api=harness([{id:'9',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T10:00:00Z'}]);
  api.upsertFreshJob({id:'9',repository:'relay',state:'COMPLETED',runtimeStatus:'COMPLETED',updatedAt:'2026-11-25T10:02:00Z'});
  api.upsertFreshJob({id:'9',repository:'relay',state:'ACTIVE',runtimeStatus:'IDLE'});
  api.upsertFreshJob({id:'9',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T10:01:00Z'});
  assert.equal(api.jobs[0].state,'COMPLETED');
  assert.equal(api.jobs[0].runtimeStatus,'COMPLETED');
  const refreshed=api.mergeJobList([{id:'9',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T10:01:00Z'}],api.jobs);
  assert.equal(refreshed[0].state,'COMPLETED');
});

test('SSE state patches retain repository and cannot mutate another Job',()=>{
  const api=harness([{id:'12',repository:'relay',state:'ACTIVE',runtimeStatus:'RUNNING',updatedAt:'2026-11-25T10:00:00Z'}]);
  assert.equal(api.applyStatePatch({jobId:'12',repository:'other',jobState:'COMPLETED',jobUpdatedAt:'2026-11-25T10:01:00Z'}),false);
  assert.equal(api.applyStatePatch({jobId:'12',repository:'relay',jobState:'COMPLETED',jobUpdatedAt:'2026-11-25T10:01:00Z'}),true);
  assert.equal(api.jobs[0].runtimeStatus,'COMPLETED');
  api.applyStatePatch({jobId:'12',repository:'relay',jobState:'ACTIVE',jobUpdatedAt:'2026-11-25T10:02:00Z'});
  assert.equal(api.jobs[0].state,'COMPLETED');
});
