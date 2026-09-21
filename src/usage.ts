import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

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

export type CreditBalance = { currency: string; total: number | null; used: number | null; remaining: number | null };

export type CreditSnapshot = {
  available: boolean;
  generatedAt: string;
  balances: CreditBalance[];
  reason: string | null;
};

export type CreditProvider = { id: 'deepseek' | 'openrouter'; label: string; credits: CreditSnapshot };

export type AccountUsageOverview = {
  generatedAt: string;
  providers: AccountUsageProvider[];
  credits: CreditProvider[];
};

export type UsageSnapshot = AccountUsageOverview;

export interface UsageSnapshotProvider {
  snapshot(): Promise<UsageSnapshot>;
}

export interface UsageReader {
  read(): Promise<AccountUsageSnapshot>;
}

export interface CreditReader {
  read(): Promise<CreditSnapshot>;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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
    const timestamp = typeof event.timestamp === 'string' && !Number.isNaN(Date.parse(event.timestamp))
      ? event.timestamp
      : new Date(0).toISOString();
    return { timestamp, windows };
  } catch {
    return null;
  }
}

export class CodexApiUsageReader implements UsageReader {
  constructor(private readonly now: () => Date = () => new Date()) {}
  async read(): Promise<AccountUsageSnapshot> {
    const generatedAt = this.now().toISOString();
    return await new Promise(resolve => {
      const child = spawn('codex', ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      const finish = (snapshot: AccountUsageSnapshot) => { lines.close(); child.kill(); resolve(snapshot); };
      const timer = setTimeout(() => finish({ available: false, generatedAt, fiveHour: null, weekly: null, reason: 'Codex app-server rate-limit request timed out.' }), 10_000);
      lines.on('line', line => {
        try {
          const message = JSON.parse(line) as { id?: number; result?: { rateLimits?: { primary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number }; secondary?: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } } } };
          if (message.id !== 2) return;
          clearTimeout(timer);
          const parse = (window: { usedPercent?: number; windowDurationMins?: number; resetsAt?: number } | undefined): AccountUsageWindow | null => {
            if (!window) return null; const usedPercent = finitePercent(window.usedPercent); const windowMinutes = positiveMinutes(window.windowDurationMins);
            return usedPercent === null || windowMinutes === null ? null : { usedPercent, windowMinutes, resetsAt: epochSeconds(window.resetsAt) };
          };
          const limits = message.result?.rateLimits; const primary = parse(limits?.primary); const secondary = parse(limits?.secondary);
          const windows = [primary, secondary].filter((window): window is AccountUsageWindow => window !== null);
          const fiveHour = windows.find(window => window.windowMinutes === 300) ?? null; const weekly = windows.find(window => window.windowMinutes === 10_080) ?? null;
          const available = fiveHour !== null && weekly !== null; finish({ available, generatedAt, fiveHour, weekly, reason: available ? null : 'Codex app-server did not return both account quota windows.' });
        } catch { return; }
      });
      child.once('error', () => { clearTimeout(timer); finish({ available: false, generatedAt, fiveHour: null, weekly: null, reason: 'Codex app-server could not be started.' }); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'agents-relay', version: '1' }, capabilities: {} } }) + '\n');
      setTimeout(() => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'account/rateLimits/read', params: {} }) + '\n'), 100);
    });
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
    const telemetryAgeMs = latestTimestamp ? now.getTime() - Date.parse(latestTimestamp) : Number.POSITIVE_INFINITY;
    const fresh = telemetryAgeMs >= 0 && telemetryAgeMs <= 15 * 60_000;
    const available = fresh && fiveHour !== null && weekly !== null;
    const snapshot: AccountUsageSnapshot = {
      available,
      generatedAt: now.toISOString(),
      fiveHour,
      weekly,
      reason: available
        ? null
        : latestTimestamp && !fresh
          ? 'Latest Codex account rate-limit telemetry is stale.'
          : files.length
          ? 'Latest Codex account telemetry does not expose current 5-hour and weekly rate-limit windows.'
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


export class DeepSeekCreditReader implements CreditReader {
  constructor(
    private readonly apiKey = process.env.DEEPSEEK_API_KEY ?? '',
    private readonly endpoint = 'https://api.deepseek.com/user/balance',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<CreditSnapshot> {
    const generatedAt = this.now().toISOString();
    if (!this.apiKey) return { available: false, generatedAt, balances: [], reason: 'DEEPSEEK_API_KEY is not configured.' };
    try {
      const response = await this.fetchImpl(this.endpoint, { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' } });
      if (!response.ok) return { available: false, generatedAt, balances: [], reason: `DeepSeek balance request failed with HTTP ${response.status}.` };
      const payload = await response.json() as { is_available?: boolean; balance_infos?: Array<Record<string, unknown>> };
      const balances = (Array.isArray(payload.balance_infos) ? payload.balance_infos : []).map(info => ({
        currency: typeof info.currency === 'string' ? info.currency : 'credit',
        total: finiteNumber(info.total_balance),
        used: null,
        remaining: finiteNumber(info.total_balance),
      })).filter(balance => balance.remaining !== null);
      return { available: payload.is_available === true && balances.length > 0, generatedAt, balances, reason: balances.length ? null : 'DeepSeek returned no usable balance information.' };
    } catch {
      return { available: false, generatedAt, balances: [], reason: 'DeepSeek balance request could not be completed.' };
    }
  }
}

export class OpenRouterCreditReader implements CreditReader {
  constructor(
    private readonly apiKey = process.env.OPENROUTER_API_KEY ?? '',
    private readonly endpoint = 'https://openrouter.ai/api/v1/credits',
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async read(): Promise<CreditSnapshot> {
    const generatedAt = this.now().toISOString();
    if (!this.apiKey) return { available: false, generatedAt, balances: [], reason: 'OPENROUTER_API_KEY is not configured.' };
    try {
      const response = await this.fetchImpl(this.endpoint, { headers: { Authorization: `Bearer ${this.apiKey}`, Accept: 'application/json' } });
      if (!response.ok) return { available: false, generatedAt, balances: [], reason: `OpenRouter credits request failed with HTTP ${response.status}; this endpoint requires a management key.` };
      const payload = await response.json() as { data?: { total_credits?: unknown; total_usage?: unknown } };
      const total = finiteNumber(payload.data?.total_credits);
      const used = finiteNumber(payload.data?.total_usage);
      const remaining = total !== null && used !== null ? total - used : null;
      const balances = total === null && used === null ? [] : [{ currency: 'USD', total, used, remaining }];
      return { available: balances.length > 0, generatedAt, balances, reason: balances.length ? null : 'OpenRouter returned no usable credit information.' };
    } catch {
      return { available: false, generatedAt, balances: [], reason: 'OpenRouter credits request could not be completed.' };
    }
  }
}

export class UsageRegistry implements UsageSnapshotProvider {
  constructor(
    private readonly openaiReader: UsageReader,
    private readonly zaiReader: UsageReader = new ZaiUsageReader(),
    private readonly deepSeekReader: CreditReader | null = null,
    private readonly openRouterReader: CreditReader | null = null,
  ) {}

  async snapshot(): Promise<AccountUsageOverview> {
    const [openai, zai, deepseek, openrouter] = await Promise.all([
      this.openaiReader.read(),
      this.zaiReader.read(),
      this.deepSeekReader?.read() ?? Promise.resolve(null),
      this.openRouterReader?.read() ?? Promise.resolve(null),
    ]);
    const credits: CreditProvider[] = [];
    if (deepseek) credits.push({ id: 'deepseek', label: 'DeepSeek', credits: deepseek });
    if (openrouter) credits.push({ id: 'openrouter', label: 'OpenRouter', credits: openrouter });
    return {
      generatedAt: new Date().toISOString(),
      providers: [
        { id: 'openai', label: 'OpenAI', usage: openai },
        { id: 'zai', label: 'Z.ai', usage: zai },
      ],
      credits,
    };
  }
}

/** Read one fresh, on-demand snapshot from the shared usage source. */
export function readUsageSnapshot(source: UsageSnapshotProvider): Promise<UsageSnapshot> {
  return source.snapshot();
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
  return new UsageRegistry(
    new CodexApiUsageReader(),
    new ZaiUsageReader(),
    process.env.DEEPSEEK_API_KEY ? new DeepSeekCreditReader() : null,
    process.env.OPENROUTER_API_KEY ? new OpenRouterCreditReader() : null,
  );
}
