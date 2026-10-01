import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * One structured observability abstraction for the Relay runtime.
 *
 * Records are observational only: they never mutate durable state and never
 * become a second workflow store. The representative lifecycle chain is
 * reconstructed from `wake -> graph -> transition -> store -> projection`
 * records that all share one correlation envelope and one redaction/noise policy.
 */

export type ObservabilityStage =
  | 'wake'
  | 'graph'
  | 'transition'
  | 'store'
  | 'projection'
  | 'reconcile'
  | 'daemon';

export type ObservabilityLevel = 'debug' | 'info' | 'warn' | 'error';

export type ObservabilityOutcome =
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'deduplicated'
  | 'skipped'
  | 'noop';

export type FailureClassification = 'conflict' | 'transient' | 'terminal';

/** Durable identifiers every record can carry so a lifecycle can be reconstructed. */
export type ObservabilityCorrelation = {
  readonly repository?: string;
  readonly prNumber?: number;
  readonly jobId?: string;
  readonly taskId?: string;
  readonly executionId?: string;
};

/** Graph/decision identity and the lifecycle states around a durable transition. */
export type ObservabilityTransition = {
  readonly graph?: string | null;
  readonly from?: string | null;
  readonly to?: string | null;
  readonly actions?: readonly string[];
};

export type ObservationInput = {
  readonly stage: ObservabilityStage;
  readonly event: string;
  readonly message: string;
  readonly level?: ObservabilityLevel;
  readonly outcome?: ObservabilityOutcome;
  readonly correlation?: ObservabilityCorrelation;
  readonly transition?: ObservabilityTransition;
  readonly data?: Record<string, unknown>;
};

export type StructuredObservation = {
  readonly ts: string;
  readonly stage: ObservabilityStage;
  readonly event: string;
  readonly level: ObservabilityLevel;
  readonly outcome: ObservabilityOutcome;
  readonly message: string;
  readonly correlation: ObservabilityCorrelation;
  readonly transition?: ObservabilityTransition;
  readonly data?: Record<string, unknown>;
};

export type ObservabilitySink = (record: StructuredObservation) => void;

const LEVEL_RANK: Record<ObservabilityLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const OBSERVABILITY_MAX_STRING = 512;
export const OBSERVABILITY_MAX_ITEMS = 20;
export const OBSERVABILITY_MAX_DEPTH = 4;
export const OBSERVABILITY_REDACTED = '[redacted]';

const SENSITIVE_KEY = /(secret|token|password|passwd|authorization|cookie|credential|api[_-]?key|private[_-]?key|bearer|prompt)/i;
const BULK_KEY = /^(payload|input|body|diff|patch|content|messages?)$/i;

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function failureStatus(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { status?: unknown; statusCode?: unknown; response?: { status?: unknown } };
  for (const candidate of [value.status, value.statusCode, value.response?.status]) {
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function failureRetryAfterMs(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const value = error as { retryAfter?: unknown; retryAfterMs?: unknown; response?: { headers?: unknown }; headers?: unknown };
  const retryAfterSeconds = Number(value.retryAfter);
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  const retryAfterMs = Number(value.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  for (const headers of [value.response?.headers, value.headers]) {
    const raw = headerValue(headers, 'retry-after');
    const seconds = Number(raw);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return undefined;
}

function headerValue(headers: unknown, name: string): string | null {
  if (!headers || typeof headers !== 'object') return null;
  if (typeof (headers as Headers).get === 'function') return (headers as Headers).get(name);
  const record = headers as Record<string, unknown>;
  const hit = Object.entries(record).find(([key]) => key.toLowerCase() === name);
  return hit && hit[1] !== undefined ? String(hit[1]) : null;
}

/**
 * Deterministic conflict vs transient retry classification.
 *
 * `conflict` means the durable record rejects a divergent definition and retrying
 * will not help. `transient` means the same request may succeed later (rate limit,
 * 5xx, network interruption, retry-after). `terminal` covers everything else.
 */
export function classifyFailure(error: unknown): {
  classification: FailureClassification;
  reason: string;
  status?: number;
  retryAfterMs?: number;
} {
  const reason = errorMessage(error);
  const status = failureStatus(error);
  const retryAfterMs = failureRetryAfterMs(error);
  const classified: { classification: FailureClassification; reason: string; status?: number; retryAfterMs?: number } = { classification: 'terminal', reason };
  if (status !== undefined) classified.status = status;
  if (retryAfterMs !== undefined) classified.retryAfterMs = retryAfterMs;
  if (/already exists with a different definition/i.test(reason) || status === 409) {
    return { ...classified, classification: 'conflict' };
  }
  if (
    status === 429
    || (status !== undefined && status >= 500)
    || retryAfterMs !== undefined
    || /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPIPE|UND_ERR)\b/.test(reason)
    || /fetch failed|network|socket hang up|rate limit|secondary rate|temporarily unavailable/i.test(reason)
  ) {
    return { ...classified, classification: 'transient' };
  }
  return classified;
}

/** Bound and redact observation data so records never leak secrets or large payloads. */
export function sanitizeObservationValue(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return value.length > OBSERVABILITY_MAX_STRING
      ? `${value.slice(0, OBSERVABILITY_MAX_STRING)}…(+${value.length - OBSERVABILITY_MAX_STRING})`
      : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  if (Array.isArray(value)) {
    const items = value.slice(0, OBSERVABILITY_MAX_ITEMS).map(item => sanitizeObservationValue(item, depth + 1));
    return value.length > OBSERVABILITY_MAX_ITEMS ? [...items, `+${value.length - OBSERVABILITY_MAX_ITEMS} more`] : items;
  }
  if (typeof value === 'object') {
    if (depth >= OBSERVABILITY_MAX_DEPTH) return '[truncated]';
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) { out[key] = OBSERVABILITY_REDACTED; continue; }
      if (BULK_KEY.test(key) && typeof item === 'string' && item.length > OBSERVABILITY_MAX_STRING) {
        out[key] = `[omitted ${item.length} chars]`;
        continue;
      }
      out[key] = sanitizeObservationValue(item, depth + 1);
    }
    return out;
  }
  return '[unsupported]';
}

export function sanitizeObservationData(data: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!data) return undefined;
  return sanitizeObservationValue(data, 0) as Record<string, unknown>;
}

function writeStderrObservation(record: StructuredObservation): void {
  try { process.stderr.write(`${JSON.stringify(record)}\n`); } catch { /* observability must never break execution */ }
}

const correlationStorage = new AsyncLocalStorage<ObservabilityCorrelation>();

export function withObservabilityCorrelation<T>(correlation: ObservabilityCorrelation, work: () => T): T {
  return correlationStorage.run({ ...currentObservabilityCorrelation(), ...correlation }, work);
}

export function currentObservabilityCorrelation(): ObservabilityCorrelation {
  return correlationStorage.getStore() ?? {};
}

export class RelayObservability {
  constructor(
    private readonly sink: ObservabilitySink = writeStderrObservation,
    readonly minimumLevel: ObservabilityLevel = 'info',
  ) {}

  /** No-op observer used as the safe default until a runtime configures logging. */
  static silent(): RelayObservability { return new RelayObservability(() => undefined, 'error'); }

  static stderr(minimumLevel: ObservabilityLevel = 'info'): RelayObservability {
    return new RelayObservability(writeStderrObservation, minimumLevel);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): RelayObservability {
    const configured = (env.AGENTS_RELAY_OBSERVABILITY ?? env.RELAY_OBSERVABILITY_LEVEL ?? '').trim();
    if (/^(silent|off|none|0|false)$/i.test(configured)) return RelayObservability.silent();
    const level = /^(debug|info|warn|error)$/i.test(configured) ? (configured.toLowerCase() as ObservabilityLevel) : 'info';
    return RelayObservability.stderr(level);
  }

  isEnabled(level: ObservabilityLevel): boolean { return LEVEL_RANK[level] >= LEVEL_RANK[this.minimumLevel]; }

  record(input: ObservationInput): void {
    const level = input.level ?? 'info';
    if (!this.isEnabled(level)) return;
    const observation: StructuredObservation = {
      ts: new Date().toISOString(),
      stage: input.stage,
      event: input.event,
      level,
      outcome: input.outcome ?? 'succeeded',
      message: input.message,
      correlation: { ...currentObservabilityCorrelation(), ...input.correlation },
      ...(input.transition ? { transition: input.transition } : {}),
      ...(input.data ? { data: sanitizeObservationData(input.data) } : {}),
    };
    this.sink(observation);
  }
}

let activeObservability: RelayObservability = RelayObservability.silent();

export function observability(): RelayObservability { return activeObservability; }
export function setObservability(next: RelayObservability): void { activeObservability = next; }

/** In-memory sink for tests and diagnostics. */
export function collectObservations(records: StructuredObservation[]): ObservabilitySink {
  return record => { records.push(record); };
}
