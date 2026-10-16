import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteRelayStore, relayUnifiedStorePath } from '../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../dist/local-authority-store.js';
import { InMemoryStore } from '../dist/store.js';
import { MemoryEventBus } from '../dist/events.js';
import { handleServicePublication } from '../dist/service-publication.js';

const at = new Date().toISOString();
const job = { id: 'publish-service', title: 'Release', repository: 'owner/repo', prNumber: 22,
  state: 'ACTIVE', executionMode: 'fixed', reviewEnabled: false, autoMerge: false,
  createdAt: at, updatedAt: at, continuation: null, tasks: [] };

test('single-job GitHub webhook records facts without changing lifecycle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'relay-service-publish-'));
  const directory = join(dir, 'stores');
  const sqlite = new SQLiteRelayStore(relayUnifiedStorePath(directory), job.id);
  const store = new LocalAuthorityDurableStore(sqlite, new InMemoryStore());
  const bus = new MemoryEventBus();
  const observed = [];
  await bus.subscribeAll(async e => { observed.push(e); });
  const failure = { runId: '991', attempt: 1, stage: 'npm-publish', sha: 'abc1234' };
  const wake = { deliveryId: 'delivery-failed', event: 'issue_comment', action: 'created',
    repository: job.repository, pullRequest: job.prNumber, publication: null,
    publishFailure: failure, pullRequestFacts: null };
  try {
    await store.saveJob(job);
    await handleServicePublication(job, wake, bus, directory);
    await handleServicePublication(job, wake, bus, directory);
    assert.deepEqual((await store.load(job.id)).tasks, []);
    assert.equal((await store.load(job.id)).state, 'ACTIVE');
    assert.equal(observed.filter(e => e.type === 'package.publish_failed').length, 2);
    assert.equal(observed[0].event_id, observed[1].event_id);
    let stored = await sqlite.loadPublication(job.id);
    assert.equal(stored.failure.stage, 'npm-publish');
    assert.equal((await sqlite.listPublicationEvents(job.id)).length, 1);

    const publication = { package: 'agents-relay', version: '2.2.0', registry: null, sha: 'abc1234' };
    await handleServicePublication(job, { ...wake, deliveryId: 'delivery-success',
      publication, publishFailure: null }, bus, directory);
    stored = await sqlite.loadPublication(job.id);
    assert.equal(stored.latest.version, '2.2.0');
    assert.equal(stored.failure, null);
    assert.deepEqual((await store.load(job.id)).tasks, []);
    assert.equal((await sqlite.listPublicationEvents(job.id)).length, 2);
  } finally { sqlite.close(); await rm(dir, { recursive: true, force: true }); }
});
