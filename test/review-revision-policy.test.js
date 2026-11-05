import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { reviewFindingFingerprint, reviewRevisionLimits, repeatedFindingRounds } from '../dist/review-revision-policy.js';
import { settleReviewRevisionRound } from '../dist/review-revision-settlement.js';

const recordedAt = index => new Date(Date.UTC(2026,10,5,12,index)).toISOString();
const round = (id, findingFingerprint, index) => ({ reviewTaskId:id,reviewExecutionId:'execution-'+id,headSha:'head-'+id,
  requestIds:['request-'+id],status:'changes_required',recordedAt:recordedAt(index),findingFingerprint });

test('Review fingerprint normalizes ordering/whitespace and explicit operator limits reject invalid values', () => {
  const a=reviewFindingFingerprint(['  Connection  broken ', 'Invalid  Token']);
  assert.equal(a,reviewFindingFingerprint(['invalid token','connection broken','invalid token']));
  assert.notEqual(a,reviewFindingFingerprint(['another issue']));
  assert.equal(reviewFindingFingerprint([]),undefined);
  assert.deepEqual(reviewRevisionLimits({}),{maxRounds:5,maxNoProgressRounds:1});
  assert.deepEqual(reviewRevisionLimits({AGENTS_RELAY_REVIEW_MAX_ROUNDS:'9',AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT:'2'}),
    {maxRounds:9,maxNoProgressRounds:2});
  for(const value of ['0','101','NaN','0.5','-2','foo'])
    assert.throws(()=>reviewRevisionLimits({AGENTS_RELAY_REVIEW_NO_PROGRESS_LIMIT:value}),/integer from 1 to 100/);
});

test('Review recurrence counts consecutive identical findings and resets after changed issues',()=>{
  const f=reviewFindingFingerprint([' F1  bug ']);
  const g=reviewFindingFingerprint(['Different finding']);
  const first=round('one',f,0),second=round('two',f,1),third=round('three',g,2),fourth=round('four',f,3);
  assert.equal(repeatedFindingRounds({reviewRevisionRounds:[first]},first),0);
  assert.equal(repeatedFindingRounds({reviewRevisionRounds:[first,second]},second),1);
  assert.equal(repeatedFindingRounds({reviewRevisionRounds:[first,second,third,fourth]},fourth),0);
});

test('Repeated verified findings fail closed into durable owner resolution without creating another review',async()=>{
  const f=reviewFindingFingerprint(['some repeated defect']);
  const first=round('review-1',f,0),second=round('review-2',f,1);
  const j={id:'j',state:'ACTIVE',review:{outcome:'changes_required',revisionDisposition:'targeted',taskId:'review-2',headSha:'head-review-2'},
    reviewRevisionRounds:[first,second],reviewRevisionRequests:[{requestId:'r2',reviewTaskId:'review-2',revisionTaskId:'fix-2',status:'verified'}],
    tasks:[{id:'review-2',comments:[]},{id:'fix-2',state:'SUCCEEDED'}]};
  const store={mutateJob:async(id,fn)=>{assert.equal(id,'j');return fn(j)}};
  const out=await settleReviewRevisionRound(store,j);
  assert.equal(out.review.outcome,'changes_required');
  assert.equal(out.review.revisionDisposition,'needs-ownership');
  assert.match(out.tasks[0].comments[0].text??out.tasks[0].comments[0].body??JSON.stringify(out.tasks[0].comments[0]),/without progress/);
  await settleReviewRevisionRound(store,j);
  assert.equal(out.tasks[0].comments.length,1,'idempotent recovery comment');
});
