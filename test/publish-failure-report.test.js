import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { failureComment, recordFailure, publishRepairIdentity } from '../scripts/report-package-failed.mjs';

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
  assert.deepEqual(await recordFailure(input,async()=>[]),{recorded:false,reason:'no-correlated-publication-target'});
});


test('publish repair identity is deterministic and prevents repair-of-repair loop', () => {
  const sha='a'.repeat(40);
  assert.deepEqual(publishRepairIdentity(sha), {jobId:'job-auto-publish-repair-aaaaaaaaaaaa',branch:'fix/auto-publish-aaaaaaaaaaaa',taskId:'repair-publish'});
  assert.equal(publishRepairIdentity(sha,'fix/auto-publish-bbbbbbbbbbbb'),null);
  assert.throws(() => publishRepairIdentity('bad'),/Invalid published/);
});

test('failed publish creates one deterministic Relay repair Job and Task', async () => {
  const { enqueuePublishRepair } = await import('../scripts/report-package-failed.mjs');
  const calls=[];
  const github=async path=>{
    assert.equal(path,'/repos/lalalic/agents-relay/pulls/263');
    return {head:{ref:'feat/original-change'}};
  };
  const invoke=(program,args)=>{
    assert.equal(program,'npx');
    calls.push(args);
    if(args.includes('create') && args.includes('job')) return JSON.stringify({pr:777});
    if(args.includes('create') && args.includes('task')) return '{}';
    throw Error('Unexpected call');
  };
  const result=await enqueuePublishRepair({...input,sha:'a'.repeat(40)},263,github,invoke);
  assert.deepEqual(result,{created:true,repairPr:777,jobId:'job-auto-publish-repair-aaaaaaaaaaaa'});
  assert.equal(calls.length,2);
  assert.ok(calls[0].includes('job-auto-publish-repair-aaaaaaaaaaaa'));
  assert.ok(calls[1].includes('repair-publish'));
});


test('publish failure uses local merge Job correlation without PR merge', async () => {
  const sha='b'.repeat(40), source='c'.repeat(40);
  const message=`Agents Relay local merge\n\nAgents-Relay-Source-SHA: ${source}\nAgents-Relay-Job: job-failed-publish`;
  const calls=[];
  const gh=async(path,init={})=>{
    calls.push({path,init});
    if(path===`/repos/lalalic/agents-relay/commits/${sha}`) return {commit:{message}};
    if(path==='/repos/lalalic/agents-relay/issues?state=open&per_page=100&page=1') return [{number:100,title:'[Agents Relay] Publication events'}];
    if(path==='/repos/lalalic/agents-relay/issues/100/comments?per_page=100&page=1') return [];
    if(path==='/repos/lalalic/agents-relay/issues/100/comments'&&init.method==='POST') return {};
    throw Error(path);
  };
  const value={...input,sha};
  assert.deepEqual(await recordFailure(value,gh),{recorded:true,jobId:'job-failed-publish',issue:100,displayPrNumber:null});
  const posted=JSON.parse(calls.find(call=>call.init.method==='POST').init.body).body;
  assert.match(posted,/"jobId":"job-failed-publish"/);
});
