import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { parseSpecialistReview, selectReviewPanel, createSpecialistReviewTasks, synthesizeReview } from '../dist/review-chair.js';

const target = { artifact: 'demo.mp4', version: 'sha-123' };

test('Review Chair selects visible specialist roles with durable rationale', () => {
  const panel = selectReviewPanel([
    { agent: 'video-director', dimensions: ['video'] },
    { agent: 'market', dimensions: ['marketing'] },
    { agent: 'style', dimensions: ['visual'] },
    { agent: 'duplicate-video', dimensions: ['video'] },
  ], [{ name: 'video' }, { name: 'marketing' }, { name: 'visual' }]);
  assert.deepEqual(panel.map(item => item.agent), ['video-director', 'market', 'style']);
  assert.match(panel[0].reason, /video/);
});

test('specialist task metadata preserves one immutable target and avoids duplicate rounds', () => {
  const panel = [{ agent: 'market', dimension: 'marketing', reason: 'matches audience review' }];
  const existing = [{ id: 'review-market', agentName: 'market', review: { role: 'specialist', target, dimension: 'marketing' } }];
  assert.deepEqual(createSpecialistReviewTasks(existing, target, panel), []);
  assert.deepEqual(createSpecialistReviewTasks([], target, panel), [{ role: 'specialist', target, dimension: 'marketing', selectionReason: 'matches audience review', round: 1 }]);
});

test('Review Chair parses structured findings and synthesizes deduplicated actions', () => {
  const review = parseSpecialistReview({
    reviewer: 'market', dimension: 'marketing', target, verdict: 'concern',
    findings: [{ reviewer: 'market', dimension: 'marketing', verdict: 'fail', summary: 'CTA is unclear', severity: 'P1', location: '00:03', recommendation: 'Rewrite the CTA', evidence: 'Audience test note' }],
  });
  const second = { ...review, reviewer: 'video-director', dimension: 'video', findings: [{ ...review.findings[0], reviewer: 'video-director', dimension: 'video', verdict: 'concern' }] };
  const panel = [
    { agent: 'market', dimension: 'marketing', reason: 'audience' },
    { agent: 'video-director', dimension: 'video', reason: 'story' },
    { agent: 'style', dimension: 'visual', reason: 'missing visual pass' },
  ];
  const synthesis = synthesizeReview(target, panel, [review, second]);
  assert.equal(synthesis.findings.length, 1);
  assert.equal(synthesis.actions[0].priority, 'P1');
  assert.equal(synthesis.conflicts.length, 1);
  assert.deepEqual(synthesis.missingDimensions, ['visual']);
  assert.equal(synthesis.needsAdditionalSpecialist, true);
});

test('Review Chair rejects specialist output for a different immutable version', () => {
  assert.throws(() => synthesizeReview(target, [], [{ reviewer: 'market', dimension: 'marketing', target: { artifact: 'demo.mp4', version: 'sha-old' }, verdict: 'pass', findings: [] }]), /expected demo\.mp4@sha-123/);
});
