import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';

const cli = join(process.env.CARGO_TARGET_DIR ?? resolve(import.meta.dirname, '../target'), 'debug/relay-native-job');
const env = { ...process.env, RELAY_RUST_EXPERIMENTAL_TEST_ONLY: 'isolated-test' };
function invoke(args, expected = 0) {
  const r = spawnSync(cli, args, { env, encoding: 'utf8', timeout: 12000 });
  assert.equal(r.status, expected, r.stderr || r.stdout);
  return expected === 0 ? JSON.parse(r.stdout) : r.stderr;
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'relay-rust-authority-projection-'));
  writeFileSync(join(root, '.relay-rust-authority-isolated-test'), 'isolated-test');
  const db = join(root, 'relay.sqlite');
  mkdirSync(join(root, 'project'));
  invoke(['init', '--db', db]);
  for (const [id, repo] of [['21', 'calc'], ['22', 'other']]) {
    invoke(['job','create','--db', db,'--id',id,'--repo',repo,'--title','Projection CLI fixture',
      '--objective','Inspect classified GitHub projection conflicts','--project-root',join(root,'project')]);
  }
  return { root, db };
}
function seed(f) {
  const sql = new DatabaseSync(f.db);
  sql.exec(`CREATE TABLE source_registry(job_id TEXT PRIMARY KEY, source_file TEXT NOT NULL UNIQUE, repository TEXT NOT NULL, pr_number INTEGER NOT NULL);
    CREATE TABLE projection_outbox(
      scope_job_id TEXT NOT NULL, id INTEGER NOT NULL, idempotency_key TEXT NOT NULL,
      operation_key TEXT NOT NULL, operation TEXT NOT NULL, payload_json TEXT NOT NULL,
      status TEXT NOT NULL, conflict_definition_json TEXT, conflict_evidence_json TEXT,
      conflict_detected_at TEXT, last_error TEXT, PRIMARY KEY(scope_job_id,id));`);
  for (const [id, repo] of [['21','calc'],['22','other']]) {
    sql.prepare('INSERT INTO source_registry(job_id,source_file,repository,pr_number) VALUES(?,?,?,0)').run(id,`source-${id}`,repo);
  }
  const put=sql.prepare('INSERT INTO projection_outbox(scope_job_id,id,idempotency_key,operation_key,operation,payload_json,status,conflict_definition_json,conflict_evidence_json,conflict_detected_at,last_error) VALUES(?,?,?,?,?,?,?,?,?,?,?)');
  put.run('21',1,'k1','a1','comment','{}','conflict',JSON.stringify({reason:'sha_mismatch'}),JSON.stringify({expected:'A',actual:'B'}),'2026-11-15T13:00:00.000Z','mismatch');
  put.run('21',2,'k2','a2','update','{}','pending',null,null,null,null);
  put.run('22',3,'k3','a3','secret','{}','conflict',JSON.stringify({secret:'other-job-data'}),null,null,null);
  sql.close();
}
const args=(f,id='21',repo='calc',kind='conflicts')=>['projection',kind,'--db',f.db,'--id',id,'--repo',repo];

test('projection conflicts/list reads only classified conflicts in the authoritative Job+repository scope',()=>{
  const f=fixture();try {
    seed(f);
    const before=readFileSync(f.db);
    const one=invoke(args(f));
    assert.equal(one.length,1);
    assert.equal(one[0].id,1);
    assert.equal(one[0].operationKey,'a1');
    assert.deepEqual(one[0].definition,{reason:'sha_mismatch'});
    assert.deepEqual(one[0].evidence,{expected:'A',actual:'B'});
    assert.equal(one[0].jobId,'21');
    assert.deepEqual(invoke(args(f,'21','calc','list')),one);
    assert.equal(invoke(args(f,'22','other')).length,1);
    assert.equal(invoke(args(f,'22','other'))[0].id,3);
    assert.deepEqual(readFileSync(f.db),before,'read-only CLI must not change canonical SQLite');
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('projection conflicts rejects cross-Job repo spoofing, unknown flags, legacy scope and malformed evidence',()=>{
  const f=fixture();try {
    seed(f);
    const before=readFileSync(f.db);
    assert.match(invoke(args(f,'21','wrong'),2),/repository identity mismatch/);
    assert.match(invoke([...args(f),'--id','22'],2),/duplicate option/);
    assert.match(invoke([...args(f),'--unsafe','true'],2),/unrecognized option/);
    assert.match(invoke(args(f,'99','calc'),2),/unknown projection Job/);
    assert.deepEqual(readFileSync(f.db),before);
    const sql=new DatabaseSync(f.db);
    sql.prepare('UPDATE projection_outbox SET conflict_evidence_json=? WHERE scope_job_id=? AND id=?').run('{invalid-json','21',1);
    sql.close();
    assert.match(invoke(args(f),2),/invalid conflict evidence JSON/);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('projection conflicts refuses legacy tables without a Job scope instead of leaking cross-Job records',()=>{
  const f=fixture();try {
    const sql=new DatabaseSync(f.db);
    sql.exec('CREATE TABLE projection_outbox(id INTEGER PRIMARY KEY,status TEXT,operation TEXT,operation_key TEXT,conflict_definition_json TEXT,conflict_evidence_json TEXT,conflict_detected_at TEXT,last_error TEXT)');
    sql.close();
    assert.match(invoke(args(f),2),/requires canonical scoped column scope_job_id/);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});
