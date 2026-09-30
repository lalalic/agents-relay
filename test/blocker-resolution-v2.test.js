import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideBlockerResolution } from '../dist/workflow/blocker-resolution-v2.js';

const base={resolutionAllowed:true,targetMatches:true,autonomousJob:false,effectivelyBlocked:false,alreadyUnblocked:false,isDraft:false,isBlocked:false,isFailed:false,isUnblocked:false};
test('Blocker resolution v2 graph selects wait/obsolete/resume actions', () => {
  assert.equal(decideBlockerResolution({...base,resolutionAllowed:false}).target,'wait');
  assert.equal(decideBlockerResolution({...base,targetMatches:false}).target,'obsolete');
  const autonomous=decideBlockerResolution({...base,autonomousJob:true,effectivelyBlocked:true,isBlocked:true});
  assert.deepEqual(autonomous.actions.map(action=>action.id),['blocker.autonomousUnblock']);
  const existing=decideBlockerResolution({...base,autonomousJob:true,alreadyUnblocked:true,isUnblocked:true});
  assert.deepEqual(existing.actions.map(action=>action.id),['blocker.acceptExistingUnblock']);
  for (const [fact,action] of [['isDraft','blocker.releaseDraft'],['isBlocked','blocker.unblockTask'],['isFailed','blocker.retryFailed'],['isUnblocked','blocker.retryUnblocked']]) {
    const decision=decideBlockerResolution({...base,[fact]:true});
    assert.equal(decision.target,'resumed');
    assert.deepEqual(decision.actions.map(step=>step.id),[action]);
  }
});
