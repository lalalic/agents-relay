import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

export const FEEDBACK_MARKER = 'agents-relay:feedback:v1';
export const FEEDBACK_SCHEMA_VERSION = 1;
export const DEFAULT_FEEDBACK_LIMITS = {
  maxTextLength: 20_000,
  maxAttachments: 5,
  maxAttachmentBytes: 10 * 1024 * 1024,
  allowedMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as readonly string[],
};

export type FeedbackSource = 'public-site' | 'extension' | 'app' | 'other';
export type FeedbackActorClass = 'external-user' | 'pilot-user' | 'internal-test';
export type FeedbackTriageStatus = 'new' | 'triaged' | 'accepted' | 'rejected' | 'duplicate';

export type FeedbackProvenance = {
  source: FeedbackSource;
  product: string;
  surface?: string;
  setupStep?: string;
  actorClass: FeedbackActorClass;
  version?: string;
  build?: string;
  submittedAt: string;
  contact?: { channel: 'email' | 'url' | 'other'; value: string };
};

export type FeedbackAttachmentInput = {
  filename: string;
  mediaType: string;
  data: Uint8Array;
};

export type FeedbackAttachment = {
  id: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  sha256: string;
  storageRef: string;
  uploadedAt: string;
};

export type FeedbackDownstreamReference = {
  kind: 'job' | 'task' | 'pr' | 'issue' | 'other';
  id: string;
  url?: string;
};

export type FeedbackRecord = {
  schema: typeof FEEDBACK_MARKER;
  schemaVersion: typeof FEEDBACK_SCHEMA_VERSION;
  id: string;
  idempotencyKey?: string;
  userContent: { text: string };
  attachments: FeedbackAttachment[];
  systemProvenance: FeedbackProvenance;
  triage: { status: FeedbackTriageStatus; updatedAt: string };
  downstream: FeedbackDownstreamReference[];
  createdAt: string;
};

export type FeedbackLimits = {
  maxTextLength?: number;
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  allowedMediaTypes?: readonly string[];
};

export type FeedbackSubmission = {
  text: string;
  attachments?: FeedbackAttachmentInput[];
  provenance: FeedbackProvenance;
  idempotencyKey?: string;
};

export type FeedbackMaterialization = {
  record: FeedbackRecord;
  recordRef: string;
};

function effectiveLimits(limits: FeedbackLimits = {}): Required<FeedbackLimits> {
  return {
    maxTextLength: limits.maxTextLength ?? DEFAULT_FEEDBACK_LIMITS.maxTextLength,
    maxAttachments: limits.maxAttachments ?? DEFAULT_FEEDBACK_LIMITS.maxAttachments,
    maxAttachmentBytes: limits.maxAttachmentBytes ?? DEFAULT_FEEDBACK_LIMITS.maxAttachmentBytes,
    allowedMediaTypes: limits.allowedMediaTypes ?? DEFAULT_FEEDBACK_LIMITS.allowedMediaTypes,
  };
}

function fail(message: string): never { throw new Error(`Invalid feedback: ${message}`); }

function safeId(id: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(id)) fail('feedback id is invalid');
  return id;
}

function cleanFilename(filename: string): string {
  const cleaned = basename(filename).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
  if (!cleaned || cleaned === '.' || cleaned === '..') fail('attachment filename is invalid');
  return cleaned;
}

function cleanOptional(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (value.length > 500) fail(`${field} is too long`);
  return value;
}

function validateProvenance(input: FeedbackProvenance): FeedbackProvenance {
  if (!input.product.trim()) fail('provenance.product is required');
  if (!input.submittedAt || Number.isNaN(Date.parse(input.submittedAt))) fail('provenance.submittedAt must be an ISO timestamp');
  if (input.contact && !input.contact.value.trim()) fail('contact value must not be empty');
  // Only the explicitly documented fields are copied. Upload/browser/provider metadata is never persisted.
  return {
    source: input.source,
    product: input.product.trim().slice(0, 200),
    surface: cleanOptional(input.surface, 'surface'),
    setupStep: cleanOptional(input.setupStep, 'setupStep'),
    actorClass: input.actorClass,
    version: cleanOptional(input.version, 'version'),
    build: cleanOptional(input.build, 'build'),
    submittedAt: new Date(input.submittedAt).toISOString(),
    ...(input.contact ? { contact: { channel: input.contact.channel, value: input.contact.value.trim().slice(0, 500) } } : {}),
  };
}

export function marker(label: string, value: unknown): string {
  return `<!-- ${label} ${JSON.stringify(value).replace(/>/g, '\\u003e')} -->`;
}

export function renderFeedbackMarker(record: FeedbackRecord): string {
  const { userContent: _userContent, ...metadata } = record;
  return marker(FEEDBACK_MARKER, metadata);
}

export function parseFeedbackMarker(value: string): Omit<FeedbackRecord, 'userContent'> | null {
  const match = value.match(/<!--\s*agents-relay:feedback:v1\s+([\s\S]*?)\s*-->/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[1]) as Omit<FeedbackRecord, 'userContent'>;
    return parsed.schema === FEEDBACK_MARKER && parsed.schemaVersion === FEEDBACK_SCHEMA_VERSION ? parsed : null;
  } catch { return null; }
}

export class FileFeedbackStore {
  readonly root: string;
  private readonly limits: Required<FeedbackLimits>;

  constructor(root: string, limits: FeedbackLimits = {}) {
    this.root = resolve(root);
    this.limits = effectiveLimits(limits);
  }

  async submit(submission: FeedbackSubmission): Promise<FeedbackMaterialization> {
    const existing = submission.idempotencyKey ? await this.findByIdempotencyKey(submission.idempotencyKey) : null;
    if (existing) return { record: existing, recordRef: this.recordPath(existing.id) };
    const text = submission.text.trim();
    if (!text) fail('text is required');
    if (text.length > this.limits.maxTextLength) fail(`text exceeds ${this.limits.maxTextLength} characters`);
    const inputs = submission.attachments ?? [];
    if (inputs.length > this.limits.maxAttachments) fail(`at most ${this.limits.maxAttachments} attachments are allowed`);
    const now = new Date().toISOString();
    const id = randomUUID();
    const attachmentDir = join(this.root, 'attachments', id);
    const attachments: FeedbackAttachment[] = [];
    await mkdir(attachmentDir, { recursive: true });
    try {
      for (const input of inputs) {
        if (!this.limits.allowedMediaTypes.includes(input.mediaType.toLowerCase())) fail(`unsupported attachment type: ${input.mediaType}`);
        if (input.data.byteLength === 0 || input.data.byteLength > this.limits.maxAttachmentBytes) fail(`attachment exceeds ${this.limits.maxAttachmentBytes} bytes`);
        const attachmentId = randomUUID();
        const filename = cleanFilename(input.filename);
        const relative = join('attachments', id, `${attachmentId}-${filename}`);
        await writeFile(join(this.root, relative), input.data, { flag: 'wx' });
        attachments.push({ id: attachmentId, filename, mediaType: input.mediaType.toLowerCase(), sizeBytes: input.data.byteLength, sha256: createHash('sha256').update(input.data).digest('hex'), storageRef: relative, uploadedAt: now });
      }
      const record: FeedbackRecord = {
        schema: FEEDBACK_MARKER, schemaVersion: FEEDBACK_SCHEMA_VERSION, id,
        ...(submission.idempotencyKey ? { idempotencyKey: submission.idempotencyKey } : {}),
        userContent: { text }, attachments, systemProvenance: validateProvenance(submission.provenance),
        triage: { status: 'new', updatedAt: now }, downstream: [], createdAt: now,
      };
      await mkdir(join(this.root, 'records'), { recursive: true });
      const recordRef = this.recordPath(id);
      const temp = `${recordRef}.${randomUUID()}.tmp`;
      await writeFile(temp, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      await rename(temp, recordRef);
      return { record, recordRef };
    } catch (error) {
      await this.removeAttachmentDirectory(attachmentDir);
      throw error;
    }
  }

  async read(id: string): Promise<FeedbackRecord> {
    const parsed = JSON.parse(await readFile(this.recordPath(safeId(id)), 'utf8')) as FeedbackRecord;
    if (parsed.schema !== FEEDBACK_MARKER || parsed.schemaVersion !== FEEDBACK_SCHEMA_VERSION) fail('record schema is unsupported');
    return parsed;
  }

  private recordPath(id: string): string { return join(this.root, 'records', `${id}.json`); }

  private async findByIdempotencyKey(key: string): Promise<FeedbackRecord | null> {
    const directory = join(this.root, 'records');
    let entries: string[];
    try { entries = await readdir(directory); } catch { return null; }
    for (const entry of entries.filter(item => item.endsWith('.json'))) {
      const record = JSON.parse(await readFile(join(directory, entry), 'utf8')) as FeedbackRecord;
      if (record.idempotencyKey === key) return record;
    }
    return null;
  }

  private async removeAttachmentDirectory(path: string): Promise<void> {
    try { await rm(path, { recursive: true, force: true }); } catch { /* best-effort cleanup; the record was not materialized */ }
  }
}

export async function materializeFeedback(root: string, submission: FeedbackSubmission, limits?: FeedbackLimits): Promise<FeedbackMaterialization> {
  return new FileFeedbackStore(root, limits).submit(submission);
}

export async function readFeedbackAttachment(root: string, attachment: FeedbackAttachment): Promise<Uint8Array> {
  const path = resolve(root, attachment.storageRef);
  const rootPath = resolve(root);
  if (!path.startsWith(`${rootPath}/`)) fail('attachment reference escapes storage root');
  const bytes = await readFile(path);
  if (bytes.byteLength !== attachment.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== attachment.sha256) fail('attachment integrity check failed');
  return bytes;
}
