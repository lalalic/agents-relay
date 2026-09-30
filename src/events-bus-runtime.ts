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

export async function eventsBusHistory(jobId: string, taskId: string | null, limit: number, env: NodeJS.ProcessEnv = process.env): Promise<import('./types.js').EventRecord[]> {
  const runtime = resolveEventsBusRuntime(env);
  const url = new URL('/events', runtime.apiUrl);
  url.searchParams.set('job', jobId);
  if (taskId) url.searchParams.set('task', taskId);
  const boundedLimit = Math.max(1, Math.min(60, limit));
  url.searchParams.set('limit', String(boundedLimit));
  url.searchParams.set('order', 'desc');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`events-bus history unavailable: HTTP ${response.status}`);
  const body = await response.json() as { events?: { event?: import('./types.js').EventRecord }[] };
  const rows = Array.isArray(body.events) ? body.events : [];
  return rows.map(row => row.event).filter((event): event is import('./types.js').EventRecord => Boolean(event));
}
