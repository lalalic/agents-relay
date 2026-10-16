import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore, discoverLocalRelayStoreSnapshots } from '../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../dist/local-authority-store.js';
import { InMemoryStore } from '../dist/store.js';
import { RepositoryWorkerPool } from '../dist/pool.js';
import { MemoryEventBus, eventFor } from '../dist/events.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
const execFileAsync = promisify(execFile);

test('SQLite registry routes no-PR schedule, startup recovery, and targeted worker events by jobId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-jobid-'));
  const dbPath = join(root, 'relay.sqlite');
  const sqlite = new SQLiteRelayStore(dbPath, 'local-jobid-sqlite');
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);
  const at = '2026-10-09T11:00:00.000Z';
  const job = {
    id: 'local-jobid-sqlite', repository: 'local/project', prNumber: 0, title: 'Local only',
    state: 'ACTIVE', executionMode: 'autonomous', autoMerge: false, reviewEnabled: false,
    continuation: null, createdAt: at, updatedAt: at, tasks: [],
    schedule: { cron: '0 * * * *', timezone: 'UTC', nextRunAt: at,
      missedRunPolicy: 'run', concurrencyPolicy: 'skip', lastScheduledSlot: null,
      currentRunSlot: null, lastRunAt: null },
  };
  let githubCalls = 0;
  const client = { request: async () => { githubCalls++; throw new Error('GitHub REST forbidden'); },
    graphql: async () => { githubCalls++; throw new Error('GitHub GraphQL forbidden'); } };
  const inv = async () => (await discoverLocalRelayStoreSnapshots(join(root, 'stores'))).flatMap(snapshot =>
    snapshot.jobs.map(job => ({job, githubState:'UNKNOWN', draft:false, mergedAt:null, closedAt:null})));
  const resolve = async jobId => {
    const matches = (await discoverLocalRelayStoreSnapshots(join(root, 'stores'))).flatMap(snapshot =>
      snapshot.jobs.filter(job => job.id === jobId).map(job => ({job, store})));
    return matches.length === 1 ? matches[0] : null;
  };
  const calls = [];
  const pool = new RepositoryWorkerPool(2, () => ({
    recoverStartupOrphans: async id => {calls.push('startup'); return store.load(id); },
    reconcile: async id => {calls.push('reconcile'); assert.equal(id, job.id); },
    applyEvent: async event => {calls.push(event.type); return {applied:true,reconcile:true};},
  }),inv,resolve);
  try {
    await store.saveJob(job);
    await pool.reconcileKnown(await inv());
    assert.ok(calls.includes('startup'));
    const now = new Date('2026-10-09T11:05:00.000Z');
    await pool.scheduleTickSignal(undefined,job,now);
    assert.equal((await store.load(job.id)).schedule.lastRunAt,now.toISOString());
    assert.equal((await store.load(job.id)).schedule.lastScheduledSlot,at);
    const bus = new MemoryEventBus();
    const stop = await pool.watch(bus);
    try {
      await bus.publish(eventFor(job.id,'local-worker',null,'task.completed','succeeded',
        'worker done','orchestrator',{}));
      for (let i=0;i<100&&!calls.includes('task.completed');i++)
        await new Promise(resolve=>setTimeout(resolve,2));
      assert.ok(calls.includes('task.completed'));
    } finally {await stop();}
    assert.equal(githubCalls,0);
  } finally {
    sqlite.close();
    await rm(root,{recursive:true,force:true});
  }
});

test('two independent processes atomically claim one no-PR SQLite scheduled slot only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'relay-local-slot-race-'));
  const dbPath = join(directory, 'relay.sqlite');
  const relay = new SQLiteRelayStore(dbPath, 'race-job');
  const start = '2026-10-09T12:00:00.000Z';
  const job = {
    id: 'race-job', repository: 'local/work', prNumber: 0, title: 'Concurrent local schedule',
    state: 'ACTIVE', executionMode: 'autonomous', autoMerge: false, reviewEnabled: false,
    createdAt: start, updatedAt: start, continuation: null, tasks: [],
    schedule: { cron: '0 * * * *', timezone: 'UTC', nextRunAt: start,
      missedRunPolicy: 'run', concurrencyPolicy: 'skip',
      lastScheduledSlot: null, currentRunSlot: null, lastRunAt: null },
  };
  const store = new LocalAuthorityDurableStore(relay, new InMemoryStore(), undefined, true);
  try {
    await store.saveJob(job);
    const source = [
      "import { SQLiteRelayStore } from './dist/relay-store.js';",
      "import { LocalAuthorityDurableStore } from './dist/local-authority-store.js';",
      "import { InMemoryStore } from './dist/store.js';",
      "import { runScheduledBucketFromStore } from './dist/scheduled-jobs.js';",
      "const sqlite = new SQLiteRelayStore(process.env.RELAY_TEST_DB, 'race-job');",
      "const local = new LocalAuthorityDurableStore(sqlite, new InMemoryStore(), undefined, true);",
      "const result = await runScheduledBucketFromStore(local, {jobId:'race-job',bucket:'20261009T1200Z'},",
      "  {reconcile:async()=>{await new Promise(resolve=>setTimeout(resolve,30));},idle:async()=>{}},",
      "  new Date('2026-10-09T12:05:00.000Z'));",
      "console.log('CLAIM_RESULT='+result.status); sqlite.close();",
    ].join('\n');
    const invoke = () => execFileAsync(process.execPath, ['--input-type=module', '-e', source], {
      cwd: process.cwd(), timeout: 8000, env: {...process.env, RELAY_TEST_DB: dbPath},
    });
    const outcomes = await Promise.all([invoke(),invoke()]);
    const statuses = outcomes.map(result =>
      result.stdout.match(/CLAIM_RESULT=(completed|skipped-idempotent|skipped-active)/)?.[1]);
    assert.deepEqual(statuses.sort(), ['completed','skipped-idempotent']);
    const persisted = await store.load(job.id);
    assert.equal(persisted.schedule.lastScheduledSlot, start);
    assert.equal(persisted.schedule.lastRunAt, '2026-10-09T12:05:00.000Z');
    assert.equal(persisted.schedule.nextRunAt, '2026-10-09T13:00:00.000Z');
  } finally {
    relay.close();
    await rm(directory, {recursive:true,force:true});
  }
});

test('one unified SQLite registry rejects conflicting identity for an immutable Job ID', async () => {
  const { createJobIdRegistryResolver } = await import('../dist/local-job-registry.js');
  const root = await mkdtemp(join(tmpdir(),'relay-unique-jobid-'));
  const sqlite = new SQLiteRelayStore(join(root,'relay.sqlite'),'same-job');
  try {
    const at='2026-10-01T00:00:00.000Z';
    const job={id:'same-job',repository:'local/work',prNumber:0,title:'current',state:'ACTIVE',
      executionMode:'fixed',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
    await sqlite.saveJob(job);
    const resolve=createJobIdRegistryResolver(join(root,'stores'),new Map(),{noGitHub:true});
    const resolved=await resolve('same-job');
    assert.equal(resolved?.job.state,'ACTIVE');
    assert.equal(resolved?.job.title,'current');
    await assert.rejects(sqlite.saveJob({...job,repository:'other/work'}),/conflicting repository identity/);
    assert.equal((await discoverLocalRelayStoreSnapshots(join(root,'stores'))).length,1);
    resolved.relay.close();
  } finally {sqlite.close();await rm(root,{recursive:true,force:true});}
});


test('unified SQLite normalizes old PR projection metadata without losing immutable binding', async () => {
  const { storeFor } = await import('../dist/cli-support.js');
  const root=await mkdtemp(join(tmpdir(),'relay-cli-external-binding-'));
  const directory=join(root,'stores');
  const path=join(root,'relay.sqlite');
  let relay=new SQLiteRelayStore(path,'bound-cli-job');
  try {
    const at='2026-10-09T12:00:00.000Z';
    const job={id:'bound-cli-job',repository:'owner/repo',prNumber:88,title:'bound',state:'ACTIVE',
      executionMode:'fixed',continuation:null,createdAt:at,updatedAt:at,tasks:[]};
    await relay.saveJob(job); relay.close();
    const db=new DatabaseSync(path);
    const legacy={...job,prNumber:0,externalPrNumber:88};
    db.prepare('UPDATE job_snapshot SET json=? WHERE job_id=?').run(JSON.stringify(legacy),'bound-cli-job');
    db.close();
    relay=new SQLiteRelayStore(path,'bound-cli-job');
    const migrated=await relay.loadJob('bound-cli-job');
    assert.equal(migrated.prNumber,88);
    await relay.saveJob(migrated);
    const raw=new DatabaseSync(path,{readOnly:true});
    const stored=JSON.parse(raw.prepare('SELECT json FROM job_snapshot WHERE job_id=?').get('bound-cli-job').json);
    raw.close();
    assert.equal(stored.prNumber,88);
    assert.equal(Object.prototype.hasOwnProperty.call(stored,'externalPrNumber'),false);
    const loaded=await storeFor(['--repo','owner/repo','--id','bound-cli-job','--pr','88','--store-dir',directory]);
    assert.equal(loaded.job.prNumber,88);
    await assert.rejects(()=>storeFor(['--repo','owner/repo','--id','bound-cli-job','--pr','89','--store-dir',directory]),/Local Job\/PR binding mismatch/);
  } finally {relay.close(); await rm(root,{recursive:true,force:true});}
});


test('registry upgrades a local Job to external GitHub merge capability after PR binding', async () => {
  const { createJobIdRegistryResolver } = await import('../dist/local-job-registry.js');
  const root=await mkdtemp(join(tmpdir(),'relay-external-binding-'));
  const relay=new SQLiteRelayStore(join(root,'relay.sqlite'),'bound-job');
  try {
    const at='2026-10-09T12:00:00.000Z';
    await relay.saveJob({id:'bound-job',repository:'owner/repo',prNumber:77,title:'bound',state:'COMPLETED',executionMode:'autonomous',continuation:null,createdAt:at,updatedAt:at,tasks:[],localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'succeeded',sourceSha:'abcdef1234567890'}});
    const resolved=await createJobIdRegistryResolver(join(root,'stores'),new Map(),{client:{},noGitHub:false})('bound-job');
    assert.ok(resolved);
    await resolved.store.mergePullRequest('abcdef1234567890');
    assert.equal(await resolved.relay.pendingProjectionCount(),1);
  } finally {relay.close();await rm(root,{recursive:true,force:true});}
});


test('SQLite startup backfills durable Task titles from historical input', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-task-title-migration-')); const path=join(root,'job.db');
  let relay=new SQLiteRelayStore(path); const at='2026-10-09T12:00:00.000Z';
  await relay.saveJob({id:'titles',repository:'owner/repo',prNumber:1,title:'titles',state:'ACTIVE',executionMode:'fixed',continuation:null,createdAt:at,updatedAt:at,tasks:[{jobId:'titles',id:'legacy-task',parentTaskId:null,dependencies:[],capabilities:[],adapter:'codex',input:'## Repair dashboard task labels\nMore details',state:'QUEUED',attempt:0,maxAttempts:3,leaseOwner:null,leaseExpiresAt:null,executionId:null,threadId:null,result:null,error:null,timeoutMs:1,createdAt:at,updatedAt:at}]});
  relay.close(); relay=new SQLiteRelayStore(path);
  const migrated=await relay.loadJob('titles');
  assert.equal(migrated.tasks[0].title,'Repair dashboard task labels');
  relay.close(); await rm(root,{recursive:true,force:true});
});
