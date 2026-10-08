export type GitHubRuntimeResource = 'core' | 'graphql' | 'search' | 'unknown';
export type GitHubTransportResponse = {
  status: number | null;
  headers: Record<string, string>;
  body: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
};
export type GitHubObservedRateLimit = {
  resource: GitHubRuntimeResource;
  observedAt: string;
  status: number | null;
  available: boolean | null;
  throttled: boolean;
  limit: number | null;
  used: number | null;
  remaining: number | null;
  reset: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
  reason: string | null;
  headersCaptured: boolean;
};
export type GitHubRateLimitRejection = {
  resource: GitHubRuntimeResource;
  kind: 'primary' | 'secondary' | 'unknown';
  observedAt: string;
  status: number | null;
  retryAfterSeconds: number | null;
  cooldownUntil: string | null;
  reason: string;
};
export type GitHubRuntimeRateUsage = {
  resources: Partial<Record<GitHubRuntimeResource, GitHubObservedRateLimit>>;
  rejection: GitHubRateLimitRejection | null;
};

export function emptyGitHubRuntimeRateUsage(): GitHubRuntimeRateUsage {
  return { resources: {}, rejection: null };
}

function headerNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function transportResource(requestChannel: 'rest' | 'graphql', headers: Record<string, string>): GitHubRuntimeResource {
  const resource = headers['x-ratelimit-resource'];
  if (resource === 'core' || resource === 'graphql' || resource === 'search') return resource;
  return requestChannel === 'graphql' ? 'graphql' : 'core';
}

function rejectionKind(headers: Record<string, string>, reason: string): GitHubRateLimitRejection['kind'] {
  const remaining = headerNumber(headers['x-ratelimit-remaining']);
  if (remaining === 0) return 'primary';
  if (/secondary rate/i.test(reason) || headerNumber(headers['retry-after']) !== null) return 'secondary';
  if (/rate limit/i.test(reason) && remaining !== null && remaining > 0) return 'secondary';
  return 'unknown';
}

function isThrottled(status: number | null, reason: string): boolean {
  return status === 429 || /rate limit|secondary rate|graphql_rate_limit/i.test(reason);
}

export function observeRuntimeRateLimit(
  requestChannel: 'rest' | 'graphql',
  response: GitHubTransportResponse,
  observedAt: string,
): GitHubObservedRateLimit {
  const headers = response.headers;
  const reason = [response.body, response.stderr].filter(value => typeof value === 'string' && value.length > 0).join('\n').slice(0, 2000);
  const throttled = isThrottled(response.status, reason);
  return {
    resource: transportResource(requestChannel, headers),
    observedAt,
    status: response.status,
    available: throttled ? false : response.status !== null ? response.status >= 200 && response.status < 300 : null,
    throttled,
    limit: headerNumber(headers['x-ratelimit-limit']),
    used: headerNumber(headers['x-ratelimit-used']),
    remaining: headerNumber(headers['x-ratelimit-remaining']),
    reset: headerNumber(headers['x-ratelimit-reset']),
    resetAt: headerNumber(headers['x-ratelimit-reset']) === null ? null : new Date(headerNumber(headers['x-ratelimit-reset'])! * 1000).toISOString(),
    retryAfterSeconds: headerNumber(headers['retry-after']),
    reason: throttled ? reason : null,
    headersCaptured: ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'x-ratelimit-resource'].some(name => Object.hasOwn(headers, name)),
  };
}

export function runtimeRejection(observation: GitHubObservedRateLimit): GitHubRateLimitRejection | null {
  if (!observation.throttled) return null;
  const headers: Record<string, string> = {};
  if (observation.remaining !== null) headers['x-ratelimit-remaining'] = String(observation.remaining);
  if (observation.retryAfterSeconds !== null) headers['retry-after'] = String(observation.retryAfterSeconds);
  const retryAfterSeconds = observation.retryAfterSeconds;
  return {
    resource: observation.resource,
    kind: rejectionKind(headers, observation.reason ?? ''),
    observedAt: observation.observedAt,
    status: observation.status,
    retryAfterSeconds,
    cooldownUntil: retryAfterSeconds === null ? null : new Date(Date.parse(observation.observedAt) + retryAfterSeconds * 1000).toISOString(),
    reason: observation.reason ?? 'GitHub rate-limit rejection',
  };
}

export function parseGitHubCliHeaders(output: string, hadHeaders: boolean): GitHubTransportResponse {
  if (!hadHeaders) return { status: null, headers: {}, body: output };
  const boundary = output.search(/\r?\n\r?\n/);
  if (boundary < 0) return { status: null, headers: {}, body: output };
  const head = output.slice(0, boundary);
  const statusMatch = /HTTP\/[\d.]+\s+(\d{3})/.exec(head);
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    headers[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim();
  }
  return { status: statusMatch ? Number(statusMatch[1]) : null, headers, body: output.slice(boundary).replace(/^\r?\n\r?\n/, '') };
}
