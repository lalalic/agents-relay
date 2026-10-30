import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { issueZWorkerCredential } from '../dist/z-oauth.js';

test('Z worker OAuth issues only short-lived access credential and revokes refresh', async () => {
  const stages = [];
  let state = '';
  const origin = 'https://test.neoy.example';
  const fetcher = async (url, init) => {
    const target = new URL(url);
    stages.push(target.pathname);
    if (target.pathname === '/register') {
      const data = JSON.parse(init.body);
      assert.deepEqual(data.redirect_uris, ['http://127.0.0.1:8765/neo/oauth/callback']);
      return Response.json({ client_id: 'neo-dcr-test' }, { status: 201 });
    }
    if (target.pathname === '/authorize' && init.method === 'GET') {
      assert.equal(target.searchParams.get('code_challenge_method'), 'S256');
      state = target.searchParams.get('state');
      return new Response('<input type="hidden" name="rid" value="test-request-id">');
    }
    if (target.pathname === '/authorize') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('token'), 'operator-SECRET');
      assert.equal(form.get('rid'), 'test-request-id');
      return new Response(null, {
        status: 302,
        headers: { location: 'http://127.0.0.1:8765/neo/oauth/callback?' +
          new URLSearchParams({ code: 'auth-code', state, iss: origin }) },
      });
    }
    if (target.pathname === '/token') {
      const form = new URLSearchParams(init.body);
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('code'), 'auth-code');
      assert.ok(form.get('code_verifier').length >= 43);
      return Response.json({ access_token: 'one-hour-token', expires_in: 3600, refresh_token: 'never-send-to-z' });
    }
    if (target.pathname === '/revoke') {
      assert.equal(new URLSearchParams(init.body).get('token'), 'never-send-to-z');
      return new Response(null, { status: 200 });
    }
    throw new Error('Unexpected request ' + url);
  };
  const token = await issueZWorkerCredential({ origin, operatorToken: 'operator-SECRET', fetcher });
  assert.equal(token, 'one-hour-token');
  assert.deepEqual(stages, ['/register', '/authorize', '/authorize', '/token', '/revoke']);
});

test('Z worker OAuth fails closed without an operator credential', async () => {
  await assert.rejects(() => issueZWorkerCredential({
    origin: 'https://test.neoy.example',
    operatorToken: '',
    fetcher: async () => { throw new Error('Network request must not occur'); },
  }), /operator token file/);
});

test('Z worker OAuth rejects untrusted origins', async () => {
  await assert.rejects(() => issueZWorkerCredential({
    origin: 'http://remote.example',
    operatorToken: 'secret',
  }), /must be HTTPS/);
});
