import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectedE2EExecution } from '../dist/e2e-fault-injection.js';

test('one-shot fault injection matches only designated job, role and first attempt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'relay-e2e-fault-'));
  const oldJob = process.env.AGENTS_RELAY_E2E_FAULT_JOB;
  const oldDir = process.env.AGENTS_RELAY_E2E_FAULT_DIR;
  process.env.AGENTS_RELAY_E2E_FAULT_JOB = 'isolated-e2e';
  process.env.AGENTS_RELAY_E2E_FAULT_DIR = dir;
  try {
    const base = {jobId: 'isolated-e2e', id: 'implementation-task', executionId: 'exec-1', attempt: 1, agentName: 'implementation'};
    assert.equal(injectedE2EExecution({...base, jobId:'other-job'}), null);
    assert.equal(injectedE2EExecution({...base, attempt: 2}), null);
    assert.equal(injectedE2EExecution({...base, agentName: 'troubleshooter'}), null);
    const worker = injectedE2EExecution(base);
    assert.ok(worker?.pid > 0);
    await assert.rejects(worker.promise, /E2E injected worker exit without terminal event/);
    assert.equal(worker.processExit.exitCode, 137);
    assert.equal(injectedE2EExecution(base), null);
    assert.equal(JSON.parse(readFileSync(join(dir, 'implementation.consumed'))).executionId, 'exec-1');
    const reviewer = injectedE2EExecution({...base, agentName: 'reviewer', id: 'review', executionId:'exec-2'});
    await assert.rejects(reviewer.promise, /E2E injected reviewer exit code 42/);
    assert.equal(reviewer.processExit.exitCode, 42);
    assert.equal(injectedE2EExecution({...base, agentName: 'reviewer'}), null);
  } finally {
    if (oldJob === undefined) delete process.env.AGENTS_RELAY_E2E_FAULT_JOB; else process.env.AGENTS_RELAY_E2E_FAULT_JOB=oldJob;
    if (oldDir === undefined) delete process.env.AGENTS_RELAY_E2E_FAULT_DIR; else process.env.AGENTS_RELAY_E2E_FAULT_DIR=oldDir;
    rmSync(dir,{recursive:true,force:true});
  }
});
