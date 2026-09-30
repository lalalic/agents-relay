import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GhApiClient } from '../dist/store.js';
import { observeRuntimeRateLimit, parseGitHubCliHeaders } from '../dist/github-runtime-usage.js';

async function fakeGhPath(handler) {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-runtime-rate-'));
  const script = join(root, 'gh');
  await writeFile(script, '#!/bin/sh\nnode "$0.js" "$@"\n');
  await writeFile(`${script}.js`, `const headers=${headers.toString()};(async()=>{process.exitCode=await (${handler.toString()})(process.argv.slice(2),require('fs').readFileSync(0,'utf8'));})().catch(error=>{console.error(error);process.exitCode=1;});\n`);
  await chmod(script, 0o755);
  return root;
}

async function withPath(root, work) {
  const previous = process.env.PATH;
  process.env.PATH = `${root}:${previous}`;
  try { return await work(); } finally { process.env.PATH = previous; }
}

function headers(resource, { status = 200, remaining = 4998, retryAfter = null } = {}) {
  return [
    `HTTP/2 ${status}`,
    'content-type: application/json',
    `x-ratelimit-limit: 5000`,
    `x-ratelimit-used: ${5000 - remaining}`,
    `x-ratelimit-remaining: ${remaining}`,
    `x-ratelimit-reset: 1893456000`,
    `x-ratelimit-resource: ${resource}`,
    retryAfter === null ? '' : `retry-after: ${retryAfter}`,
    '',
    JSON.stringify(resource === 'graphql' ? { data: { viewer: { login: 'tester' } } } : { ok: true }),
    '',
  ].join('\r\n');
}

test('GitHub transport captures successful REST and GraphQL runtime headers separately', async t => {
  const fake = await fakeGhPath(args => {
    process.stdout.write(headers(args.some(value => value.endsWith('-')) ? 'graphql' : 'core'));
    return 0;
  });
  await withPath(fake, async () => {
    const client = new GhApiClient();
    await client.request('repos/owner/repo');
    await client.graphql('query { viewer { login } }');
    const usage = client.rateLimitStatus().runtimeRateUsage;
    assert.equal(usage.resources.core.status, 200);
    assert.equal(usage.resources.core.remaining, 4998);
    assert.equal(usage.resources.graphql.resource, 'graphql');
    assert.equal(usage.resources.graphql.remaining, 4998);
    assert.equal(usage.resources.graphql.resetAt, new Date(1893456000 * 1000).toISOString());
    assert.equal(usage.rejection, null);
  });
});

test('Runtime rejection remains visible while the primary snapshot reports quota', async t => {
  const fake = await fakeGhPath(args => {
    if (args.includes('rate_limit')) { process.stdout.write(JSON.stringify({ resources: { core: { limit: 5000, used: 2, remaining: 4998, reset: 1893456000 } } })); return 0; }
    process.stdout.write(headers('core', { status: 429, remaining: 0, retryAfter: 12 }));
    process.stderr.write('gh: HTTP 429: primary API rate limit exceeded');
    return 1;
  });
  await withPath(fake, async () => {
    const client = new GhApiClient();
    const snapshot = await client.rateLimitSnapshot(true);
    await assert.rejects(client.request('repos/owner/repo'));
    const status = client.rateLimitStatus();
    assert.equal(snapshot.resources.core.remaining, 4998);
    assert.equal(status.runtimeRateUsage.resources.core.status, 429);
    assert.equal(status.runtimeRateUsage.resources.core.available, false);
    assert.equal(status.runtimeRateUsage.resources.core.remaining, 0);
    assert.equal(status.runtimeRateUsage.rejection.kind, 'primary');
    assert.equal(status.runtimeRateUsage.rejection.retryAfterSeconds, 12);
    assert.ok(status.runtimeRateUsage.rejection.cooldownUntil);
    assert.equal(status.limited, true);
  });
});

test('GraphQL secondary throttling captures retry evidence without remaining capacity', async t => {
  const fake = await fakeGhPath(() => {
    process.stdout.write('HTTP/2 429\r\nretry-after: 30\r\n\r\n{"errors":[{"type":"RATE_LIMITED","message":"secondary rate limit"}]}\r\n');
    return 0;
  });
  await withPath(fake, async () => {
    const client = new GhApiClient();
    await assert.rejects(client.graphql('query { viewer { login } }'));
    const observed = client.rateLimitStatus().runtimeRateUsage;
    assert.equal(observed.resources.graphql.throttled, true);
    assert.equal(observed.resources.graphql.remaining, null);
    assert.equal(observed.rejection.kind, 'secondary');
    assert.equal(observed.rejection.retryAfterSeconds, 30);
  });
});

test('GraphQL primary exhaustion is not mislabeled secondary when X-RateLimit remaining is zero', async t => {
  const fake = await fakeGhPath(() => {
    process.stdout.write(headers('graphql', { remaining: 0 }));
    process.stderr.write('gh: API rate limit already exceeded: graphql_rate_limit');
    return 1;
  });
  await withPath(fake, async () => {
    const client = new GhApiClient();
    await assert.rejects(client.graphql('query { viewer { login } }'));
    const observed = client.rateLimitStatus().runtimeRateUsage;
    assert.equal(observed.resources.graphql.remaining, 0);
    assert.equal(observed.rejection.kind, 'primary');
  });
});

test('Absent GitHub runtime headers stay backward compatible and unknown', async t => {
  const fake = await fakeGhPath(() => { process.stdout.write('{"ok":true}'); return 0; });
  await withPath(fake, async () => {
    const client = new GhApiClient();
    await client.request('repos/owner/repo');
    const observed = client.rateLimitStatus().runtimeRateUsage.resources.core;
    assert.equal(observed.status, null);
    assert.equal(observed.available, null);
    assert.equal(observed.headersCaptured, false);
    assert.equal(observed.remaining, null);
  });
});

test('CLI header parsing preserves status and resets header keys', () => {
  const response = parseGitHubCliHeaders(headers('core', { status: 403, remaining: 0, retryAfter: 8 }), true);
  assert.equal(response.status, 403);
  assert.equal(response.headers['x-ratelimit-remaining'], '0');
  assert.equal(response.headers['retry-after'], '8');
  assert.equal(JSON.parse(response.body).ok, true);
});

test('Runtime observation converts reset epoch seconds to an ISO timestamp', () => {
  const observed = observeRuntimeRateLimit('rest', parseGitHubCliHeaders(headers('core'), true), '2026-09-29T00:00:00.000Z');
  assert.equal(observed.reset, 1893456000);
  assert.equal(observed.resetAt, new Date(1893456000 * 1000).toISOString());
});
