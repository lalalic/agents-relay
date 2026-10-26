import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseOutcomeReviewArgs, combineOutcomeReviews, evaluateOutcome } from '../dist/outcome-review.js';


test('review run adds generic reviewer and specialist roles', async () => {
  const project = mkdtempSync(join(tmpdir(), 'relay-review-'));
  mkdirSync(join(project, 'agents'));
  for (const role of ['video-director','market']) writeFileSync(join(project, 'agents', role + '.agent.md'), '# Review role');
  const args = ['--prompt', 'Assess current video revision for quality', '--project-path', project, '--agents', 'video-director,market'];
  const parsed = parseOutcomeReviewArgs(args);
  assert.deepEqual(parsed.reviewers, ['reviewer', 'video-director', 'market']);
  const seen = [];
  const result = await evaluateOutcome(parsed, (_binary, _args, opts) => {
    const role = opts.input.match(/Reviewer: ([^\n]+)/)?.[1];
    seen.push(role);
    return {status:0,stdout:JSON.stringify({verdict:role === 'market' ? 'CHANGE_REQUIRED':'PASS',findings:[],evidence:['test observation']})};
  });
  assert.deepEqual(seen, ['reviewer', 'video-director', 'market']);
  assert.equal(result.verdict, 'CHANGE_REQUIRED');
  rmSync(project, {recursive:true});
});

test('review verdict join is fail-closed', () => {
  assert.equal(combineOutcomeReviews([{verdict:'PASS'}, {verdict:'BLOCKED'}]).verdict, 'BLOCKED');
  assert.equal(combineOutcomeReviews([{verdict:'CHANGE_REQUIRED'}, {verdict:'PASS'}]).verdict, 'CHANGE_REQUIRED');
});

test('review run rejects missing prompt and invalid reviewer', () => {
  assert.throws(() => parseOutcomeReviewArgs([]), /requires exactly one/);
  assert.throws(() => parseOutcomeReviewArgs(['--prompt','x','--agents','../../bad']), /invalid reviewer/);
});
