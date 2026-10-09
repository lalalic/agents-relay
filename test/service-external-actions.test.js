import test, { managedReconciler } from './test-runtime.js';
import assert from 'node:assert/strict';
import { SQLiteRelayStore } from '../dist/relay-store.js';
import { LocalAuthorityDurableStore } from '../dist/local-authority-store.js';
import { InMemoryStore } from '../dist/store.js';
import { flushServiceExternalActions } from '../dist/service-external-actions.js';

const at = new Date().toISOString();
const task = {
  jobId:'service-job', id:'work', parentTaskId:null, dependencies:[], capabilities:[],
  adapter:'orchestrator', input:'done', state:'SUCCEEDED', attempt:1, maxAttempts:1,
  leaseOwner:null, leaseExpiresAt:null, executionId:null, threadId:null,
  result:{summary:'done'}, error:null, timeoutMs:0, createdAt:at, updatedAt:at,
  continuation:null, continuationDeliveredAt:null,
};
const job = {
  id:'service-job', title:'service', repository:'owner/repo', prNumber:7,
  state:'ACTIVE', executionMode:'fixed', reviewEnabled:false, autoMerge:true,
  headSha:'abc123', continuation:null, createdAt:at, updatedAt:at, tasks:[task],
};

test('single-job service flusher delivers queued external merge and graph-completes Job', async () => {
  const relay = new SQLiteRelayStore(':memory:');
  const remote = new InMemoryStore();
  let merges = 0;
  remote.mergePullRequest = async sha => { merges++; assert.equal(sha,'abc123'); };
  let store; store = new LocalAuthorityDurableStore(relay, remote, () => store, false);
  await store.saveJob(job);
  await store.applyPullRequestFacts({
    state:'OPEN', head:{ref:'feature',sha:'abc123'}, observedAt:at,
  });
  await store.mergePullRequest('abc123');
  assert.equal(await relay.pendingProjectionCount(),1);
  const reconciler = managedReconciler(store,{
    owner:'service-flush-test',adapters:[],maxConcurrent:0,
    projectPathForJob:()=>process.cwd(),
  });
  assert.equal(await flushServiceExternalActions(store,reconciler,'service-job'),1);
  assert.equal(merges,1);
  assert.equal(await store.pullRequestState(),'MERGED');
  assert.equal((await store.load('service-job')).state,'COMPLETED');
  assert.equal(await relay.pendingProjectionCount(),0);
  await reconciler.close();
  relay.close();
});

test('single-job service flusher is a no-op in --no-github mode', async () => {
  const relay = new SQLiteRelayStore(':memory:');
  const store = new LocalAuthorityDurableStore(relay,new InMemoryStore(),undefined,true);
  await store.saveJob(job);
  const reconciler = managedReconciler(store,{owner:'service-local-only',adapters:[],noGitHub:true,maxConcurrent:0});
  assert.equal(await flushServiceExternalActions(store,reconciler,'service-job'),0);
  assert.equal(await relay.pendingProjectionCount(),0);
  await reconciler.close();
  relay.close();
});
