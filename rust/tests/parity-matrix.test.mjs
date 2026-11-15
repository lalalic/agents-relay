import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const matrix = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../docs/rust-parity-matrix.json'), 'utf8'));

test('every unresolved Rust parity capability has one verified convergence milestone', () => {
  const allowedStatuses = new Set(matrix.statuses);
  for (const item of matrix.capabilities) {
    assert.ok(allowedStatuses.has(item.status), `unknown parity status ${item.status}`);
  }
  assert.equal(
    new Set(matrix.capabilities.map((item) => item.capability)).size,
    matrix.capabilities.length,
    'each parity capability has one matrix row',
  );
  const unresolved = matrix.capabilities
    .filter((item) => item.status === 'FAIL' || item.status === 'NOT_RUN')
    .map((item) => item.capability)
    .sort();
  const planned = matrix.convergencePlan.flatMap((milestone) => milestone.capabilities).sort();

  assert.deepEqual(planned, unresolved);
  assert.equal(new Set(planned).size, planned.length, 'each unresolved capability belongs to one milestone');
  for (const milestone of matrix.convergencePlan) {
    assert.ok(milestone.plannedVerification.trim());
    assert.ok(milestone.evidenceOwner.trim());
    assert.ok(milestone.cutoverBlocker.trim());
  }
});
