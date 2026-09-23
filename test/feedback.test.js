import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FEEDBACK_MARKER,
  FileFeedbackStore,
  materializeFeedback,
  parseFeedbackMarker,
  readFeedbackAttachment,
  renderFeedbackMarker,
} from '../dist/feedback.js';

const provenance = { source: 'public-site', product: 'demo', surface: 'help', actorClass: 'external-user', submittedAt: '2026-09-23T12:00:00Z' };

async function withStore(run) {
  const root = await mkdtemp(join(tmpdir(), 'agents-relay-feedback-'));
  try { return await run(root); } finally { await rm(root, { recursive: true, force: true }); }
}

test('materializes text-only feedback with structured provenance and marker', async () => {
  await withStore(async root => {
    const result = await materializeFeedback(root, { text: 'The setup was clear.', provenance });
    assert.equal(result.record.schema, FEEDBACK_MARKER);
    assert.equal(result.record.userContent.text, 'The setup was clear.');
    assert.equal(result.record.triage.status, 'new');
    assert.deepEqual(parseFeedbackMarker(renderFeedbackMarker(result.record)).userContent, undefined);
    assert.equal((await new FileFeedbackStore(root).read(result.record.id)).id, result.record.id);
  });
});

test('stores images separately and preserves attachment metadata and integrity', async () => {
  await withStore(async root => {
    const bytes = new TextEncoder().encode('png fixture');
    const result = await materializeFeedback(root, { text: 'See screenshot', provenance, attachments: [{ filename: '../screen.png', mediaType: 'image/png', data: bytes }] });
    assert.equal(result.record.attachments.length, 1);
    const attachment = result.record.attachments[0];
    assert.equal(attachment.filename, 'screen.png');
    assert.deepEqual(Array.from(await readFeedbackAttachment(root, attachment)), Array.from(bytes));
    assert.equal(parseFeedbackMarker(renderFeedbackMarker(result.record)).attachments[0].storageRef, attachment.storageRef);
  });
});

test('supports multiple attachments, idempotency, and rejects unsafe uploads', async () => {
  await withStore(async root => {
    const store = new FileFeedbackStore(root, { maxAttachments: 2, maxAttachmentBytes: 4 });
    const submission = { text: 'two files', provenance, idempotencyKey: 'request-1', attachments: [
      { filename: 'a.jpg', mediaType: 'image/jpeg', data: new Uint8Array([1, 2]) },
      { filename: 'b.webp', mediaType: 'image/webp', data: new Uint8Array([3, 4]) },
    ] };
    const first = await store.submit(submission);
    const second = await store.submit(submission);
    assert.equal(second.record.id, first.record.id);
    await assert.rejects(() => store.submit({ ...submission, idempotencyKey: 'request-2', attachments: [{ filename: 'x.txt', mediaType: 'text/plain', data: new Uint8Array([1]) }] }), /unsupported attachment/);
    await assert.rejects(() => store.submit({ ...submission, idempotencyKey: 'request-3', attachments: [{ filename: 'x.png', mediaType: 'image/png', data: new Uint8Array([1, 2, 3, 4, 5]) }] }), /exceeds/);
  });
});

test('does not persist undocumented upload metadata', async () => {
  await withStore(async root => {
    const result = await materializeFeedback(root, { text: 'safe', provenance: { ...provenance, contact: { channel: 'email', value: 'user@example.test' } } });
    const raw = await readFile(result.recordRef, 'utf8');
    assert.equal(raw.includes('provider'), false);
    assert.equal(raw.includes('token'), false);
    assert.equal(result.record.systemProvenance.contact?.value, 'user@example.test');
  });
});
