import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** The configured provider endpoint is part of Z's transport contract, not a
 * Neo-specific instruction embedded in every Relay worker prompt. */
export function zWorkerMcpEndpoint(origin = process.env.AGENTS_RELAY_Z_OAUTH_ORIGIN): string {
  const configured = (origin ?? '').replace(/\/$/, '');
  if (!/^https:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(configured)) throw new Error('Z OAuth origin must be HTTPS');
  return `${configured}/mcp`;
}

/** A one-hour configured OAuth credential for one Z worker; no provider is required. */
export async function issueZWorkerCredential(options: {
  origin?: string;
  operatorToken?: string;
  fetcher?: typeof fetch;
} = {}): Promise<string> {
  const endpoint = zWorkerMcpEndpoint(options.origin);
  const origin = endpoint.slice(0, -'/mcp'.length);
  const operatorToken = options.operatorToken ?? process.env.AGENTS_RELAY_Z_OAUTH_OPERATOR_TOKEN ??
    (process.env.AGENTS_RELAY_Z_OAUTH_OPERATOR_TOKEN_FILE
      ? (await readFile(process.env.AGENTS_RELAY_Z_OAUTH_OPERATOR_TOKEN_FILE, 'utf8').catch(() => '')).trim() : '');
  if (!operatorToken) throw new Error('Configure AGENTS_RELAY_Z_OAUTH_OPERATOR_TOKEN_FILE or supply an operator token');
  const fetcher = options.fetcher ?? fetch;
  const redirectUri = 'http://127.0.0.1:8765/agents-relay/oauth/callback';
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(18).toString('hex');
  const request = async (path: string, init: RequestInit): Promise<Response> =>
    fetcher(origin + path, { ...init, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
  const registration = await request('/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Agents Relay Z worker',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }),
  });
  if (registration.status !== 201) throw new Error('Z OAuth registration rejected: HTTP ' + registration.status);
  const client = await registration.json() as { client_id?: string };
  if (!client.client_id) throw new Error('Z OAuth registration returned no client_id');
  const qs = new URLSearchParams({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri,
    code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp',
    resource: origin + '/mcp', state,
  });
  const page = await request('/authorize?' + qs, { method: 'GET' });
  if (page.status !== 200) throw new Error('OAuth authorization page rejected: HTTP ' + page.status);
  const html = await page.text();
  const rid = html.match(/name="rid"\s+value="([A-Za-z0-9_-]+)"/)?.[1];
  if (!rid) throw new Error('OAuth authorization page lacked request ID');
  const approval = await request('/authorize', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ rid, token: operatorToken }),
  });
  if (approval.status !== 302) throw new Error('OAuth consent rejected: HTTP ' + approval.status);
  const location = approval.headers.get('location');
  if (!location) throw new Error('OAuth approval lacked callback');
  const callback = new URL(location);
  if (callback.origin !== new URL(redirectUri).origin || callback.pathname !== '/agents-relay/oauth/callback'
      || callback.searchParams.get('state') !== state || callback.searchParams.get('iss') !== origin) {
    throw new Error('OAuth callback state, redirect, or issuer mismatch');
  }
  const code = callback.searchParams.get('code');
  if (!code) throw new Error('OAuth callback lacked authorization code');
  const response = await request('/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: client.client_id,
      redirect_uri: redirectUri, code, code_verifier: verifier,
    }),
  });
  if (response.status !== 200) throw new Error('OAuth token exchange rejected: HTTP ' + response.status);
  const token = await response.json() as { access_token?: string; expires_in?: number; refresh_token?: string };
  if (!token.access_token || token.expires_in !== 3600) throw new Error('OAuth returned an invalid worker access token');
  // Z workers receive only access tokens, never refresh tokens or the operator credential.
  if (token.refresh_token) {
    const revoke = await request('/revoke', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: token.refresh_token }),
    });
    if (revoke.status !== 200) throw new Error('OAuth failed to revoke unused refresh credential');
  }
  return token.access_token;
}
