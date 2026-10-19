import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { classifyChatGptPlatformFailure } from '../dist/worker-rejection.js';

test('ChatGPT platform rejection classification requires explicit safe pre-submission evidence', () => {
  for (const [message, classification] of [
    ['model_not_found: model is unavailable', 'model_unavailable'],
    ['browser-workspace runtime dependency unavailable', 'browser_workspace_unavailable'],
    ['ChatGPT login required', 'mcp_login_required'],
    ['ChatGPT MCP app is disconnected', 'mcp_login_required'],
    ['ChatGPT project name field not found', 'project_setup_unavailable'],
  ]) {
    assert.deepEqual(classifyChatGptPlatformFailure(message, 'delivery'), { classification, safeToReroute: true });
  }
  assert.deepEqual(classifyChatGptPlatformFailure('no worker task.started start-ack', 'start-ack'), {
    classification: 'start_ack_timeout', safeToReroute: false,
  });
  assert.deepEqual(classifyChatGptPlatformFailure('connection reset during submission', 'delivery'), {
    classification: 'transport_failure', safeToReroute: false,
  });
  assert.deepEqual(classifyChatGptPlatformFailure('worker launch failed before session creation', 'launch'), {
    classification: 'adapter_failure', safeToReroute: false,
  });
  assert.deepEqual(classifyChatGptPlatformFailure('Browser Workspace launcher rejected initialization', 'launch'), {
    classification: 'launch_failure', safeToReroute: false,
  });
  assert.equal(classifyChatGptPlatformFailure('review changes required: required behavior is missing', 'delivery'), undefined);
});
