import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { failureComment, recordFailure } from '../scripts/report-package-failed.mjs';

const input = { repository:'lalalic/agents-relay',sha:'abc123',runId:'123',attempt:1,stage:'Run test suite',runUrl:'https://github.com/lalalic/agents-relay/actions/runs/123',details:'source-size: 520 lines' };
test('publish failure report correlates merged PR and includes actionable diagnostics', async () => {
  const posted=[];
  const gh=async (path,init={})=>{
    if(path.endsWith('/pulls')) return [{number:263,merged_at:'2026-10-08T10:00:00Z'}];
    if(path.includes('/comments') && !init.method) return [];
    if(init.method==='POST'){posted.push(JSON.parse(init.body).body);return {};}
    throw Error(path);
  };
  assert.deepEqual(await recordFailure(input,gh),{recorded:true,pr:263});
  assert.match(posted[0],/520 lines/);
  assert.match(posted[0],/Run test suite/);
});
test('publish failure recorder deduplicates run attempt', async () => {
  const gh=async path=>path.endsWith('/pulls')?[{number:263,merged_at:'2026-10-08T10:00:00Z'}]:[{body:failureComment(input)}];
  assert.deepEqual(await recordFailure(input,gh),{recorded:false,reason:'duplicate',pr:263});
});
test('publish failure recorder ignores missing PR correlation', async () => {
  assert.deepEqual(await recordFailure(input,async()=>[]),{recorded:false,reason:'no-correlated-merged-pr'});
});
