import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideScheduledRun } from '../dist/workflow/scheduled-run-v2.js';

const base={slotDue:true,slotUnclaimed:true,jobActive:true,hasActiveTasks:false,concurrencySkip:true,concurrencyQueue:false,runMissed:false};
test('Scheduled Run v2 graph owns due, concurrency, and missed-run policy', () => {
  assert.equal(decideScheduledRun({...base,slotDue:false}).target,'skip_idempotent');
  assert.equal(decideScheduledRun({...base,slotUnclaimed:false}).target,'skip_idempotent');
  assert.equal(decideScheduledRun({...base,jobActive:false}).target,'skip_idempotent');
  const skip=decideScheduledRun({...base,hasActiveTasks:true,concurrencySkip:true});
  assert.equal(skip.target,'skip_active');
  assert.deepEqual(skip.actions.map(action=>action.id),['schedule.skipActiveAdvance']);
  const queue=decideScheduledRun({...base,hasActiveTasks:true,concurrencySkip:false,concurrencyQueue:true});
  assert.equal(queue.target,'skip_active');
  assert.deepEqual(queue.actions,[]);
  assert.deepEqual(decideScheduledRun(base).actions.map(action=>action.id),['schedule.claimFromNow']);
  assert.deepEqual(decideScheduledRun({...base,runMissed:true}).actions.map(action=>action.id),['schedule.claimFromSlot']);
});
