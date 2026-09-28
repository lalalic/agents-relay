import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { parseJobTaskFieldsJson, acceptedReportedTaskFields } from '../dist/task-fields.js';

test('Job task fields parse a bounded value-to-display contract', () => {
  assert.deepEqual(parseJobTaskFieldsJson('{\"e2e\":{\"label\":\"E2E\",\"values\":{\"pass\":\"✅\",\"fail\":\"❌\"}}}'), { e2e: { label: 'E2E', values: { pass: '✅', fail: '❌' } } });
  assert.throws(() => parseJobTaskFieldsJson('{\"e2e\":{\"values\":{}}}'), /non-empty object/);
  assert.throws(() => parseJobTaskFieldsJson('{\"bad field\":{\"values\":{\"pass\":\"ok\"}}}'), /invalid field name/);
});

test('reported Task fields accept only declared names and values', () => {
  const job = { taskFields: { e2e: { values: { pass: '✅', fail: '❌' } } } };
  assert.deepEqual(acceptedReportedTaskFields(job, { taskFields: { e2e: 'pass', other: 'x' } }), { e2e: 'pass' });
  assert.equal(acceptedReportedTaskFields(job, { taskFields: { e2e: 'maybe' } }), undefined);
});
