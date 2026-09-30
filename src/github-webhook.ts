import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';

export type PackagePublication = { package: string; version: string; registry: string | null; sha: string | null };
export type GitHubPullRequestFacts = { state: 'OPEN' | 'MERGED' | 'CLOSED'; head: { ref: string; sha: string } | null };
export type GitHubWebhookWake = {
  deliveryId: string;
  event: 'pull_request' | 'issue_comment';
  action: string | null;
  repository: string;
  pullRequest: number;
  publication: PackagePublication | null;
  pullRequestFacts: GitHubPullRequestFacts | null;
};
export const PACKAGE_PUBLISHED_MARKER = 'agents-relay:package-published:v1';

export function parsePackagePublicationMarker(body: unknown): PackagePublication | null {
  if (typeof body !== 'string') return null;
  const prefix = '<!-- ' + PACKAGE_PUBLISHED_MARKER + ' ';
  const start = body.indexOf(prefix);
  if (start < 0) return null;
  const end = body.indexOf(' -->', start + prefix.length);
  if (end < 0) return null;
  let value: Record<string, unknown>;
  try { value = JSON.parse(body.slice(start + prefix.length, end)) as Record<string, unknown>; } catch { return null; }
  if (typeof value.package !== 'string' || !value.package || typeof value.version !== 'string' || !value.version) return null;
  return {
    package: value.package,
    version: value.version,
    registry: typeof value.registry === 'string' ? value.registry : null,
    sha: typeof value.sha === 'string' ? value.sha : null,
  };
}

export function verifyGitHubWebhook(secret: string, body: Buffer, signature: string | undefined): boolean {
  if (!secret || !signature?.startsWith('sha256=')) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function pullRequestFacts(payload: Record<string, unknown>, action: string | null): GitHubPullRequestFacts | null {
  if (action !== 'synchronize' && action !== 'closed') return null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  if (!pr) return null;
  const head = pr.head as Record<string, unknown> | undefined;
  const ref = typeof head?.ref === 'string' ? head.ref : null;
  const sha = typeof head?.sha === 'string' ? head.sha : null;
  if (!ref || !sha) return null;
  if (action === 'closed') return { state: pr.merged === true ? 'MERGED' : 'CLOSED', head: { ref, sha } };
  return { state: 'OPEN', head: { ref, sha } };
}

export function parseGitHubWebhook(headers: IncomingHttpHeaders, body: Buffer): GitHubWebhookWake | null {
  const deliveryId = String(headers['x-github-delivery'] ?? '');
  const event = String(headers['x-github-event'] ?? '');
  if (!deliveryId || (event !== 'pull_request' && event !== 'issue_comment')) return null;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>; } catch { return null; }
  const repository = payload.repository as Record<string, unknown> | undefined;
  const repositoryName = typeof repository?.full_name === 'string' ? repository.full_name : null;
  const action = typeof payload.action === 'string' ? payload.action : null;
  const pr = payload.pull_request as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const number = Number(pr?.number ?? (issue?.pull_request ? issue.number : 0));
  if (!repositoryName || !Number.isInteger(number) || number <= 0) return null;

  if (event === 'issue_comment') {
    const comment = payload.comment as Record<string, unknown> | undefined;
    const publication = parsePackagePublicationMarker(comment?.body);
    if (!publication) return null;
    return { deliveryId, event, action, repository: repositoryName, pullRequest: number, publication, pullRequestFacts: null };
  }

  const facts = pullRequestFacts(payload, action);
  if (!facts) return null;
  return { deliveryId, event, action, repository: repositoryName, pullRequest: number, publication: null, pullRequestFacts: facts };
}

export class DeliveryDeduper {
  private readonly seen = new Map<string, number>();
  constructor(private readonly ttlMs = 86400000, private readonly maxEntries = 10000) {}
  accept(id: string, now = Date.now()): boolean {
    for (const [key, expires] of this.seen) if (expires <= now) this.seen.delete(key);
    if (this.seen.has(id)) return false;
    this.seen.set(id, now + this.ttlMs);
    while (this.seen.size > this.maxEntries) this.seen.delete(this.seen.keys().next().value as string);
    return true;
  }
}
