import type { GitHubClient } from './store.js';

/** A PR is a read-only collaboration record after authoritative local completion. */
export async function archiveDisplayPullRequest(
  client: GitHubClient,
  repository: string,
  number: number,
  jobId: string,
  publishedSha: string,
  state: string,
): Promise<'already_closed' | 'archived'> {
  if (state !== 'OPEN') return 'already_closed';
  const marker = `Agents Relay local completion: ${jobId}`;
  const path = `repos/${repository}/issues/${number}/comments?per_page=100`;
  const comments = await client.request(path);
  if (!Array.isArray(comments)) throw new Error('Cannot verify PR archive comment idempotency');
  const alreadyCommented = comments.some(item => item && typeof item === 'object'
    && 'body' in item && typeof item.body === 'string' && item.body.includes(marker));
  if (!alreadyCommented) {
    await client.request(`repos/${repository}/issues/${number}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: `${marker}\nPublished local main commit: ${publishedSha}.\nThis PR is closed as a review record; GitHub did not perform a merge.` }),
    });
  }
  await client.request(`repos/${repository}/pulls/${number}`, {
    method: 'PATCH', body: JSON.stringify({ state: 'closed' }),
  });
  return 'archived';
}
