import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DeliveryDeduper, parseGitHubWebhook, verifyGitHubWebhook } from '../dist/github-webhook.js';

test('GitHub webhook verifies HMAC, filters events, and extracts PR identity', () => {
  const body = Buffer.from(JSON.stringify({ action: 'synchronize', repository: { full_name: 'lalalic/agents-relay' }, pull_request: { number: 11 } }));
  const secret = 'test-secret';
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyGitHubWebhook(secret, body, signature), true);
  assert.equal(verifyGitHubWebhook(secret, body, 'sha256=bad'), false);
  assert.deepEqual(parseGitHubWebhook({ 'x-github-delivery': 'delivery-1', 'x-github-event': 'pull_request' }, body), { deliveryId: 'delivery-1', event: 'pull_request', action: 'synchronize', repository: 'lalalic/agents-relay', pullRequest: 11 });
  assert.equal(parseGitHubWebhook({ 'x-github-delivery': 'delivery-2', 'x-github-event': 'ping' }, body), null);
});

test('GitHub webhook delivery IDs are idempotent', () => {
  const dedupe = new DeliveryDeduper(1000);
  assert.equal(dedupe.accept('same', 100), true);
  assert.equal(dedupe.accept('same', 200), false);
  assert.equal(dedupe.accept('same', 1200), true);
});
