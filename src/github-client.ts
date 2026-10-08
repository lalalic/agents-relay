import { createSign } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { GitHubClient, GitHubGraphqlDiagnostics, GitHubRateLimitBucket, GitHubRateLimitSnapshot } from './store.js';
import { GitHubRuntimeRateUsage, GitHubTransportResponse, emptyGitHubRuntimeRateUsage, observeRuntimeRateLimit, parseGitHubCliHeaders, runtimeRejection } from './github-runtime-usage.js';
import { spawnOwnedProcess } from './owned-process.js';

export type GitHubAppAuthOptions = { appId: string; installationId: string; privateKey: string };

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export function createGitHubAppJwt(options: GitHubAppAuthOptions, now = Math.floor(Date.now() / 1000)): string {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: options.appId }));
  const unsigned = `${header}.${payload}`;
  const signer = createSign('RSA-SHA256'); signer.update(unsigned); signer.end();
  return `${unsigned}.${signer.sign(options.privateKey).toString('base64url')}`;
}

export class GhApiClient implements GitHubClient {
  private cooldownUntil = 0;
  private rateLimitFailures = 0;
  private installationToken: { value: string; expiresAt: number } | null = null;
  private rateLimitCache: { cachedAt: number; snapshot: GitHubRateLimitSnapshot } | null = null;
  private rateLimitFlight: Promise<GitHubRateLimitSnapshot> | null = null;
  private readonly rateLimitCacheTtlMs = 5 * 60_000;
  private readonly apiDiagnostics = { rest: 0, graphql: 0, rateLimit: 0 };
  private readonly graphqlDiagnostics: GitHubGraphqlDiagnostics = { operations: {}, contexts: {} };
  private runtimeRateUsage: GitHubRuntimeRateUsage = emptyGitHubRuntimeRateUsage();
  private readonly requestContext = new AsyncLocalStorage<string>();
  constructor(private readonly appAuth: GitHubAppAuthOptions | null = null) {}
  async withRequestContext<T>(context: string, work: () => Promise<T>): Promise<T> { return await this.requestContext.run(context, work); }
  private graphqlOperation(query: string): string {
    if (/mutation\s*\([^)]*\)\s*\{addComment\(/.test(query)) return 'comment.add';
    if (/updateIssueComment\(/.test(query)) return 'comment.update';
    if (/deleteIssueComment\(/.test(query)) return 'comment.delete';
    if (/viewer\s*\{login/.test(query)) return 'viewer.login';
    if (/comments\(first:100,after:\$cursor\)/.test(query)) return 'pr.comments';
    if (/comments\(last:100\)/.test(query)) return 'pr.snapshot';
    if (/headRefName/.test(query) && /headRefOid/.test(query)) return 'pr.node';
    if (/repository\(owner:\$owner,name:\$name\)\{id\}/.test(query)) return 'repository.id';
    if (/pullRequests\(/.test(query)) return 'repository.pull-requests';
    return /^\s*mutation/.test(query) ? 'mutation.other' : 'query.other';
  }
  rateLimitStatus(): { limited: boolean; cooldownUntil: string | null; calls: { rest: number; graphql: number; rateLimit: number }; graphql: GitHubGraphqlDiagnostics; runtimeRateUsage: GitHubRuntimeRateUsage } {
    const limited = Date.now() < this.cooldownUntil;
    return { limited, cooldownUntil: limited ? new Date(this.cooldownUntil).toISOString() : null, calls: { ...this.apiDiagnostics }, graphql: { operations: { ...this.graphqlDiagnostics.operations }, contexts: { ...this.graphqlDiagnostics.contexts } }, runtimeRateUsage: { resources: { ...this.runtimeRateUsage.resources }, rejection: this.runtimeRateUsage.rejection } };
  }
  async rateLimitSnapshot(force = false): Promise<GitHubRateLimitSnapshot> {
    const now = Date.now();
    if (!force && this.rateLimitCache && now - this.rateLimitCache.cachedAt < this.rateLimitCacheTtlMs) return this.rateLimitCache.snapshot;
    if (this.rateLimitFlight) return this.rateLimitFlight;
    if (this.rateLimitStatus().limited && this.rateLimitCache) return this.rateLimitCache.snapshot;
    const flight = (async (): Promise<GitHubRateLimitSnapshot> => {
      this.apiDiagnostics.rateLimit += 1;
      const stdout = await this.spawnGh(['api', 'rate_limit'], undefined, await this.commandEnv());
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      const resources = parsed.resources as Record<string, unknown> | undefined;
      const bucket = (value: unknown): GitHubRateLimitBucket | undefined => {
        const item = value as Record<string, unknown> | undefined;
        const limit = Number(item?.limit), used = Number(item?.used), remaining = Number(item?.remaining), reset = Number(item?.reset);
        return [limit, used, remaining, reset].every(Number.isFinite) ? { limit, used, remaining, reset } : undefined;
      };
      const snapshot: GitHubRateLimitSnapshot = { observedAt: new Date().toISOString(), resources: { core: bucket(resources?.core), graphql: bucket(resources?.graphql), search: bucket(resources?.search) } };
      this.rateLimitCache = { cachedAt: Date.now(), snapshot };
      return snapshot;
    })();
    this.rateLimitFlight = flight;
    try { return await flight; }
    finally { if (this.rateLimitFlight === flight) this.rateLimitFlight = null; }
  }
  private assertAvailable(): void {
    if (Date.now() < this.cooldownUntil) throw new Error(`GitHub API cooldown active until ${new Date(this.cooldownUntil).toISOString()}`);
  }
  private noteFailure(message: string): void {
    if (!/rate limit|secondary rate|HTTP 429/i.test(message)) return;
    this.rateLimitFailures += 1;
    const delay = Math.min(15 * 60_000, 60_000 * (2 ** Math.min(this.rateLimitFailures - 1, 4)));
    this.cooldownUntil = Date.now() + delay;
  }
  private noteSuccess(): void { if (Date.now() >= this.cooldownUntil) this.rateLimitFailures = 0; }
  private appJwt(now = Math.floor(Date.now() / 1000)): string {
    if (!this.appAuth) throw new Error('GitHub App authentication is not configured');
    return createGitHubAppJwt(this.appAuth, now);
  }
  private async appRequest(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Record<string, unknown>> {
    const response = await fetch(`https://api.github.com${path}`, {
      method,
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${this.appJwt()}`,
        'x-github-api-version': '2026-03-10',
        'user-agent': 'agents-relay',
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`GitHub App API ${response.status}: ${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }
  private async installationAccessToken(): Promise<string> {
    if (!this.appAuth) throw new Error('GitHub App authentication is not configured');
    if (this.installationToken && this.installationToken.expiresAt - Date.now() > 5 * 60_000) return this.installationToken.value;
    const parsed = await this.appRequest(`/app/installations/${this.appAuth.installationId}/access_tokens`, 'POST');
    const token = typeof parsed.token === 'string' ? parsed.token : '';
    const expiresAt = typeof parsed.expires_at === 'string' ? Date.parse(parsed.expires_at) : 0;
    if (!token || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error('GitHub App installation token response was invalid');
    this.installationToken = { value: token, expiresAt };
    return token;
  }
  private async commandEnv(): Promise<NodeJS.ProcessEnv> {
    if (!this.appAuth) return process.env;
    const token = await this.installationAccessToken();
    return { ...process.env, GH_TOKEN: token, GITHUB_TOKEN: token };
  }
  private async runGh(args: string[], input: string | undefined, env: NodeJS.ProcessEnv, rateLimited: boolean, includeHeaders: boolean): Promise<GitHubTransportResponse> {
    if (rateLimited) this.assertAvailable();
    const commandArgs = includeHeaders ? [args[0] ?? '', '--include', ...args.slice(1)] : args;
    return await new Promise<GitHubTransportResponse>((resolve) => {
      const child = spawnOwnedProcess('gh', commandArgs, { invocation: 'github.api', spawn: { env } }); let stdout = ''; let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      child.on('error', error => resolve({ status: null, headers: {}, body: '', stderr: error.message }));
      if (input !== undefined) child.stdin?.write(input); child.stdin?.end();
      child.on('close', (code, signal) => {
        const response = parseGitHubCliHeaders(stdout, includeHeaders);
        const failed = code !== 0;
        const message = failed ? stderr.trim() || response.body.trim() || `gh exited ${code}; signal=${signal ?? "none"}` : '';
        if (failed && rateLimited) this.noteFailure(message);
        if (!failed && rateLimited) this.noteSuccess();
        resolve({ ...response, stderr: failed ? message : undefined });
      });
    });
  }
  private async spawnGh(args: string[], input?: string, env: NodeJS.ProcessEnv = process.env, rateLimited = true): Promise<string> {
    return (await this.runGh(args, input, env, rateLimited, false)).body;
  }
  private noteRuntimeRateLimit(channel: 'rest' | 'graphql', response: GitHubTransportResponse): void {
    const observation = observeRuntimeRateLimit(channel, response, new Date().toISOString());
    this.runtimeRateUsage.resources[observation.resource] = observation;
    this.runtimeRateUsage.rejection = runtimeRejection(observation);
  }
  private async graphqlTransport(query: string, variables: Record<string, unknown>): Promise<GitHubTransportResponse> {
    const response = await this.runGh(['api', 'graphql', '--input', '-'], JSON.stringify({ query, variables }), await this.commandEnv(), true, true);
    this.noteRuntimeRateLimit('graphql', response);
    return response;
  }
  private async requestTransport(path: string, init: RequestInit): Promise<GitHubTransportResponse> {
    const args = ['api', path]; const method = String(init.method ?? 'GET');
    if (method !== 'GET') args.push('--method', method); if (init.body) args.push('--input', '-');
    const response = await this.runGh(args, init.body ? String(init.body) : undefined, await this.commandEnv(), true, true);
    this.noteRuntimeRateLimit('rest', response);
    return response;
  }
  async graphql(query: string, variables: Record<string, unknown> = {}): Promise<unknown> {
    this.assertAvailable();
    this.apiDiagnostics.graphql += 1;
    const operation = this.graphqlOperation(query);
    const context = this.requestContext.getStore() ?? 'unscoped';
    this.graphqlDiagnostics.operations[operation] = (this.graphqlDiagnostics.operations[operation] ?? 0) + 1;
    this.graphqlDiagnostics.contexts[context] = (this.graphqlDiagnostics.contexts[context] ?? 0) + 1;
    const payload = JSON.stringify({ query, variables });
    const response = await this.graphqlTransport(query, variables);
    if (response.stderr) throw new Error(response.stderr);
    const parsed = JSON.parse(response.body) as Record<string, unknown>;
    if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
      const message = JSON.stringify(parsed.errors); this.noteFailure(message); throw new Error(message);
    }
    return parsed.data ?? parsed;
  }
  async request(path: string, init: RequestInit = {}): Promise<unknown> {
    this.assertAvailable();
    this.apiDiagnostics.rest += 1;
    const args = ['api', path]; const method = String(init.method ?? 'GET');
    if (method !== 'GET') args.push('--method', method); if (init.body) args.push('--input', '-');
    const response = await this.requestTransport(path, init);
    if (response.stderr) throw new Error(response.stderr);
    const stdout = response.body;
    if (!stdout.trim()) return null;
    try { return JSON.parse(stdout) as unknown; } catch { return stdout; }
  }
  async localLogin(): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const child = spawnOwnedProcess('gh', ['auth', 'status', '--active', '--json', 'hosts'], { invocation: 'github.auth-status' }); let stdout = '';
      child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
      child.on('error', () => resolve(null));
      child.on('close', () => {
        try {
          const value = JSON.parse(stdout) as Record<string, unknown>; const hosts = value.hosts as Record<string, unknown[]> | undefined;
          const github = hosts?.['github.com']; const active = Array.isArray(github) ? github.find(item => (item as Record<string, unknown>).active === true) as Record<string, unknown> | undefined : undefined;
          resolve(typeof active?.login === 'string' && active.login.length > 0 ? active.login : null);
        } catch { resolve(null); }
      });
    });
  }
  async currentLogin(): Promise<string> {
    if (this.appAuth) {
      const app = await this.appRequest('/app');
      if (typeof app.slug === 'string' && app.slug.length > 0) return `${app.slug}[bot]`;
      throw new Error('GitHub App identity lookup returned no slug');
    } else {
      const local = await this.localLogin();
      if (local) return local;
      try {
        const value = await this.graphql('query { viewer { login } }') as Record<string, unknown>;
        const viewer = value.viewer as Record<string, unknown> | undefined;
        if (typeof viewer?.login === 'string' && viewer.login.length > 0) return viewer.login;
      } catch { /* handled below */ }
    }
    const local = await this.localLogin();
    if (local) return local;
    throw new Error('gh authentication did not return a login');
  }
}
