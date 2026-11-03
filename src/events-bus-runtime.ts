import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type EventsBusRuntime = { natsUrl: string; apiUrl: string; subjectPrefix: string; configPath: string };

export function eventsBusConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.NEO_EVENTS_BUS_CONFIG) return env.NEO_EVENTS_BUS_CONFIG;
  const dataDir = env.EVENTS_BUS_DATA_DIR || join(homedir(), 'Library', 'Application Support', 'EventsBus');
  return join(dataDir, 'runtime.json');
}

export function resolveEventsBusRuntime(env: NodeJS.ProcessEnv = process.env): EventsBusRuntime {
  const configPath = eventsBusConfigPath(env);
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>; } catch { /* fall through to protocol defaults */ }
  return {
    configPath,
    natsUrl: env.NEO_NATS_URL || String(saved.natsUrl || 'nats://127.0.0.1:4222'),
    apiUrl: env.NEO_EVENTS_API_URL || String(saved.apiUrl || 'http://127.0.0.1:4223'),
    subjectPrefix: env.NEO_EVENTS_SUBJECT_PREFIX || String(saved.subjectPrefix || 'neo.events.job'),
  };
}

export type EventsHistoryPage = {
  events: import('./types.js').EventRecord[];
  rows: Array<{ cursor: number; event: import('./types.js').EventRecord }>;
  nextCursor: number;
};

/** Query the public Events Bus history API. `asc` + `after` is the supported
 * cursor pagination path; never read its private history backing file. */
export async function eventsBusHistoryPage(
  jobId: string, taskId: string | null, limit: number,
  options: { order?: 'asc' | 'desc'; after?: number; timeoutMs?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<EventsHistoryPage> {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Invalid event history page limit');
  const timeoutMs = options.timeoutMs ?? 12000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000)
    throw new Error('Invalid event history timeout');
  const runtime = resolveEventsBusRuntime(env);
  const url = new URL('/events', runtime.apiUrl);
  const order = options.order ?? 'desc';
  const after = options.after ?? 0;
  if (order !== 'asc' && order !== 'desc') throw new Error('Invalid event history order');
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid event history cursor');
  if (order === 'desc' && after !== 0) throw new Error('Event history cursor requires ascending order');
  url.searchParams.set('job', jobId);
  if (taskId) url.searchParams.set('task', taskId);
  const boundedLimit = Math.max(1, Math.min(60, limit));
  url.searchParams.set('limit', String(boundedLimit));
  url.searchParams.set('order', order);
  if (order === 'asc') url.searchParams.set('after', String(after));
  let body: {
    job_id?: string; order?: string;
    events?: { cursor?: number; event?: import('./types.js').EventRecord }[];
    next_cursor?: number;
  };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json() as typeof body;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`events-bus history unavailable: ${reason}`);
  }

  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      body.job_id !== jobId || body.order !== order || !Array.isArray(body.events) ||
      body.events.length > boundedLimit)
    throw new Error('events-bus history returned an unexpected Job, order, or events payload');
  const events: import('./types.js').EventRecord[] = [];
  const rows: Array<{cursor:number;event:import('./types.js').EventRecord}> = [];
  let previous = order === 'asc' ? after : Number.POSITIVE_INFINITY;
  for (const row of body.events) {
    const cursor = row?.cursor;
    const event = row?.event;
    if (typeof cursor !== 'number' || !Number.isSafeInteger(cursor) || cursor <= 0 || !event ||
        event.job_id !== jobId || (taskId !== null && event.task_id !== taskId) ||
        (order === 'asc' ? cursor <= previous : cursor >= previous))
      throw new Error('events-bus history returned invalid, out-of-order, or cross-Task event data');
    previous = cursor;
    events.push(event);
    rows.push({cursor,event});
  }
  const nextCursor = body.next_cursor;
  const expectedCursor = body.events.length
    ? (order === 'asc' ? body.events.at(-1)!.cursor : body.events[0].cursor)
    : after;
  if (typeof nextCursor !== 'number' || !Number.isSafeInteger(nextCursor) || nextCursor !== expectedCursor ||
      (order === 'asc' && events.length > 0 && nextCursor <= after))
    throw new Error('events-bus history returned an invalid or non-advancing cursor');
  return { events, rows, nextCursor };
}

/** Existing newest-first reader for dashboard and runtime summaries. */
export async function eventsBusHistory(jobId: string, taskId: string | null, limit: number, env: NodeJS.ProcessEnv = process.env): Promise<import('./types.js').EventRecord[]> {
  return (await eventsBusHistoryPage(jobId, taskId, limit, { order: 'desc' }, env)).events;
}
