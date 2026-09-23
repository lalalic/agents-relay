import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFeedbackRecord, feedbackFingerprint, feedbackWorkProvenance, materializeFeedback, renderFeedbackMarkdown } from '../dist/feedback.js';

const provenance = { source: 'public-site', product: 'Family Tutor', surface: 'lesson', actorClass: 'external-user', submittedAt: '2026-09-23T17:00:00.000Z' };
const submission = (extra = {}) => ({ text: 'The lesson froze after submit.', provenance, ...extra });

test('creates a text-only record with separated content, metadata, and triage', () => {
  const record = createFeedbackRecord(submission(), { id: 'feedback-1', receivedAt: '2026-09-23T17:01:00.000Z' });
  assert.equal(record.schema, 'agents-relay.feedback');
  assert.equal(record.userContent.text, 'The lesson froze after submit.');
  assert.deepEqual(record.attachments, []);
  assert.equal(record.triage.status, 'new');
  assert.equal(record.systemMetadata.visibility, 'private');
});

test('supports multiple image references and rejects invalid or oversized uploads', () => {
  const record = createFeedbackRecord(submission({ attachments: [
    { reference: 'object://feedback/a', mimeType: 'image/png', sizeBytes: 100, sha256: 'a'.repeat(64) },
    { reference: 'object://feedback/b', mimeType: 'image/jpeg', sizeBytes: 200, width: 800, height: 600 }
  ] }));
  assert.equal(record.attachments.length, 2);
  assert.equal(record.attachments[1].width, 800);
  assert.throws(() => createFeedbackRecord(submission({ attachments: [{ reference: 'x', mimeType: 'text/plain', sizeBytes: 1 }] })), /unsupported image format/);
  assert.throws(() => createFeedbackRecord(submission({ attachments: [{ reference: 'x', mimeType: 'image/png', sizeBytes: 10 * 1024 * 1024 + 1 }] })), /byte limit/);
});

test('requires explicit sanitization for public visibility and redacts common secrets', () => {
  const record = createFeedbackRecord(submission({ text: 'Bearer abc123 sk_12345678901234', visibility: 'public', sanitized: true }));
  assert.equal(record.systemMetadata.sanitized, true);
  assert.match(record.userContent.text, /\[REDACTED\]/);
  assert.throws(() => createFeedbackRecord(submission({ visibility: 'public' })), /explicitly sanitized/);
});

test('materializes a safe artifact and preserves provenance for downstream work', async () => {
  const record = createFeedbackRecord(submission({ attachments: [{ reference: 'object://feedback/screenshot', mimeType: 'image/webp', sizeBytes: 42 }] }), { id: 'feedback-42' });
  const dir = await mkdtemp(join(tmpdir(), 'agents-relay-feedback-'));
  const path = join(dir, 'feedback.json');
  await materializeFeedback(record, path);
  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(saved.id, 'feedback-42');
  assert.equal(saved.attachments[0].reference, 'object://feedback/screenshot');
  assert.equal(feedbackWorkProvenance(record).feedbackId, 'feedback-42');
  assert.match(renderFeedbackMarkdown(record), /agents-relay:feedback:v1/);
  assert.equal(feedbackFingerprint(record).length, 64);
  await rm(dir, { recursive: true, force: true });
});

test('does not accept credential-bearing attachment references', () => {
  assert.throws(() => createFeedbackRecord(submission({ attachments: [{ reference: 'https://user:secret@example.com/image', mimeType: 'image/png', sizeBytes: 1 }] })), /credential-free/);
  assert.throws(() => createFeedbackRecord(submission({ attachments: [{ reference: 'object://image?token=secret', mimeType: 'image/png', sizeBytes: 1 }] })), /credential-free/);
});
