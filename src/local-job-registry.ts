import { InMemoryStore } from './store.js';
import { LocalAuthorityDurableStore } from './local-authority-store.js';
import { discoverLocalRelayStoreSnapshots, SQLiteRelayStore } from './relay-store.js';

/** Resolve exactly one SQLite-backed Job from its immutable ID, independent of PR binding. */
export function createJobIdRegistryResolver(
  directory: string,
  openStores: Map<string, SQLiteRelayStore>,
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
    let relay = openStores.get(snapshot.path);
    if (!relay) {
      relay = new SQLiteRelayStore(snapshot.path);
      openStores.set(snapshot.path, relay);
    }
    // The GitHub adapter cannot enter the lifecycle execution store.
    return { job, relay, store: new LocalAuthorityDurableStore(relay, new InMemoryStore(), undefined, true) };
  };
}
