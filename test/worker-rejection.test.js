import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { classifyChatGptPlatformFailure, PreSubmissionRejection } from '../dist/worker-rejection.js';

test('only typed positive pre-submission rejection evidence permits rerouting', () => {
  const rejected = PreSubmissionRejection.fromPlatformResponse({ status: 'rejected', submitted: false, code: 'MODEL_UNAVAILABLE', message: 'unsupported' });
  assert.ok(rejected instanceof PreSubmissionRejection);
  assert.deepEqual(classifyChatGptPlatformFailure(rejected, 'delivery'), {
    classification: 'model_unavailable', safeToReroute: true, evidence: rejected.platformEvidence,
  });
  assert.equal(PreSubmissionRejection.fromPlatformResponse({ status: 'unknown', code: 'MODEL_UNAVAILABLE', message: 'unsupported' }), undefined);
  assert.equal(PreSubmissionRejection.fromPlatformResponse({ status: 'rejected', submitted: true, code: 'MODEL_UNAVAILABLE', message: 'unsupported' }), undefined);
  for (const message of [
    'model_not_found: model is unavailable',
    'browser-workspace runtime dependency unavailable',
    'ChatGPT login required',
    'project name field not found',
  ]) assert.equal(classifyChatGptPlatformFailure(new Error(message), 'delivery').safeToReroute, false);
  assert.deepEqual(classifyChatGptPlatformFailure('no worker task.started start-ack', 'start-ack'), {
    classification: 'start_ack_timeout', safeToReroute: false, evidence: 'no worker task.started start-ack',
  });
  assert.deepEqual(classifyChatGptPlatformFailure(new Error('connection reset during submission'), 'delivery'), {
    classification: 'outcome_unknown', safeToReroute: false, evidence: 'connection reset during submission',
  });
  assert.equal(classifyChatGptPlatformFailure(new Error('model unavailable after submit'), 'delivery').safeToReroute, false);
});
