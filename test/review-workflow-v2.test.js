import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { decideReviewLifecycle } from '../dist/workflow/review-v2.js';

test('Review v2 graph owns creation, stale, revision, and merge decisions', () => {
  const eligible={unscheduled:true,reviewEnabled:true,jobActive:true,implementationComplete:true,headAvailable:true,completionGateSatisfied:true,noActiveReviewTask:true,noApprovedCurrentReview:true};
  const create=decideReviewLifecycle(undefined,'reconcile',eligible);
  assert.equal(create.target,'PENDING');
  assert.deepEqual(create.actions.map(action=>action.id),['review.create']);
  for(const key of Object.keys(eligible)){
    const denied=decideReviewLifecycle(undefined,'reconcile',{...eligible,[key]:false});
    assert.equal(denied.target,'NONE',key);
    assert.deepEqual(denied.actions,[],key);
  }
  const stale=decideReviewLifecycle('started','head.changed');
  assert.equal(stale.target,'STALE');
  assert.deepEqual(stale.actions.map(action=>action.id),['review.cancelStale']);
  const changes=decideReviewLifecycle('started','review.changes_required');
  assert.equal(changes.target,'CHANGES_REQUIRED');
  assert.deepEqual(changes.actions.map(action=>action.id),['review.createFix']);
  const approved=decideReviewLifecycle('started','review.approved',{autoMerge:true});
  assert.equal(approved.target,'APPROVED');
  assert.deepEqual(approved.actions.map(action=>action.id),['review.requestMerge']);
  const approvedNoMerge=decideReviewLifecycle('pending','review.approved',{autoMerge:false});
  assert.equal(approvedNoMerge.target,'APPROVED');
  assert.deepEqual(approvedNoMerge.actions,[]);
});
