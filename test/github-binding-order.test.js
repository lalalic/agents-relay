import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { orderGitHubBindingCandidates } from '../dist/github-binding-order.js';
const at='2026-10-10T00:00:00.000Z';
const job=(id,state,prNumber=0)=>({id,title:id,repository:'owner/repo',prNumber,state,continuation:null,createdAt:at,updatedAt:at,tasks:[]});

test('GitHub binding prioritizes fresh unbound ACTIVE jobs ahead of terminal projection debt',()=>{
  const ordered=orderGitHubBindingCandidates([
    {snapshotPath:'terminal',job:job('old-completed','COMPLETED',27)},
    {snapshotPath:'bound',job:job('active-bound','ACTIVE',28)},
    {snapshotPath:'fresh',job:job('fresh-unbound','ACTIVE',undefined)},
  ]);
  assert.deepEqual(ordered.map(x=>x.job.id),['fresh-unbound','active-bound','old-completed']);
});
