import { createHmac, timingSafeEqual } from 'node:crypto';
import { IncomingHttpHeaders } from 'node:http';

export type PackagePublication = { package: string; version: string; registry: string | null; sha: string | null };
export type GitHubWebhookWake = { deliveryId: string; event: string; action: string | null; repository: string | null; pullRequest: number | null; publication: PackagePublication | null };
export const PACKAGE_PUBLISHED_MARKER = 'agents-relay:package-published:v1';
const WAKE_EVENTS = new Set(['pull_request', 'issue_comment', 'pull_request_review', 'pull_request_review_comment', 'check_run', 'check_suite', 'workflow_run']);

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

export function parseGitHubWebhook(headers: IncomingHttpHeaders, body: Buffer): GitHubWebhookWake | null {
  const deliveryId = String(headers['x-github-delivery'] ?? '');
  const event = String(headers['x-github-event'] ?? '');
  if (!deliveryId || !WAKE_EVENTS.has(event)) return null;
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body.toString('utf8')) as Record<string, unknown>; } catch { return null; }
  const repository = payload.repository as Record<string, unknown> | undefined;
  const pullRequest = payload.pull_request as Record<string, unknown> | undefined;
  const issue = payload.issue as Record<string, unknown> | undefined;
  const number = Number(pullRequest?.number ?? (issue?.pull_request ? issue.number : 0));
  const comment = payload.comment as Record<string, unknown> | undefined;
  const publication = event === 'issue_comment' ? parsePackagePublicationMarker(comment?.body) : null;
  return {
    deliveryId,
    event,
    action: typeof payload.action === 'string' ? payload.action : null,
    repository: typeof repository?.full_name === 'string' ? repository.full_name : null,
    pullRequest: Number.isInteger(number) && number > 0 ? number : null,
    publication,
  };
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
