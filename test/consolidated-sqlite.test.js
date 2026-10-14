import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore, relayStorePath, relayJobStorePath } from '../dist/relay-store.js';
import { allocateEntityId } from '../dist/job-task-id-sequence.js';

test('single SQLite consolidation preserves independent Job records, outboxes and global sequences', async () => {
  const root = await mkdtemp(join(tmpdir(),'relay-unified-'));
  const source = join(root,'stores');
  const target = join(root,'candidate.sqlite');
  await mkdir(source);
  try {
    const a = new SQLiteRelayStore(relayStorePath(source,'example/first',9));
    const b = new SQLiteRelayStore(relayJobStorePath(source,'2'));
    const createdAt='2026-10-14T00:00:00.000Z';
    const makeJob=(id,repository,prNumber)=>({id,title:`Job ${id}`,repository,prNumber,objective:'fixture',state:'COMPLETED',executionMode:'fixed',continuation:null,createdAt,updatedAt:createdAt,tasks:[{id:'1',jobId:id,state:'SUCCEEDED'}],plans:[]});
    await a.saveJob(makeJob('1','example/first',9));
    await b.saveJob(makeJob('2','example/second',0));
    await a.enqueueProjection({idempotencyKey:'same-key',operation:'save_job',payload:{jobId:'1'}});
    await b.enqueueProjection({idempotencyKey:'same-key',operation:'save_job',payload:{jobId:'2'}});
    a.close(); b.close();
    assert.equal(allocateEntityId(source,'example/first','job',undefined,new Set(['1','2'])),'3');
    const result = spawnSync('python3',['scripts/consolidate-relay-sqlite.py',source,target],{encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    const details=JSON.parse(result.stdout);
    assert.equal(details.jobs,2);
    assert.ok((await stat(target)).size>0);
    const db=new DatabaseSync(target,{readOnly:true});
    assert.deepEqual(db.prepare('SELECT job_id FROM source_registry ORDER BY job_id').all().map(x=>x.job_id),['1','2']);
    assert.equal(db.prepare('SELECT COUNT(*) as n FROM job_snapshot').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) as n FROM projection_outbox').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) as n FROM projection_outbox WHERE id=1').get().n,2);
    assert.equal(db.prepare('SELECT COUNT(*) as n FROM projection_outbox WHERE idempotency_key=?').get('same-key').n,2);
    assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    db.close();
    const again=spawnSync('python3',['scripts/consolidate-relay-sqlite.py',source,target],{encoding:'utf8'});
    assert.notEqual(again.status,0);
    assert.match(again.stderr,/Destination exists/);
  } finally {
    await rm(root,{recursive:true,force:true});
  }
});
