import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export type AccountUsageWindow = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number | null;
};

export type AccountUsageSnapshot = {
  available: boolean;
  generatedAt: string;
  fiveHour: AccountUsageWindow | null;
  weekly: AccountUsageWindow | null;
  reason: string | null;
};

export type AccountUsageProvider = {
  id: 'openai' | 'zai';
  label: string;
  usage: AccountUsageSnapshot;
};

export type AccountUsageOverview = {
  generatedAt: string;
  providers: AccountUsageProvider[];
};

export interface UsageReader {
  read(): Promise<AccountUsageSnapshot>;
}

function finitePercent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function positiveMinutes(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function epochSeconds(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function parseWindow(value: unknown): AccountUsageWindow | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const usedPercent = finitePercent(raw.used_percent);
  const windowMinutes = positiveMinutes(raw.window_minutes);
  if (usedPercent === null || windowMinutes === null) return null;
  return { usedPercent, windowMinutes, resetsAt: epochSeconds(raw.resets_at) };
}

function rateLimitsFromLine(line: string): { timestamp: string; windows: AccountUsageWindow[] } | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const event = parsed as Record<string, unknown>;
    if (event.type !== 'event_msg') return null;
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return null;
    const message = payload as Record<string, unknown>;
    if (message.type !== 'token_count') return null;
    const rateLimits = message.rate_limits;
    if (!rateLimits || typeof rateLimits !== 'object') return null;
    const limits = rateLimits as Record<string, unknown>;
    const windows = [parseWindow(limits.primary), parseWindow(limits.secondary)].filter((window): window is AccountUsageWindow => window !== null);
    if (!windows.length) return null;
    const timestamp = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
      ? event.timestamp
      : new Date(0).toISOString();
    return { timestamp, windows };
  } catch {
    return null;
  }
}

export class CodexSessionUsageReader implements UsageReader {
  private cache: { cachedAt: number; snapshot: AccountUsageSnapshot } | null = null;

  constructor(
    private readonly codexHome = join(homedir(), '.codex'),
    private readonly lookbackDays = 8,
    private readonly cacheTtlMs = 10_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async usageFiles(cutoff: Date): Promise<Array<{ path: string; modifiedAt: Date }>> {
    const files: Array<{ path: string; modifiedAt: Date }> = [];
    for (const root of [join(this.codexHome, 'sessions'), join(this.codexHome, 'archived_sessions')]) {
      await this.collectFiles(root, cutoff, files, 0);
    }
    return files.sort((left, right) => right.modifiedAt.getTime() - left.modifiedAt.getTime());
  }

  private async collectFiles(
    directory: string,
    cutoff: Date,
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
        await this.collectFiles(path, cutoff, files, depth + 1);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      try {
        const metadata = await stat(path);
        if (metadata.mtime >= cutoff) files.push({ path, modifiedAt: metadata.mtime });
      } catch {
        continue;
      }
    }
  }

  async read(): Promise<AccountUsageSnapshot> {
    const now = this.now();
    if (this.cache && now.getTime() - this.cache.cachedAt < this.cacheTtlMs) return this.cache.snapshot;
    const cutoff = new Date(now.getTime() - this.lookbackDays * 86_400_000);
    const files = await this.usageFiles(cutoff);
    let latestTimestamp = '';
    let latestWindows: AccountUsageWindow[] = [];

    for (const file of files) {
      const stream = createReadStream(file.path, { encoding: 'utf8' });
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (!line.includes('"rate_limits"')) continue;
          const telemetry = rateLimitsFromLine(line);
          if (telemetry && telemetry.timestamp > latestTimestamp) {
            latestTimestamp = telemetry.timestamp;
            latestWindows = telemetry.windows;
          }
        }
      } finally {
        lines.close();
        stream.destroy();
      }
    }

    const fiveHour = latestWindows.find(window => window.windowMinutes === 300) ?? null;
    const weekly = latestWindows.find(window => window.windowMinutes === 10_080) ?? null;
    const available = fiveHour !== null && weekly !== null;
    const snapshot: AccountUsageSnapshot = {
      available,
      generatedAt: now.toISOString(),
      fiveHour,
      weekly,
      reason: available
        ? null
        : files.length
          ? 'Real account rate-limit telemetry is present, but both the 5-hour and weekly windows are not available.'
          : 'No recent Codex account rate-limit telemetry is available.',
    };
    this.cache = { cachedAt: now.getTime(), snapshot };
    return snapshot;
  }
}


export class ZaiUsageReader implements UsageReader {
  constructor(
    private readonly apiKey = process.env.ZAI_API_KEY ?? '',
    private readonly endpoint = 'https://api.z.ai/api/monitor/usage/quota/limit',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<AccountUsageSnapshot> {
    const generatedAt = this.now().toISOString();
    if (!this.apiKey) {
      return { available: false, generatedAt, fiveHour: null, weekly: null, reason: 'ZAI_API_KEY is not configured.' };
    }
    try {
      const response = await this.fetchImpl(this.endpoint, {
        headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' },
      });
      if (!response.ok) {
        return { available: false, generatedAt, fiveHour: null, weekly: null, reason: `Z.ai usage request failed with HTTP ${response.status}.` };
      }
      const payload = await response.json() as { data?: { limits?: Array<Record<string, unknown>> } };
      const limits = Array.isArray(payload?.data?.limits) ? payload.data.limits : [];
      const readLimit = (unit: number, windowMinutes: number): AccountUsageWindow | null => {
        const raw = limits.find(limit => (limit.type === 'TOKENS_LIMIT' || limit.type === 'CREDIT_LIMIT') && limit.unit === unit);
        if (!raw) return null;
        const usedPercent = finitePercent(raw.percentage);
        if (usedPercent === null) return null;
        const resetMs = typeof raw.nextResetTime === 'number' && Number.isFinite(raw.nextResetTime) ? raw.nextResetTime : null;
        return { usedPercent, windowMinutes, resetsAt: resetMs === null ? null : Math.floor(resetMs / 1000) };
      };
      const fiveHour = readLimit(3, 300);
      const weekly = readLimit(6, 10_080);
      const available = fiveHour !== null && weekly !== null;
      return {
        available,
        generatedAt,
        fiveHour,
        weekly,
        reason: available ? null : 'Z.ai returned no usable 5-hour and weekly Coding Plan quota windows.',
      };
    } catch {
      return { available: false, generatedAt, fiveHour: null, weekly: null, reason: 'Z.ai account usage request could not be completed.' };
    }
  }
}

export class UsageRegistry {
  constructor(
    private readonly openaiReader: UsageReader,
    private readonly zaiReader: UsageReader = new ZaiUsageReader(),
  ) {}

  async snapshot(): Promise<AccountUsageOverview> {
    const [openai, zai] = await Promise.all([this.openaiReader.read(), this.zaiReader.read()]);
    return {
      generatedAt: new Date().toISOString(),
      providers: [
        { id: 'openai', label: 'OpenAI', usage: openai },
        { id: 'zai', label: 'Z.ai', usage: zai },
      ],
    };
  }
}

export class UnavailableUsageReader implements UsageReader {
  constructor(private readonly reason: string, private readonly now: () => Date = () => new Date()) {}

  async read(): Promise<AccountUsageSnapshot> {
    return {
      available: false,
      generatedAt: this.now().toISOString(),
      fiveHour: null,
      weekly: null,
      reason: this.reason,
    };
  }
}

export function codexAndZaiUsageRegistry(codexHome?: string, _legacyWindowDays?: number): UsageRegistry {
  return new UsageRegistry(new CodexSessionUsageReader(codexHome));
}
