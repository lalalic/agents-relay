import { createHash } from 'node:crypto';
import { PROJECT_NAME_PATTERN } from './config.js';

export type GatewayErrorCode =
  | 'unauthorized'
  | 'invalid_request'
  | 'unknown_field'
  | 'unknown_project'
  | 'payload_too_large'
  | 'unsupported_media_type'
  | 'not_found'
  | 'idempotency_conflict'
  | 'capacity_exceeded'
  | 'github_unavailable'
  | 'internal';

export const CREATE_JOB_LIMITS = { intent: 4000, context: 16000, requirements: 32, requirement: 512, agentName: 64, key: 128, parentRef: 128 } as const;
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

export type ValidatedParent = { jobId: string | null; taskId: string | null };
export type ValidatedAgent = { name: string | null };
export type ValidatedCreateJobRequest = {
  intent: string;
  project: string;
  idempotencyKey: string;
  context: string | null;
  requirements: string[];
  parent: ValidatedParent | null;
  agent: ValidatedAgent | null;
};
export type ValidationFailure = { ok: false; code: 'invalid_request' | 'unknown_field'; message: string };
export type ValidationResult = { ok: true; value: ValidatedCreateJobRequest } | ValidationFailure;

const CREATE_JOB_KEYS = ['intent', 'project', 'idempotency_key', 'context', 'requirements', 'parent', 'agent'] as const;
const PARENT_KEYS = ['job_id', 'task_id'] as const;
const AGENT_KEYS = ['name'] as const;

function fail(code: ValidationFailure['code'], message: string): ValidationFailure {
  return { ok: false, code, message };
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isFailure(value: unknown): value is ValidationFailure {
  return typeof value === 'object' && value !== null && (value as { ok?: unknown }).ok === false;
}
function rejectUnknown(value: Record<string, unknown>, allowed: readonly string[], label: string): ValidationFailure | null {
  const unknown = Object.keys(value).filter(key => !allowed.includes(key));
  if (unknown.length === 0) return null;
  return fail('unknown_field', `${label} does not accept: ${unknown.join(', ')}`);
}
function boundedString(value: unknown, label: string, max: number): string | ValidationFailure {
  if (typeof value !== 'string') return fail('invalid_request', `${label} must be a string`);
  if (value.length === 0 || value.length > max) return fail('invalid_request', `${label} must be 1..${max} characters`);
  return value;
}
function optionalBoundedString(value: unknown, label: string, max: number): string | null | ValidationFailure {
  if (value === undefined || value === null) return null;
  return boundedString(value, label, max);
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function parseCreateJobRequest(body: unknown): ValidationResult {
  if (!isObject(body)) return fail('invalid_request', 'Request body must be a JSON object');
  const unknownFailure = rejectUnknown(body, CREATE_JOB_KEYS, 'Request body');
  if (unknownFailure) return unknownFailure;

  const intent = boundedString(body.intent, 'intent', CREATE_JOB_LIMITS.intent);
  if (typeof intent !== 'string') return intent;
  if (collapseWhitespace(intent).length === 0) return fail('invalid_request', 'intent must contain visible text');

  const project = boundedString(body.project, 'project', 32);
  if (typeof project !== 'string') return project;
  if (!PROJECT_NAME_PATTERN.test(project)) return fail('invalid_request', 'project must match ^[a-z0-9][a-z0-9-]{0,31}$');

  const idempotencyKey = boundedString(body.idempotency_key, 'idempotency_key', CREATE_JOB_LIMITS.key);
  if (typeof idempotencyKey !== 'string') return idempotencyKey;
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) return fail('invalid_request', 'idempotency_key must match ^[A-Za-z0-9._:-]{1,128}$');

  const context = optionalBoundedString(body.context, 'context', CREATE_JOB_LIMITS.context);
  if (isFailure(context)) return context;

  let requirements: string[] = [];
  if (body.requirements !== undefined && body.requirements !== null) {
    if (!Array.isArray(body.requirements)) return fail('invalid_request', 'requirements must be an array of strings');
    if (body.requirements.length > CREATE_JOB_LIMITS.requirements) return fail('invalid_request', `requirements accepts at most ${CREATE_JOB_LIMITS.requirements} items`);
    for (let index = 0; index < body.requirements.length; index += 1) {
      const requirement = boundedString(body.requirements[index], `requirements[${index}]`, CREATE_JOB_LIMITS.requirement);
      if (typeof requirement !== 'string') return requirement;
      if (collapseWhitespace(requirement).length === 0) return fail('invalid_request', `requirements[${index}] must contain visible text`);
      requirements = [...requirements, requirement];
    }
  }

  let parent: ValidatedParent | null = null;
  if (body.parent !== undefined && body.parent !== null) {
    if (!isObject(body.parent)) return fail('invalid_request', 'parent must be an object');
    const parentUnknown = rejectUnknown(body.parent, PARENT_KEYS, 'parent');
    if (parentUnknown) return parentUnknown;
    const jobId = optionalBoundedString(body.parent.job_id, 'parent.job_id', CREATE_JOB_LIMITS.parentRef);
    if (isFailure(jobId)) return jobId;
    const taskId = optionalBoundedString(body.parent.task_id, 'parent.task_id', CREATE_JOB_LIMITS.parentRef);
    if (isFailure(taskId)) return taskId;
    if (jobId !== null || taskId !== null) parent = { jobId, taskId };
  }

  let agent: ValidatedAgent | null = null;
  if (body.agent !== undefined && body.agent !== null) {
    if (!isObject(body.agent)) return fail('invalid_request', 'agent must be an object');
    const agentUnknown = rejectUnknown(body.agent, AGENT_KEYS, 'agent');
    if (agentUnknown) return agentUnknown;
    const name = optionalBoundedString(body.agent.name, 'agent.name', CREATE_JOB_LIMITS.agentName);
    if (isFailure(name)) return name;
    if (name !== null) agent = { name };
  }

  return { ok: true, value: { intent, project, idempotencyKey, context, requirements, parent, agent } };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function requestFingerprint(request: ValidatedCreateJobRequest): string {
  const payload = {
    intent: request.intent,
    context: request.context ?? null,
    requirements: request.requirements,
    parent: request.parent ? { job_id: request.parent.jobId, task_id: request.parent.taskId } : null,
    agent: request.agent ? { name: request.agent.name } : null,
  };
  return `sha256:${sha256(canonicalJson(payload))}`;
}

export function jobIdFor(project: string, idempotencyKey: string): string {
  return `${project}-${sha256(`${project}\u0000${idempotencyKey}`).slice(0, 16)}`;
}

export function keyFingerprintFor(project: string, idempotencyKey: string): string {
  return `sha256:${sha256(`${project}\u0000${idempotencyKey}`).slice(0, 32)}`;
}

export function composeTaskInput(request: ValidatedCreateJobRequest): string {
  const blocks = [`Intent: ${collapseWhitespace(request.intent)}`];
  if (request.context !== null && request.context.trim().length > 0) blocks.push(`Context:\n${request.context}`);
  if (request.requirements.length > 0) blocks.push(`Requirements:\n${request.requirements.map(requirement => `- ${collapseWhitespace(requirement)}`).join('\n')}`);
  return blocks.join('\n\n');
}

export function composeTitle(intent: string): string {
  return collapseWhitespace(intent).slice(0, 200);
}
