import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const FEEDBACK_SCHEMA = 'agents-relay.feedback';
export const FEEDBACK_SCHEMA_VERSION = 1 as const;
export const FEEDBACK_MARKER = 'agents-relay:feedback:v1';
export const FEEDBACK_MAX_TEXT_LENGTH = 20_000;
export const FEEDBACK_MAX_ATTACHMENTS = 10;
export const FEEDBACK_MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const FEEDBACK_IMAGE_TYPES = ['image/gif', 'image/jpeg', 'image/png', 'image/webp'] as const;

export type FeedbackSource = 'public-site' | 'extension' | 'app' | 'other';
export type FeedbackActorClass = 'external-user' | 'pilot-user' | 'internal-test';
export type FeedbackVisibility = 'private' | 'internal' | 'public';
export type FeedbackTriageStatus = 'new' | 'in-review' | 'accepted' | 'rejected' | 'duplicate' | 'resolved';

export type FeedbackProvenance = {
  source: FeedbackSource;
  product: string;
  surface?: string;
  setupStep?: string;
  actorClass: FeedbackActorClass;
  version?: string;
  build?: string;
  submittedAt: string;
};

export type FeedbackAttachmentInput = {
  reference: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
  width?: number;
  height?: number;
};

export type FeedbackAttachment = FeedbackAttachmentInput & { id: string };

export type FeedbackSubmission = {
  text: string;
  attachments?: FeedbackAttachmentInput[];
  provenance: FeedbackProvenance;
  contact?: string;
  visibility?: FeedbackVisibility;
  sanitized?: boolean;
};

export type FeedbackRecord = {
  schema: typeof FEEDBACK_SCHEMA;
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION;
  id: string;
  userContent: { text: string };
  attachments: FeedbackAttachment[];
  provenance: FeedbackProvenance;
  systemMetadata: {
    receivedAt: string;
    visibility: FeedbackVisibility;
    sanitized: boolean;
  };
  contact?: string;
  triage: { status: FeedbackTriageStatus; duplicateOf?: string; notes?: string };
  downstream: { work: FeedbackWorkReference[] };
};

export type FeedbackWorkReference = {
  kind: 'job' | 'task' | 'pr' | 'issue' | 'change';
  id: string;
  url?: string;
};

export type FeedbackMaterializationFormat = 'json' | 'markdown';

function fail(message: string): never { throw new Error(`Invalid feedback: ${message}`); }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null; }
function optionalText(value: string | undefined, field: string, max = 500): string | undefined {
  if (value === undefined) return undefined;
  if (value.length === 0 || value.length > max) fail(`${field} must contain 1-${max} characters`);
  return value;
}
function iso(value: string, field: string): string {
  if (!value || Number.isNaN(Date.parse(value))) fail(`${field} must be an ISO timestamp`);
  return value;
}

/** Redacts common bearer/API-key shapes before a product stores user text. */
export function redactSensitiveText(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/g, '[REDACTED_KEY]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]');
}

function validateReference(reference: string): string {
  if (!reference || reference.length > 2_000 || /[?#]/.test(reference) || /:\/\/[^/]*:[^@]+@/.test(reference)) {
    fail('attachment reference must be a stable, credential-free reference');
  }
  return reference;
}

function attachment(input: FeedbackAttachmentInput, index: number): FeedbackAttachment {
  if (!isObject(input)) fail(`attachments[${index}] must be an object`);
  if (!(FEEDBACK_IMAGE_TYPES as readonly string[]).includes(input.mimeType)) fail(`attachments[${index}] has an unsupported image format`);
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes <= 0 || input.sizeBytes > FEEDBACK_MAX_ATTACHMENT_BYTES) fail(`attachments[${index}] exceeds the ${FEEDBACK_MAX_ATTACHMENT_BYTES} byte limit`);
  if (input.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(input.sha256)) fail(`attachments[${index}].sha256 must be a SHA-256 hex digest`);
  for (const [key, value] of [['width', input.width], ['height', input.height]] as const) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) fail(`attachments[${index}].${key} must be a positive integer`);
  }
  return { id: `attachment-${index + 1}`, reference: validateReference(input.reference), mimeType: input.mimeType, sizeBytes: input.sizeBytes, ...(input.sha256 ? { sha256: input.sha256.toLowerCase() } : {}), ...(input.width ? { width: input.width } : {}), ...(input.height ? { height: input.height } : {}) };
}

export function createFeedbackRecord(submission: FeedbackSubmission, options: { id?: string; receivedAt?: string; sanitize?: boolean } = {}): FeedbackRecord {
  if (!isObject(submission)) fail('submission must be an object');
  if (typeof submission.text !== 'string' || submission.text.length === 0 || submission.text.length > FEEDBACK_MAX_TEXT_LENGTH) fail(`text must contain 1-${FEEDBACK_MAX_TEXT_LENGTH} characters`);
  const attachments = (submission.attachments ?? []).map(attachment);
  if (attachments.length > FEEDBACK_MAX_ATTACHMENTS) fail(`at most ${FEEDBACK_MAX_ATTACHMENTS} attachments are supported`);
  const provenance = submission.provenance;
  if (!isObject(provenance) || !provenance.product || provenance.product.length > 200) fail('provenance.product is required');
  if (!['public-site', 'extension', 'app', 'other'].includes(provenance.source)) fail('provenance.source is invalid');
  if (!['external-user', 'pilot-user', 'internal-test'].includes(provenance.actorClass)) fail('provenance.actorClass is invalid');
  iso(provenance.submittedAt, 'provenance.submittedAt');
  const visibility = submission.visibility ?? 'private';
  if (!['private', 'internal', 'public'].includes(visibility)) fail('visibility is invalid');
  if (visibility === 'public' && submission.sanitized !== true && options.sanitize !== true) fail('public feedback must be explicitly sanitized');
  const sanitized = options.sanitize === true || submission.sanitized === true;
  const text = sanitized ? redactSensitiveText(submission.text) : submission.text;
  const contact = optionalText(submission.contact, 'contact', 500);
  return {
    schema: FEEDBACK_SCHEMA,
    schemaVersion: FEEDBACK_SCHEMA_VERSION,
    id: options.id ?? `feedback-${randomUUID()}`,
    userContent: { text },
    attachments,
    provenance: { source: provenance.source, product: provenance.product, ...(optionalText(provenance.surface, 'provenance.surface') ? { surface: provenance.surface } : {}), ...(optionalText(provenance.setupStep, 'provenance.setupStep') ? { setupStep: provenance.setupStep } : {}), actorClass: provenance.actorClass, ...(optionalText(provenance.version, 'provenance.version') ? { version: provenance.version } : {}), ...(optionalText(provenance.build, 'provenance.build') ? { build: provenance.build } : {}), submittedAt: provenance.submittedAt },
    systemMetadata: { receivedAt: options.receivedAt ?? new Date().toISOString(), visibility, sanitized },
    ...(contact ? { contact } : {}),
    triage: { status: 'new' },
    downstream: { work: [] }
  };
}

export function feedbackWorkProvenance(record: FeedbackRecord): Record<string, unknown> {
  return { feedbackId: record.id, feedbackSchema: `${record.schema}/v${record.schemaVersion}`, feedbackReference: `feedback://${record.id}`, feedbackSubmittedAt: record.provenance.submittedAt };
}

export function renderFeedbackMarkdown(record: FeedbackRecord): string {
  const marker = `<!-- ${FEEDBACK_MARKER} ${JSON.stringify({ schema: record.schema, schemaVersion: record.schemaVersion, id: record.id, provenance: record.provenance, attachmentIds: record.attachments.map(item => item.id), triage: record.triage, downstream: record.downstream })} -->`;
  const attachments = record.attachments.length === 0 ? '_None._' : record.attachments.map(item => `- ${item.id}: ${item.mimeType}, ${item.sizeBytes} bytes, ref \`${item.reference}\``).join('\n');
  return `${marker}\n# Feedback ${record.id}\n\n## User report\n\n${record.userContent.text}\n\n## Attachments\n\n${attachments}\n`;
}

export async function materializeFeedback(record: FeedbackRecord, path: string, format: FeedbackMaterializationFormat = 'json'): Promise<void> {
  if (!path || path.includes('\0')) throw new Error('Feedback materialization path is invalid');
  const body = format === 'markdown' ? renderFeedbackMarkdown(record) : `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, { encoding: 'utf8', mode: 0o600 });
}

export function feedbackFingerprint(record: FeedbackRecord): string {
  return createHash('sha256').update(JSON.stringify({ text: record.userContent.text, attachments: record.attachments.map(item => item.sha256 ?? item.reference), provenance: record.provenance })).digest('hex');
}
