import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideBlockerResolution } from '../dist/workflow/blocker-resolution-v2.js';

const base={resolutionAllowed:true,targetMatches:true,effectivelyBlocked:false,alreadyUnblocked:false,isDraft:false,isBlocked:false,isFailed:false,isUnblocked:false};
test('Blocker resolution v2 releases dependency waits and leaves failed or blocked work alone', () => {
  assert.equal(decideBlockerResolution({...base,resolutionAllowed:false}).target,'wait');
  assert.equal(decideBlockerResolution({...base,targetMatches:false}).target,'obsolete');
  const draft=decideBlockerResolution({...base,isDraft:true});
  assert.equal(draft.target,'resumed');
  assert.deepEqual(draft.actions.map(action=>action.id),['blocker.releaseDraft']);
  for (const fact of ['isBlocked','isFailed','isUnblocked']) {
    assert.equal(decideBlockerResolution({...base,[fact]:true}).target,'wait');
  }
});
