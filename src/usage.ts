import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Job } from './types.js';

export type UsageAccounting = {
  input: number;
  cachedInput: number;
  cacheWriteInput: number;
  output: number;
  reasoning: number;
  total: number;
};

export type UsageRecord = {
  sourceId: 'codex' | 'zai';
  provider: 'codex' | 'zai';
  sessionId: string;
  responseId: string | null;
  timestamp: string;
  model: string;
  reasoning: string | null;
  tokens: UsageAccounting;
};

export type UsageModelSummary = {
  provider: UsageRecord['provider'];
  model: string;
  requestCount: number;
  tokens: UsageAccounting;
};

export type UsageSessionSummary = {
  sessionId: string;
  provider: UsageRecord['provider'];
  model: string;
  requestCount: number;
  tokens: UsageAccounting;
  lastActivityAt: string;
};

export type UsageSourceSummary = {
  id: UsageRecord['sourceId'];
  label: string;
  telemetryAvailable: boolean;
  telemetryPath: string;
  requestCount: number;
  tokens: UsageAccounting;
  models: UsageModelSummary[];
  recentSessions: UsageSessionSummary[];
  quotaBalance: { available: false; state: 'unsupported'; reason: string };
  warning: string | null;
};

export type CurrentJobUsage = {
  available: boolean;
  reason: string | null;
  requestCount: number;
  tokens: UsageAccounting;
  sessions: UsageSessionSummary[];
};

export type UsageSnapshot = {
  generatedAt: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  requestCount: number;
  tokens: UsageAccounting;
  sources: UsageSourceSummary[];
  currentJob: CurrentJobUsage;
};

export interface UsageReaderResult {
  windowStart: Date;
  windowEnd: Date;
  telemetryPath: string;
  records: UsageRecord[];
  warning: string | null;
}

export interface UsageReader {
  read(): Promise<UsageReaderResult>;
}

const EMPTY_TOKENS: UsageAccounting = { input: 0, cachedInput: 0, cacheWriteInput: 0, output: 0, reasoning: 0, total: 0 };
const ZAI_MODEL_PATTERN = /^glm(?:[-_.]|\b)/i;

function zeroTokens(): UsageAccounting {
  return { ...EMPTY_TOKENS };
}

function addTokens(target: UsageAccounting, value: UsageAccounting): void {
  target.input += value.input;
  target.cachedInput += value.cachedInput;
  target.cacheWriteInput += value.cacheWriteInput;
  target.output += value.output;
  target.reasoning += value.reasoning;
  target.total += value.total;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isoTime(value: Date): string {
  return value.toISOString();
}

function recordModel(value: unknown): string | null {
  return nonEmptyString(value) ? value : null;
}

function parseUsageTokens(value: unknown): UsageAccounting | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const input = nonNegativeInteger(usage.input_tokens);
  const cachedInput = nonNegativeInteger(usage.cached_input_tokens);
  const cacheWriteInput = nonNegativeInteger(usage.cache_write_input_tokens);
  const output = nonNegativeInteger(usage.output_tokens);
  const reasoning = nonNegativeInteger(usage.reasoning_output_tokens);
  if (input === null || cachedInput === null || cacheWriteInput === null || output === null || reasoning === null) return null;
  const recordedTotal = nonNegativeInteger(usage.total_tokens);
  const computedTotal = input + output;
  return {
    input,
    cachedInput,
    cacheWriteInput,
    output,
    reasoning,
    total: recordedTotal ?? computedTotal,
  };
}

async function jsonlUsageRecord(line: string, sessionIdFallback: string): Promise<Omit<UsageRecord, 'sourceId' | 'provider'> | null> {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object') return null;
    const event = value as Record<string, unknown>;
    const payloadValue = event.payload;
    if (!payloadValue || typeof payloadValue !== 'object') return null;
    const payload = payloadValue as Record<string, unknown>;
    if (event.type === 'session_meta' && nonEmptyString(payload.id)) {
      return null;
    }
    if (event.type !== 'token_usage_record') return null;
    const tokens = parseUsageTokens(payload.usage);
    if (!tokens) return null;
    const timestamp = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
      ? event.timestamp
      : new Date().toISOString();
    return {
      sessionId: nonEmptyString(payload.session_id) || nonEmptyString(payload.thread_id) ? String(payload.session_id || payload.thread_id) : sessionIdFallback,
      responseId: nonEmptyString(payload.response_id) ? payload.response_id : null,
      timestamp,
      model: 'unknown',
      reasoning: null,
      tokens,
    };
  } catch {
    return null;
  }
}

export class CodexSessionUsageReader implements UsageReader {
  private cache: { signature: string; cachedAt: number; result: UsageReaderResult } | null = null;

  constructor(
    private readonly codexHome = join(homedir(), '.codex'),
    private readonly windowDays = 1,
    private readonly cacheTtlMs = 10_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async usageFiles(windowStart: Date): Promise<Array<{ path: string; modifiedAt: Date }>> {
    const roots = [join(this.codexHome, 'sessions'), join(this.codexHome, 'archived_sessions')];
    const files: Array<{ path: string; modifiedAt: Date }> = [];
    for (const root of roots) {
      await this.collectFiles(root, windowStart, files, 0);
    }
    return files.sort((left, right) => left.modifiedAt.getTime() - right.modifiedAt.getTime());
  }

  private async collectFiles(
    directory: string,
    windowStart: Date,
    files: Array<{ path: string; modifiedAt: Date }>,
    depth: number,
  ): Promise<void> {
    if (depth > 5) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await this.collectFiles(path, windowStart, files, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const metadata = await stat(path);
        if (metadata.mtime < windowStart) continue;
        files.push({ path, modifiedAt: metadata.mtime });
      } catch {
        continue;
      }
    }
  }

  async read(): Promise<UsageReaderResult> {
    const windowEnd = this.now();
    const windowStart = new Date(windowEnd.getTime() - this.windowDays * 24 * 60 * 60 * 1000);
    const files = await this.usageFiles(windowStart);
    const signature = `${windowStart.toISOString()}|${files.map(file => `${file.path}:${file.modifiedAt.getTime()}`).join('|')}`;
    if (this.cache && this.cache.signature === signature && windowEnd.getTime() - this.cache.cachedAt < this.cacheTtlMs) {
      return this.cache.result;
    }
    const records: UsageRecord[] = [];
    const seenResponses = new Set<string>();
    for (const file of files) {
      let sessionId = 'unknown';
      let model: string | null = null;
      let reasoning: string | null = null;
      const stream = createReadStream(file.path, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line) as unknown;
            if (parsed && typeof parsed === 'object') {
              const event = parsed as Record<string, unknown>;
              const payload = event.payload as Record<string, unknown> | undefined;
              if (event.type === 'session_meta' && payload && nonEmptyString(payload.id)) sessionId = payload.id;
              if (event.type === 'turn_context' && payload) {
                model = recordModel(payload.model);
                reasoning = recordModel(payload.effort);
              }
            }
          } catch {
            continue;
          }
          if (!model) continue;
          const partial = await jsonlUsageRecord(line, sessionId);
          if (!partial) continue;
          const sourceId: UsageRecord['sourceId'] = ZAI_MODEL_PATTERN.test(model) ? 'zai' : 'codex';
          const responseKey = `${partial.sessionId}:${partial.responseId ?? file.path}:${partial.timestamp}`;
          if (seenResponses.has(responseKey)) continue;
          seenResponses.add(responseKey);
          records.push({ ...partial, model, reasoning, sourceId, provider: sourceId });
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }
    const result: UsageReaderResult = {
      windowStart,
      windowEnd,
      telemetryPath: this.codexHome,
      records,
      warning: files.length ? null : 'No Codex JSONL session files changed in the selected window.',
    };
    this.cache = { signature, cachedAt: windowEnd.getTime(), result };
    return result;
  }
}

function summarizeModels(records: readonly UsageRecord[]): UsageModelSummary[] {
  const byModel = new Map<string, UsageModelSummary>();
  for (const record of records) {
    const existing = byModel.get(record.model) ?? {
      provider: record.provider,
      model: record.model,
      requestCount: 0,
      tokens: zeroTokens(),
    };
    existing.requestCount += 1;
    addTokens(existing.tokens, record.tokens);
    byModel.set(record.model, existing);
  }
  return [...byModel.values()].sort((left, right) => right.tokens.total - left.tokens.total || left.model.localeCompare(right.model));
}

function summarizeSessions(records: readonly UsageRecord[], limit?: number): UsageSessionSummary[] {
  const bySession = new Map<string, UsageSessionSummary>();
  for (const record of records) {
    const existing = bySession.get(record.sessionId) ?? {
      sessionId: record.sessionId,
      provider: record.provider,
      model: record.model,
      requestCount: 0,
      tokens: zeroTokens(),
      lastActivityAt: record.timestamp,
    };
    existing.requestCount += 1;
    addTokens(existing.tokens, record.tokens);
    existing.lastActivityAt = existing.lastActivityAt > record.timestamp ? existing.lastActivityAt : record.timestamp;
    if (record.provider === 'zai' || !ZAI_MODEL_PATTERN.test(existing.model)) existing.model = record.model;
    bySession.set(record.sessionId, existing);
  }
  const summaries = [...bySession.values()].sort((left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt));
  return limit === undefined ? summaries : summaries.slice(0, limit);
}

function sourceSummary(
  id: UsageRecord['sourceId'],
  label: string,
  records: readonly UsageRecord[],
  telemetryPath: string,
  warning: string | null,
): UsageSourceSummary {
  const tokens = zeroTokens();
  for (const record of records) addTokens(tokens, record.tokens);
  return {
    id,
    label,
    telemetryAvailable: true,
    telemetryPath,
    requestCount: records.length,
    tokens,
    models: summarizeModels(records),
    recentSessions: summarizeSessions(records, 10),
    quotaBalance: {
      available: false,
      state: 'unsupported',
      reason: id === 'zai'
        ? 'Local telemetry reports usage only; Z.ai account quota/balance has no supported local source.'
        : 'Codex local telemetry reports usage only; plan quota/balance is not available.',
    },
    warning: records.length ? warning : 'No matching requests recorded in the selected window.',
  };
}

function currentJobUsage(records: readonly UsageRecord[], sessionIds: readonly string[]): CurrentJobUsage {
  const wanted = new Set(sessionIds.filter(sessionId => sessionId && sessionId !== 'unknown'));
  if (!wanted.size) {
    return { available: false, reason: 'No durable task in this job has a recorded execution thread id.', requestCount: 0, tokens: zeroTokens(), sessions: [] };
  }
  const matched = records.filter(record => wanted.has(record.sessionId));
  const tokens = zeroTokens();
  for (const record of matched) addTokens(tokens, record.tokens);
  return {
    available: true,
    reason: matched.length ? null : 'Recorded thread ids have no usage in the selected window.',
    requestCount: matched.length,
    tokens,
    sessions: summarizeSessions(matched),
  };
}

export class UsageRegistry {
  constructor(
    private readonly reader: UsageReader,
    private readonly sources: ReadonlyArray<{ id: UsageRecord['sourceId']; label: string }>,
  ) {}

async snapshot(job?: Pick<Job, 'tasks'>, currentThreadIds: readonly string[] = []): Promise<UsageSnapshot> {
    const telemetry = await this.reader.read();
    const selected = currentThreadIds.length
      ? currentThreadIds
      : (job?.tasks ?? []).map(task => task.threadId).filter((threadId): threadId is string => Boolean(threadId));
    const tokens = zeroTokens();
    for (const record of telemetry.records) addTokens(tokens, record.tokens);
    const sourceDetails = this.sources.map(source => sourceSummary(
      source.id,
      source.label,
      telemetry.records.filter(record => record.sourceId === source.id),
      telemetry.telemetryPath,
      telemetry.warning,
    ));
    return {
      generatedAt: isoTime(telemetry.windowEnd),
      windowDays: Math.max(1, Math.round((telemetry.windowEnd.getTime() - telemetry.windowStart.getTime()) / 86_400_000)),
      windowStart: isoTime(telemetry.windowStart),
      windowEnd: isoTime(telemetry.windowEnd),
      requestCount: telemetry.records.length,
      tokens,
      sources: sourceDetails,
      currentJob: currentJobUsage(telemetry.records, selected),
    };
  }
}

export function codexAndZaiUsageRegistry(
  codexHome?: string,
  windowDays = 1,
): UsageRegistry {
  const reader = new CodexSessionUsageReader(codexHome, windowDays);
  return new UsageRegistry(reader, [
    { id: 'codex', label: 'Codex local session telemetry' },
    { id: 'zai', label: 'Z.ai runtime usage via recorded GLM models' },
  ]);
}
