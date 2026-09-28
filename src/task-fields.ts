import type { Job, TaskFieldDefinition } from './types.js';

const FIELD_NAME = /^[A-Za-z0-9_.-]+$/;

export function parseJobTaskFields(value: unknown, option = '--task-fields'): Job['taskFields'] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${option} must be a JSON object`);
  const out: NonNullable<Job['taskFields']> = {};
  for (const [name, rawDefinition] of Object.entries(value as Record<string, unknown>)) {
    if (!FIELD_NAME.test(name) || name.length > 64) throw new Error(`${option} contains invalid field name ${name}`);
    if (!rawDefinition || typeof rawDefinition !== 'object' || Array.isArray(rawDefinition)) throw new Error(`${option}.${name} must be an object`);
    const definition = rawDefinition as Record<string, unknown>;
    const label = definition.label;
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 64)) throw new Error(`${option}.${name}.label must be a non-empty string up to 64 characters`);
    const rawValues = definition.values;
    if (!rawValues || typeof rawValues !== 'object' || Array.isArray(rawValues) || Object.keys(rawValues).length === 0) throw new Error(`${option}.${name}.values must be a non-empty object`);
    const values: Record<string, string> = {};
    for (const [fieldValue, display] of Object.entries(rawValues as Record<string, unknown>)) {
      if (!FIELD_NAME.test(fieldValue) || fieldValue.length > 64) throw new Error(`${option}.${name}.values contains invalid value ${fieldValue}`);
      if (typeof display !== 'string' || !display || display.length > 32) throw new Error(`${option}.${name}.values.${fieldValue} must be a non-empty string up to 32 characters`);
      values[fieldValue] = display;
    }
    out[name] = { ...(typeof label === 'string' ? { label } : {}), values };
  }
  return out;
}

export function parseJobTaskFieldsJson(raw: string): Job['taskFields'] | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error('--task-fields must be valid JSON'); }
  return parseJobTaskFields(parsed);
}

export function acceptedReportedTaskFields(job: Job, data: Record<string, unknown> | undefined): Record<string, string> | undefined {
  const raw = data?.taskFields;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !job.taskFields) return undefined;
  const accepted: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    const definition: TaskFieldDefinition | undefined = job.taskFields[name];
    if (definition?.values[value] !== undefined) accepted[name] = value;
  }
  return Object.keys(accepted).length ? accepted : undefined;
}

export function eventDataWithoutTaskFields(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'taskFields')) return data;
  const { taskFields: _taskFields, ...rest } = data;
  return Object.keys(rest).length ? rest : undefined;
}

export function taskFieldsWorkerPrompt(job: Job): string {
  if (!job.taskFields || Object.keys(job.taskFields).length === 0) return '';
  return `[Job-defined Task fields]\nThe Job defines these Task result fields: ${JSON.stringify(job.taskFields)}\nWhen a field applies to this execution, report its exact allowed value in the terminal event under data.taskFields. Example: data: { taskFields: { e2e: \"pass\" } }. These fields are separate from Task lifecycle state.\n\n`;
}
