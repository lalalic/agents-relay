import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideTroubleshooter } from '../dist/workflow/troubleshooter-v2.js';

const base={
  failedOrBlocked:true,
  ordinaryWork:true,
  currentRun:true,
  needsRecovery:true,
  idUnused:true,
  noRecoveryBarrier:true,
};

test('Troubleshooter v2 graph owns recovery-task eligibility', () => {
  for (const [fact,value] of [
    ['failedOrBlocked',false],
    ['ordinaryWork',false],
    ['currentRun',false],
    ['needsRecovery',false],
    ['idUnused',false],
    ['noRecoveryBarrier',false],
  ]) {
    const decision=decideTroubleshooter({...base,[fact]:value});
    assert.equal(decision.target,'skip');
    assert.deepEqual(decision.actions,[]);
  }
  const create=decideTroubleshooter(base);
  assert.equal(create.target,'create');
  assert.deepEqual(create.actions.map(action=>action.id),['troubleshooter.create']);
});
