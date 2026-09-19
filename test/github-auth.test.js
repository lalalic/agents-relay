import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import test from 'node:test';
import { githubAppConfig } from '../dist/github-auth.js';
import { createGitHubAppJwt, GhApiClient } from '../dist/store.js';

test('GitHub App config is all-or-nothing and CLI overrides environment', () => {
  assert.equal(githubAppConfig([], {}), null);
  assert.throws(() => githubAppConfig([], { AGENTS_RELAY_GITHUB_APP_ID: '1' }), /requires app id, installation id, and private key file/);
  assert.deepEqual(
    githubAppConfig(
      ['--github-app-id', 'cli-app', '--github-app-installation-id', 'cli-install', '--github-app-private-key-file', '/cli/key.pem'],
      { AGENTS_RELAY_GITHUB_APP_ID: 'env-app', AGENTS_RELAY_GITHUB_APP_INSTALLATION_ID: 'env-install', AGENTS_RELAY_GITHUB_APP_PRIVATE_KEY_FILE: '/env/key.pem' },
    ),
    { appId: 'cli-app', installationId: 'cli-install', privateKeyFile: '/cli/key.pem' },
  );
});

test('GitHub App JWT is RS256 signed with bounded GitHub-compatible claims', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const now = 2_000_000_000;
  const jwt = createGitHubAppJwt({ appId: '12345', installationId: '67890', privateKey: privatePem }, now);
  const [headerPart, payloadPart, signaturePart] = jwt.split('.');
  const header = JSON.parse(Buffer.from(headerPart, 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(payloadPart, 'base64url').toString('utf8'));
  assert.deepEqual(header, { alg: 'RS256', typ: 'JWT' });
  assert.deepEqual(payload, { iat: now - 60, exp: now + 540, iss: '12345' });
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${headerPart}.${payloadPart}`); verifier.end();
  assert.equal(verifier.verify(publicKey, Buffer.from(signaturePart, 'base64url')), true);
});


test('GitHub App identity request uses Bearer JWT over HTTPS instead of GH_TOKEN', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const originalFetch = globalThis.fetch;
  let authorization = '';
  globalThis.fetch = async (_url, init={}) => {
    authorization = String(init.headers?.authorization ?? '');
    return new Response(JSON.stringify({ slug: 'agents-relay-test' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try {
    const client = new GhApiClient({ appId: '12345', installationId: '67890', privateKey: privatePem });
    assert.equal(await client.currentLogin(), 'agents-relay-test[bot]');
    assert.match(authorization, /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
