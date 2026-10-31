import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Resource state only. Relay's Task graph remains the sole lifecycle authority. */
export type BrowserProvider = 'chatgpt' | 'z';
export type BrowserPoolState = 'IDLE' | 'LEASED' | 'QUARANTINED';
export type BrowserSlot = {
  provider: BrowserProvider; slot: number; executionId: string; generation: number;
  sessionId: string | null; threadUrl: string | null;
};
export type BrowserPoolSnapshot = {
  provider: BrowserProvider; capacity: number; idle: number; leased: number; quarantined: number;
  queued: number; health: 'HEALTHY' | 'UNAVAILABLE'; unavailableUntil: number | null;
};
export class BrowserPoolAdmissionError extends Error {
  readonly submitted = false;
  constructor(readonly code: 'PROVIDER_UNAVAILABLE' | 'POOL_CAPACITY_FULL' | 'POOL_WAIT_EXPIRED', message: string) {
    super(message); this.name = 'BrowserPoolAdmissionError';
  }
}

export interface BrowserPoolOptions {
  path?: string;
  capacity?: number;
  maxQueue?: number;
  queueWaitMs?: number;
  pollMs?: number;
  clock?: () => number;
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const defaultPoolPath = (): string => join(
  process.env.AGENTS_RELAY_STORE_DIR || join(homedir(), '.agents-relay', 'stores'),
  'browser-worker-pool.sqlite',
);

type SqlSlot = {
  provider: BrowserProvider; slot: number; execution_id: string | null; generation: number;
  session_id: string | null; thread_url: string | null;
};

/** SQLite transactions arbitrate across daemon processes, not just within one JS isolate. */
export class BrowserWorkerPoolManager {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly capacity: number;
  private readonly maxQueue: number;
  private readonly queueWaitMs: number;
  private readonly pollMs: number;
  constructor(options: BrowserPoolOptions = {}) {
    const path = options.path ?? defaultPoolPath();
    if (path !== ':memory:') mkdirSync(dirname(path), {recursive: true});
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS browser_slots (
        provider TEXT NOT NULL, slot INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'IDLE',
        execution_id TEXT, generation INTEGER NOT NULL DEFAULT 0, session_id TEXT, thread_url TEXT,
        touched_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(provider,slot)
      );
      CREATE TABLE IF NOT EXISTS browser_queue (
        execution_id TEXT PRIMARY KEY, provider TEXT NOT NULL, queued_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS browser_queue_order ON browser_queue(provider, queued_at, execution_id);
      CREATE TABLE IF NOT EXISTS browser_provider_health (
        provider TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, unavailable_until INTEGER NOT NULL DEFAULT 0
      );
    `);
    this.capacity = options.capacity ?? 3;
    this.maxQueue = options.maxQueue ?? 12;
    this.queueWaitMs = options.queueWaitMs ?? 60_000;
    this.pollMs = options.pollMs ?? 250;
    this.clock = options.clock ?? Date.now;
    if (!Number.isInteger(this.capacity) || this.capacity < 1 || this.capacity > 32) throw Error('Invalid pool capacity');
    for (const provider of ['chatgpt', 'z'] as const) {
      for (let slot = 1; slot <= this.capacity; slot++) {
        this.db.prepare('INSERT OR IGNORE INTO browser_slots(provider,slot) VALUES(?,?)').run(provider, slot);
      }
      this.db.prepare('INSERT OR IGNORE INTO browser_provider_health(provider) VALUES(?)').run(provider);
    }
  }
  close(): void { this.db.close(); }
  snapshot(provider: BrowserProvider): BrowserPoolSnapshot {
    const count = (state: BrowserPoolState): number => (this.db.prepare('SELECT count(*) AS n FROM browser_slots WHERE provider=? AND state=?').get(provider,state) as {n:number}).n;
    const queued = (this.db.prepare('SELECT count(*) AS n FROM browser_queue WHERE provider=?').get(provider) as {n:number}).n;
    const health = this.db.prepare('SELECT unavailable_until FROM browser_provider_health WHERE provider=?').get(provider) as {unavailable_until:number};
    return { provider,capacity:this.capacity,idle:count('IDLE'),leased:count('LEASED'),quarantined:count('QUARANTINED'),queued,
      health:health.unavailable_until > this.clock() ? 'UNAVAILABLE' : 'HEALTHY',
      unavailableUntil:health.unavailable_until > this.clock() ? health.unavailable_until : null };
  }
  /** Mark only independently observed, pre-submission provider failures. */
  reportPreSubmissionOutage(provider: BrowserProvider, durationMs = 120_000): void {
    this.db.prepare('UPDATE browser_provider_health SET failures=failures+1, unavailable_until=? WHERE provider=?')
      .run(this.clock()+durationMs,provider);
  }
  reportHealthy(provider: BrowserProvider): void {
    this.db.prepare('UPDATE browser_provider_health SET failures=0,unavailable_until=0 WHERE provider=?').run(provider);
  }
  private tryClaim(provider: BrowserProvider, executionId: string): BrowserSlot | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = this.clock();
      const health = this.db.prepare('SELECT unavailable_until FROM browser_provider_health WHERE provider=?').get(provider) as {unavailable_until:number};
      if (health.unavailable_until > now) throw new BrowserPoolAdmissionError('PROVIDER_UNAVAILABLE',`${provider} circuit open until ${health.unavailable_until}`);
      const existing = this.db.prepare('SELECT * FROM browser_slots WHERE execution_id=? AND provider=?').get(executionId,provider) as (SqlSlot & {state:BrowserPoolState}) | undefined;
      if (existing) throw new Error(`Execution ${executionId} already owns ${provider}-${existing.slot}: refuse duplicate browser submission`);
      this.db.prepare('DELETE FROM browser_queue WHERE queued_at < ?').run(now-this.queueWaitMs-30000);
      const row = this.db.prepare('SELECT execution_id FROM browser_queue WHERE provider=? ORDER BY queued_at,rowid LIMIT 1').get(provider) as {execution_id:string}|undefined;
      if (!row || row.execution_id === executionId) {
        const idle = this.db.prepare("SELECT * FROM browser_slots WHERE provider=? AND state='IDLE' ORDER BY slot LIMIT 1").get(provider) as SqlSlot|undefined;
        if (idle) {
          const generation = idle.generation+1;
          this.db.prepare("UPDATE browser_slots SET state='LEASED',execution_id=?,generation=?,session_id=NULL,thread_url=NULL,touched_at=? WHERE provider=? AND slot=? AND state='IDLE'")
            .run(executionId,generation,now,provider,idle.slot);
          this.db.prepare('DELETE FROM browser_queue WHERE execution_id=?').run(executionId);
          return {provider,slot:idle.slot,executionId,generation,sessionId:null,threadUrl:null};
        }
      }
      return null;
    } finally { this.db.exec('COMMIT'); }
  }
  private dequeue(executionId: string): void {
    this.db.prepare('DELETE FROM browser_queue WHERE execution_id=?').run(executionId);
  }
  async acquire(provider: BrowserProvider, executionId: string, signal?: AbortSignal): Promise<BrowserSlot> {
    const deadline = this.clock()+this.queueWaitMs;
    // First claim is eager. Busy slots never count as provider outages.
    const immediate = this.tryClaim(provider, executionId);
    if (immediate) return immediate;
    const count = (this.db.prepare('SELECT count(*) AS n FROM browser_queue WHERE provider=?').get(provider) as {n:number}).n;
    if (count >= this.maxQueue) throw new BrowserPoolAdmissionError('POOL_CAPACITY_FULL',`${provider} queue is full`);
    this.db.prepare('INSERT OR IGNORE INTO browser_queue(execution_id,provider,queued_at) VALUES(?,?,?)').run(executionId,provider,this.clock());
    try {
      for (;;) {
        if (signal?.aborted) throw Error('Browser pool acquire aborted');
        const result = this.tryClaim(provider, executionId);
        if (result) return result;
        if (this.clock() >= deadline) throw new BrowserPoolAdmissionError('POOL_WAIT_EXPIRED',`${provider} queue wait expired without browser submission`);
        await sleep(this.pollMs);
      }
    } finally { this.dequeue(executionId); }
  }
  private update(lease: BrowserSlot, state: BrowserPoolState, sessionId: string | null, threadUrl: string | null): void {
    const result = this.db.prepare('UPDATE browser_slots SET state=?,session_id=?,thread_url=?,touched_at=? WHERE provider=? AND slot=? AND execution_id=? AND generation=?')
      .run(state,sessionId,threadUrl,this.clock(),lease.provider,lease.slot,lease.executionId,lease.generation);
    if (Number(result.changes) !== 1) throw Error('Stale browser pool lease generation; refusing mutation');
  }
  bindSession(lease: BrowserSlot, sessionId: string): void {
    lease.sessionId=sessionId; this.update(lease,'LEASED',sessionId,lease.threadUrl);
  }
  bindThread(lease: BrowserSlot, url: string): void {
    const expected = lease.provider === 'z' ? 'chat.z.ai' : 'chatgpt.com';
    const parsed = new URL(url);
    if (parsed.protocol!=='https:' || parsed.hostname!==expected || !/^\/c\/[\w-]+\/?$/.test(parsed.pathname)) throw Error('Unsafe browser thread URL');
    lease.threadUrl=parsed.origin+parsed.pathname;
    this.update(lease,'LEASED',lease.sessionId,lease.threadUrl);
  }
  touch(lease: BrowserSlot): void { this.update(lease,'LEASED',lease.sessionId,lease.threadUrl); }
  release(lease: BrowserSlot): void {
    const result = this.db.prepare("UPDATE browser_slots SET state='IDLE',execution_id=NULL,session_id=NULL,thread_url=NULL,touched_at=? WHERE provider=? AND slot=? AND execution_id=? AND generation=? AND state='LEASED'")
      .run(this.clock(),lease.provider,lease.slot,lease.executionId,lease.generation);
    if (Number(result.changes)!==1) throw Error('Stale browser pool lease release');
  }
  quarantine(lease: BrowserSlot): void { this.update(lease,'QUARANTINED',lease.sessionId,lease.threadUrl); }
  /** Recovery can only release quarantined slots after verifying the old worker is no longer active. */
  releaseQuarantine(lease: BrowserSlot, verifiedStopped: boolean): void {
    if (!verifiedStopped) throw Error('Cannot release quarantined slot without independent stop verification');
    const result=this.db.prepare("UPDATE browser_slots SET state='IDLE',execution_id=NULL,session_id=NULL,thread_url=NULL,touched_at=? WHERE provider=? AND slot=? AND execution_id=? AND generation=? AND state='QUARANTINED'")
      .run(this.clock(),lease.provider,lease.slot,lease.executionId,lease.generation);
    if (Number(result.changes)!==1) throw Error('Stale quarantine release');
  }
}
