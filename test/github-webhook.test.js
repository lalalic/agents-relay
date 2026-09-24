import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { DeliveryDeduper, parseGitHubWebhook, verifyGitHubWebhook, PACKAGE_PUBLISHED_MARKER } from '../dist/github-webhook.js';
import { publicationComment } from '../scripts/report-package-published.mjs';

test('GitHub webhook verifies HMAC, filters events, and extracts PR identity', () => {
  const body = Buffer.from(JSON.stringify({ action: 'synchronize', repository: { full_name: 'lalalic/agents-relay' }, pull_request: { number: 11 } }));
  const secret = 'test-secret';
  const signature = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyGitHubWebhook(secret, body, signature), true);
  assert.equal(verifyGitHubWebhook(secret, body, 'sha256=bad'), false);
  assert.deepEqual(parseGitHubWebhook({ 'x-github-delivery': 'delivery-1', 'x-github-event': 'pull_request' }, body), { deliveryId: 'delivery-1', event: 'pull_request', action: 'synchronize', repository: 'lalalic/agents-relay', pullRequest: 11, publication: null });
  assert.equal(parseGitHubWebhook({ 'x-github-delivery': 'delivery-2', 'x-github-event': 'ping' }, body), null);
});

test('GitHub webhook delivery IDs are idempotent', () => {
  const dedupe = new DeliveryDeduper(1000);
  assert.equal(dedupe.accept('same', 100), true);
  assert.equal(dedupe.accept('same', 200), false);
  assert.equal(dedupe.accept('same', 1200), true);
});


test('GitHub issue-comment webhook extracts package publication marker only from PR comments', () => {
  const comment = publicationComment({ packageName: 'agents-relay', version: '1.2.3', registry: 'https://registry.npmjs.org', sha: 'abc123' });
  assert.match(comment, new RegExp(PACKAGE_PUBLISHED_MARKER));
  const body = Buffer.from(JSON.stringify({
    action: 'created',
    repository: { full_name: 'lalalic/agents-relay' },
    issue: { number: 83, pull_request: { url: 'https://api.github.com/repos/lalalic/agents-relay/pulls/83' } },
    comment: { body: comment },
  }));
  assert.deepEqual(parseGitHubWebhook({ 'x-github-delivery': 'delivery-published', 'x-github-event': 'issue_comment' }, body), {
    deliveryId: 'delivery-published',
    event: 'issue_comment',
    action: 'created',
    repository: 'lalalic/agents-relay',
    pullRequest: 83,
    publication: { package: 'agents-relay', version: '1.2.3', registry: 'https://registry.npmjs.org', sha: 'abc123' },
  });

  const unrelated = Buffer.from(JSON.stringify({
    action: 'created',
    repository: { full_name: 'lalalic/agents-relay' },
    issue: { number: 83, pull_request: {} },
    comment: { body: 'normal comment' },
  }));
  assert.equal(parseGitHubWebhook({ 'x-github-delivery': 'delivery-normal', 'x-github-event': 'issue_comment' }, unrelated)?.publication, null);
});
