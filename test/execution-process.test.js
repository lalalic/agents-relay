import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { captureProcessRecord, probeProcessRecord, stopOrphanedProcessGroup } from '../dist/process-identity.js';
import { reclaimStaleExecutionProcess } from '../dist/execution-process-tracker.js';

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

test('SQLite keeps executionId to process identity independent of GitHub projections', async () => {
  const root=await mkdtemp(join(tmpdir(),'relay-process-ledger-'));
  const filename=join(root,'relay.db');
  const record={jobId:'job',taskId:'task',executionId:'exec',leaseOwner:'relayd-test',
    host:hostname(),pid:41701,pgid:41701,startToken:'Mon Jan  1 00:00:00 2024',observedAt:new Date().toISOString()};
  try {
    let store=new SQLiteRelayStore(filename);
    await store.recordExecutionProcess(record);
    await store.recordExecutionProcess(record);
    assert.deepEqual(await store.loadExecutionProcess('job','task','exec'),{...record,endedAt:null});
    await assert.rejects(()=>store.recordExecutionProcess({...record,startToken:'different'}),/Conflicting process identity/);
    await store.finishExecutionProcess('job','task','exec');
    store.close();
    store=new SQLiteRelayStore(filename);
    const saved=await store.loadExecutionProcess('job','task','exec');
    assert.ok(saved.endedAt);
    assert.equal(saved.pid,41701);
    store.close();
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('OS process probe checks PID reuse, PGID and remote-host safety', {skip:process.platform==='win32'}, async () => {
  const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
  try {
    assert.ok(child.pid);
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    const record=await captureProcessRecord('j','t','e','relayd-dead',child.pid);
    assert.ok(record);
    assert.equal(record.pgid,child.pid);
    assert.equal(await probeProcessRecord(record),'alive');
    const reused={...record,startToken:'not-the-original-process'};
    assert.equal(await probeProcessRecord(reused),'reused');
    assert.equal(await stopOrphanedProcessGroup(reused,25),true);
    assert.equal(isAlive(child.pid),true);
    const remote={...record,host:'another-host.example'};
    assert.equal(await probeProcessRecord(remote),'unknown');
    assert.equal(await stopOrphanedProcessGroup(remote,25),false);
    assert.equal(isAlive(child.pid),true);
    assert.equal(await reclaimStaleExecutionProcess({
      loadExecutionProcess: async()=>remote,
    }, {jobId:'j',id:'t',executionId:'e'}),false);
  } finally {
    if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch {} }
  }
});

test('bounded SIGTERM to SIGKILL ends only the matching detached process group', {skip:process.platform==='win32'}, async () => {
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{detached:true,stdio:'ignore'});
  try {
    await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});
    await new Promise(resolve=>setTimeout(resolve,75));
    const record=await captureProcessRecord('j','t','exact-group','relayd-dead',child.pid);
    assert.ok(record);
    assert.equal(await stopOrphanedProcessGroup(record,100),true);
  } finally {
    if (child.pid && isAlive(child.pid)) { try { process.kill(-child.pid,'SIGKILL'); } catch {} }
  }
});
