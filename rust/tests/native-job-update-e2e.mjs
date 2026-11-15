import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {SQLiteRelayStore} from '../../dist/relay-store.js';

const exe = resolve(import.meta.dirname, '../target/debug/relay-native-job');
const at = '2026-11-13T16:00:00.000Z';
const invoke = (root, db, ...args) => spawnSync(exe,
  ['update', '--db', db, '--job-id', '91', ...args], {
    encoding: 'utf8', env: {...process.env, AGENTS_RELAY_STORE_DIR: root,
      RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},
  });

test('native Job update changes only title/priority and persists in isolated SQLite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-rust-authority-job-update-'));
  const db = join(root, 'relay.sqlite');
  writeFileSync(join(root, '.relay-rust-authority-isolated-test'), 'isolated-test');
  let store;
  try {
    store = new SQLiteRelayStore(db);
    const fixture = {id:'91', title:'Before', priority:'P2', repository:'local-repo',
      projectRoot:root, objective:'keep me', state:'ACTIVE', runtimeStatus:'RUNNING',
      prNumber:0, reviewEnabled:false, autoMerge:false, createdAt:at, updatedAt:at,
      tasks:[], plans:[], continuation:null};
    await store.saveJob(fixture);
    store.close(); store = null;

    const title = invoke(root, db, '--title', 'After');
    assert.equal(title.status, 0, title.stderr);
    assert.equal(JSON.parse(title.stdout).job.title, 'After');
    const priority = invoke(root, db, '--priority', 'P0');
    assert.equal(priority.status, 0, priority.stderr);
    const saved = JSON.parse(priority.stdout).job;
    assert.equal(saved.title, 'After');
    assert.equal(saved.priority, 'P0');
    for (const key of ['id','repository','projectRoot','objective','state','runtimeStatus',
      'prNumber','reviewEnabled','autoMerge','createdAt','tasks','plans']) {
      assert.deepEqual(saved[key], fixture[key], `preserves ${key}`);
    }
    store = new SQLiteRelayStore(db);
    assert.deepEqual(await store.loadJob('91'), saved, 'updated values survive close/reopen');
    store.close(); store = null;

    const beforeReject = readFileSync(db);
    for (const [args, pattern] of [
      [['--priority','P4'], /--priority must be P0, P1, P2, or P3/],
      [['--title','   '], /--title must be nonempty/],
      [['--title','Valid','--priority','bad'], /--priority must be P0, P1, P2, or P3/],
      [[], /requires --title and\/or --priority/],
      [['--title','One','--title','Two'], /duplicate option --title/],
    ]) {
      const rejected = invoke(root, db, ...args);
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.match(rejected.stderr, pattern);
      assert.deepEqual(readFileSync(db), beforeReject, 'rejection leaves database bytes unchanged');
    }

    const unmarkedRoot = mkdtempSync(join(tmpdir(), 'relay-rust-job-update-unmarked-'));
    try {
      const unmarkedDb = join(unmarkedRoot, 'relay.sqlite');
      store = new SQLiteRelayStore(unmarkedDb);
      await store.saveJob(fixture);
      store.close(); store = null;
      const unmarkedBefore = readFileSync(unmarkedDb);
      const rejected = spawnSync(exe,
        ['update','--db',unmarkedDb,'--job-id','91','--title','Must not write'], {
          encoding:'utf8', env:{...process.env, AGENTS_RELAY_STORE_DIR:unmarkedRoot,
            RELAY_RUST_EXPERIMENTAL_TEST_ONLY:'isolated-test'},
        });
      assert.equal(rejected.status, 2, rejected.stderr);
      assert.match(rejected.stderr, /non-disposable\/unmarked SQLite authority/);
      assert.deepEqual(readFileSync(unmarkedDb), unmarkedBefore, 'unmarked DB must not be mutated');
    } finally {
      rmSync(unmarkedRoot, {recursive:true, force:true});
    }
  } finally {
    store?.close();
    rmSync(root, {recursive:true, force:true});
  }
});
