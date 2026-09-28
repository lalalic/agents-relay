import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { parseJobTagJson, acceptedReportedTag } from '../dist/task-tag.js';

test('Job tag parses description and allowed values', () => {
  assert.deepEqual(parseJobTagJson('{\"description\":\"E2E outcome\",\"values\":{\"pass\":\"✅\",\"fail\":\"❌\"}}'), { description: 'E2E outcome', values: { pass: '✅', fail: '❌' } });
  assert.throws(() => parseJobTagJson('{\"description\":\"x\",\"values\":{}}'), /non-empty object/);
});

test('reported tag accepts only an allowed Job tag value', () => {
  const job = { tag: { description: 'E2E outcome', values: { pass: '✅', fail: '❌' } } };
  assert.equal(acceptedReportedTag(job, { tag: 'pass' }), 'pass');
  assert.equal(acceptedReportedTag(job, { tag: 'maybe' }), undefined);
});
