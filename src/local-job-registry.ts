import { GitHubStore, InMemoryStore, type GitHubClient } from './store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { discoverLocalRelayStoreSnapshots, SQLiteRelayStore } from './relay-store.js';

/** Resolve exactly one SQLite-backed Job from its immutable ID, independent of PR binding. */
export function createJobIdRegistryResolver(
  directory: string,
  openStores: Map<string, SQLiteRelayStore>,
  options: { client?: GitHubClient; trustedAuthors?: ReadonlySet<string>; noGitHub?: boolean } = {},
) {
  return async (jobId: string) => {
    const snapshots = await discoverLocalRelayStoreSnapshots(directory);
    const matches = snapshots.flatMap(snapshot =>
      snapshot.jobs.filter(job => job.id === jobId).map(job => ({ snapshot, job })));
    // Retain historical terminal snapshots without shadowing a uniquely live Job.
    const live = matches.filter(item => !['COMPLETED', 'CANCELLED'].includes(item.job.state));
    const selected = live.length === 1 ? live[0] : live.length === 0 && matches.length === 1 ? matches[0] : null;
    if (!selected) return null;
    const { snapshot, job } = selected;
    const scopedKey = `${snapshot.path}#${job.id}`;
    let relay = openStores.get(scopedKey);
    if (!relay) {
      relay = new SQLiteRelayStore(snapshot.path, job.id);
      openStores.set(scopedKey, relay);
    }
    // SQLite remains lifecycle authority. A positive PR binding only enables
    // the external collaboration adapter for projection/merge side effects.
    const githubEnabled = !options.noGitHub && job.prNumber > 0 && options.client;
    const github = githubEnabled
      ? new GitHubStore(options.client!, job.repository, job.prNumber, options.trustedAuthors ?? new Set())
      : new InMemoryStore();
    return { job, relay, store: new LocalAuthorityDurableStore(relay, github, undefined, !githubEnabled) };
  };
}
