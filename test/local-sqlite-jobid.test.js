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
const execFileAsync = promisify(execFile);

test('SQLite registry routes no-PR schedule, startup recovery, and targeted worker events by jobId', async () => {
  const root = await mkdtemp(join(tmpdir(), 'relay-local-jobid-'));
  const dbPath = join(root, 'anonymous-local-job.db');
  const sqlite = new SQLiteRelayStore(dbPath);
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
  const inv = async () => (await discoverLocalRelayStoreSnapshots(root)).flatMap(snapshot =>
    snapshot.jobs.map(job => ({job, githubState:'UNKNOWN', draft:false, mergedAt:null, closedAt:null})));
  const resolve = async jobId => {
    const matches = (await discoverLocalRelayStoreSnapshots(root)).flatMap(snapshot =>
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
  const dbPath = join(directory, 'shared-job.db');
  const relay = new SQLiteRelayStore(dbPath);
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
      "const sqlite = new SQLiteRelayStore(process.env.RELAY_TEST_DB);",
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

test('registry resolves unique ACTIVE Job over archived same-ID terminal snapshot without changing SQLite', async () => {
  const { createJobIdRegistryResolver } = await import('../dist/local-job-registry.js');
  const root=await mkdtemp(join(tmpdir(),'relay-duplicate-history-'));
  const stores=[];
  try {
    const make=async(name,state)=>{
      const db=new SQLiteRelayStore(join(root,name+'.db'));stores.push(db);
      const job={id:'same-job',repository:'local/work',prNumber:0,title:name,state,
        createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z',tasks:[]};
      await db.saveJob(job);
      return db;
    };
    await make('old','COMPLETED');await make('current','ACTIVE');
    const resolved=await createJobIdRegistryResolver(root,new Map())('same-job');
    assert.equal(resolved?.job.state,'ACTIVE');
    assert.equal(resolved?.job.title,'current');
    assert.equal((await discoverLocalRelayStoreSnapshots(root)).flatMap(s=>s.jobs).length,2);
    await make('conflict','DRAFT');
    assert.equal(await createJobIdRegistryResolver(root,new Map())('same-job'),null);
  } finally {for(const db of stores)db.close();await rm(root,{recursive:true,force:true});}
});


test('registry upgrades a local Job to external GitHub merge capability after PR binding', async () => {
  const { createJobIdRegistryResolver } = await import('../dist/local-job-registry.js');
  const root=await mkdtemp(join(tmpdir(),'relay-external-binding-'));
  const relay=new SQLiteRelayStore(join(root,'job.db'));
  try {
    const at='2026-10-09T12:00:00.000Z';
    await relay.saveJob({id:'bound-job',repository:'owner/repo',prNumber:0,externalPrNumber:77,title:'bound',state:'COMPLETED',executionMode:'autonomous',continuation:null,createdAt:at,updatedAt:at,tasks:[],localMerge:{sourceRef:'refs/heads/feature',targetRef:'refs/heads/main',status:'succeeded',sourceSha:'abcdef1234567890'}});
    const resolved=await createJobIdRegistryResolver(root,new Map(),{client:{},noGitHub:false})('bound-job');
    assert.ok(resolved);
    await resolved.store.mergePullRequest('abcdef1234567890');
    assert.equal(await resolved.relay.pendingProjectionCount(),1);
  } finally {relay.close();await rm(root,{recursive:true,force:true});}
});
