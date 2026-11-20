// Remote GitHub capabilities are no longer porting obligations: both current
// executable entrypoints are local Git/SQLite only. Assert the ORIGINAL Node
// runtime itself fails closed, not merely a documentation/checklist assumption.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {noGitHubMode,DisabledGitHubClient} from '../../dist/no-github.js';
import {startServiceExternalActionFlusher} from '../../dist/service-external-actions.js';
import {LocalAuthorityDurableStore} from '../../dist/local-authority-store.js';
import {rejectRemoteLifecycleOptions} from '../../dist/cli-support.js';

test('local Git-only daemon disables all GitHub credentials, network providers, and PR CLI switches',async()=>{
 const source=readFileSync(new URL('../../src/relayd.ts',import.meta.url),'utf8');
 assert.match(source,/\bconst noGitHub = true;/);
 assert.match(source,/\bconst client = new DisabledGitHubClient\(\)/);
 assert.equal(noGitHubMode(),true);
 assert.equal(noGitHubMode(['--pr','12','--github-token','FAKE']),true);
 const disabled=new DisabledGitHubClient();
 for(const method of ['request','graphql','rateLimitSnapshot','currentLogin']){
  await assert.rejects(disabled[method](),/GitHub disabled/);
 }
 for(const flag of ['--pr','--pr=1','--github-repo','--github-token',
  '--github-app-id','--github-app-installation-id','--no-github','--projection-ms']){
  assert.throws(()=>rejectRemoteLifecycleOptions([flag]),/Unsupported option/);
 }
});
test('disabled production local store never starts remote projection flusher',async()=>{
 let calls=0;
 const store=Object.create(LocalAuthorityDurableStore.prototype);
 Object.defineProperty(store,'noGitHub',{value:true});
 Object.defineProperty(store,'projection',{
  value:{flushOnce:async()=>{calls++;return {projected:1,deferred:0};}}
 });
 const stop=startServiceExternalActionFlusher(store,{reconcile:async()=>{calls++;}},
  'fixture-immutable-id',12);
 assert.equal(typeof stop,'function');
 await new Promise(resolve=>setTimeout(resolve,75));
 await stop();
 assert.equal(calls,0,'disabled GitHub Store cannot trigger external effect/reconcile');
});
