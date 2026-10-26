import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeReviewerTerminalEvent } from '../../dist/review-terminal-normalization.js';
import { executionEventSource } from '../../dist/reconciler-runtime.js';
const read = path => readFileSync(new URL('../../'+path,import.meta.url),'utf8');
const contract = read('skills/agents-relay/contracts/event-contract.md');
const reviewer = read('skills/agents-relay/agents/reviewer.agent.md');
const worker = read('skills/agents-relay/agents/implementation.agent.md');
const troubleshooter = read('skills/agents-relay/agents/troubleshooter.agent.md');
const event = (data,type='task.completed') => ({type,job_id:'481',task_id:'46',data});
test('canonical execution source is stable',()=>{
  assert.equal(executionEventSource('481','46','exec'),'job/481/task/46/execution/exec');
});
test('agent instruction contract stays aligned with canonical terminal ownership',()=>{
  assert.match(contract,/exactly one/);
  assert.match(contract,/task\.blocked.*task\.unblocked/);
  assert.match(reviewer,/task\.completed/);assert.match(reviewer,/data\.head_sha/);
  assert.match(worker,/task\.completed.*task\.failed/);
  assert.match(troubleshooter,/only a Troubleshooter can become BLOCKED/i);
  assert.match(troubleshooter,/ordinary Tasks never enter BLOCKED or UNBLOCKED/i);
  assert.doesNotMatch(contract,/task\.heartbeat/);
  assert.doesNotMatch(read('src/managed-worker-input.ts'),/task\.heartbeat/);
  assert.match(contract,/exact current execution/);
});
test('production reviewer normalization keeps approved and changes-required identities',()=>{
  for (const [verdict,type] of [['approved','review.approved'],['changes-required','review.changes_required']]) {
    const result=normalizeReviewerTerminalEvent(event({verdict,head_sha:'aabbcc',findings:[{message:'x'}]}));
    assert.equal(result?.type,type);assert.equal(result?.data?.outcome?.head_sha,'aabbcc');
  }
});
test('production normalization rejects incomplete and ambiguous reviewer events',()=>{
  for(const data of [{verdict:'approved'}, {head_sha:'aabbcc'}, {verdict:'unknown',head_sha:'aabbcc'}]) {
    assert.equal(normalizeReviewerTerminalEvent(event(data)),null);
  }
  assert.equal(normalizeReviewerTerminalEvent(event({verdict:'approved',head_sha:'aabbcc'},'task.failed')),null);
});
test('reviewer failure is not approval',()=>{
  const normalized=normalizeReviewerTerminalEvent(event({verdict:'blocked',head_sha:'aabbcc'}));
  assert.equal(normalized.type,'task.failed');
});

test('managed agent prompt references canonical contracts without duplicating lifecycle rules', async () => {
  const { taskReferencePrompt } = await import('../../dist/task-context.js');
  const path='/Users/chengli/Workspace/agents-relay/skills/agents-relay/contracts/event-contract.md';
  const managed='[Required event contracts]\nExecution source: job/481/task/46/execution/exec';
  const prompt=taskReferencePrompt('lalalic/agents-relay','481','46','exec',managed);
  const source=read('src/managed-worker-input.ts');
  assert.ok(prompt.includes(path));
  assert.ok(prompt.includes('Read and follow both contracts before execution'));
  assert.ok(source.includes('[Required event contracts]'));
  assert.ok(source.includes(path));
  assert.ok(!source.includes('Every lifecycle event for this execution MUST set source.id'));
});
