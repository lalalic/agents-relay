import { GhApiClient } from './github-client.js';
import { DisabledGitHubClient, noGitHubMode } from './no-github.js';
import { GitHubStore, type GitHubClient } from './store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { relayStoreDirectory, relayStorePath, relayJobStorePath, SQLiteRelayStore } from './relay-store.js';

export type LocalManagedStore = { store: LocalAuthorityDurableStore; relay: SQLiteRelayStore };

/** Open the canonical V2 SQLite authority without making any GitHub request. */
export function openLocalManagedStore(
  repository: string,
  prNumber: number,
  options: { client?: GitHubClient; trustedAuthors?: ReadonlySet<string>; directory?: string; noGitHub?: boolean; jobId?: string } = {},
): LocalManagedStore {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || repository.includes('..') || !Number.isInteger(prNumber) || prNumber < 0 || (prNumber === 0 && !options.jobId)) {
    throw new Error('Local managed store requires a repository and either a positive PR number or immutable jobId');
  }
  const directory = options.directory ?? relayStoreDirectory();
  const relay = new SQLiteRelayStore(prNumber === 0 ? relayJobStorePath(directory, options.jobId!) : relayStorePath(directory, repository, prNumber));
  const client = prNumber === 0 || options.noGitHub || noGitHubMode() ? new DisabledGitHubClient() : options.client ?? new GhApiClient();
  const github = new GitHubStore(client, repository, prNumber, options.trustedAuthors ?? new Set<string>());
  return {
    relay,
    store: new LocalAuthorityDurableStore(relay, github, (relatedRepository, relatedPr) =>
      openLocalManagedStore(relatedRepository, relatedPr, options).store, options.noGitHub || noGitHubMode()),
  };
}
