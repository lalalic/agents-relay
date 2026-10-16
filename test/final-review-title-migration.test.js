import test from './test-runtime.js';
import assert from 'node:assert/strict';
import { normalizeLegacyJobPrNumber } from '../dist/job-pr-number-migration.js';

const task = (id, title, agentName = 'reviewer') => ({ id, title, agentName, input: 'Job ID: 476\n\nReview PR #0 at head SHA' });

test('legacy final-review titles migrate without changing identifiers or unrelated task history', () => {
  const job = { id: '476', title: 'Markcut release and Relay publish-event dashboard E2E', prNumber: 0, tasks: [
    task('final-review-35d56eb6b9a9', 'Job ID: 476'),
    task('final-review-47757d06a89d', 'Final review: existing meaningful title'),
    task('troubleshoot-final-review-35d56eb6b9a9', 'Job ID: 476'),
    task('38', 'Job ID: 476', 'implementation'),
  ] };
  const normalized = normalizeLegacyJobPrNumber(job);
  assert.equal(normalized.tasks[0].title, 'Final review: Markcut release and Relay publish-event dashboard E2E');
  assert.equal(normalized.tasks[1].title, 'Final review: existing meaningful title');
  assert.equal(normalized.tasks[2].title, 'Job ID: 476');
  assert.equal(normalized.tasks[3].title, 'Job ID: 476');
  assert.equal(normalized.prNumber, 0);
  assert.equal(normalizeLegacyJobPrNumber(normalized).tasks[0].title, normalized.tasks[0].title);
});
