import type { Job } from './types.js';

const TAG_VALUE = /^[A-Za-z0-9_.-]+$/;

export function parseJobTagJson(raw: string): Job['tag'] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--tag must be valid JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('--tag must be a JSON object');
  const value = parsed as Record<string, unknown>;
  if (typeof value.description !== 'string' || !value.description.trim() || value.description.length > 500) throw new Error('--tag.description must be a non-empty string up to 500 characters');
  if (!value.values || typeof value.values !== 'object' || Array.isArray(value.values) || Object.keys(value.values).length === 0) throw new Error('--tag.values must be a non-empty object');
  const values: Record<string, string> = {};
  for (const [name, display] of Object.entries(value.values as Record<string, unknown>)) {
    if (!TAG_VALUE.test(name) || name.length > 64) throw new Error(`--tag.values contains invalid value ${name}`);
    if (typeof display !== 'string' || !display || display.length > 32) throw new Error(`--tag.values.${name} must be a non-empty string up to 32 characters`);
    values[name] = display;
  }
  return { description: value.description, values };
}

export function acceptedReportedTag(job: Job, data: Record<string, unknown> | undefined): string | undefined {
  const tag = data?.tag;
  return typeof tag === 'string' && job.tag?.values[tag] !== undefined ? tag : undefined;
}

export function eventDataWithoutTag(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'tag')) return data;
  const { tag: _tag, ...rest } = data;
  return Object.keys(rest).length ? rest : undefined;
}

export function taskTagWorkerPrompt(job: Job): string {
  if (!job.tag) return '';
  return `[Job-defined Task tag]\nMeaning/when to set it: ${job.tag.description}\nAllowed values: ${JSON.stringify(Object.keys(job.tag.values))}\nWhen applicable, report exactly one allowed value in the terminal event as data.tag. The tag is separate from Task lifecycle state.\n\n`;
}
