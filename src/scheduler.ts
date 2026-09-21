import { Job, JobSchedule, MissedRunPolicy, ScheduleConcurrencyPolicy, Task, TaskState, assertJobTransition, assertTaskTransition } from './types.js';
export function dependencyReady(task: Task, tasks: Map<string, Task>): boolean { return task.dependencies.every(id => tasks.get(id)?.state === 'SUCCEEDED'); }
export function detectCycles(tasks: Task[]): void { const map = new Map(tasks.map(t => [t.id, t])); const visiting = new Set<string>(); const done = new Set<string>(); const visit = (id: string): void => { if (visiting.has(id)) throw new Error(`Dependency cycle at ${id}`); if (done.has(id)) return; visiting.add(id); for (const dep of map.get(id)?.dependencies ?? []) visit(dep); visiting.delete(id); done.add(id); }; for (const task of tasks) visit(task.id); }
function scheduledCycleTasks(job: Job): Task[] {
  const slot = job.schedule?.currentRunSlot ? Date.parse(job.schedule.currentRunSlot) : Number.NaN;
  if (!Number.isFinite(slot)) return job.tasks;
  return job.tasks.filter(task => Date.parse(task.createdAt) >= slot);
}
export function completionGateSatisfied(job: Job): boolean {
  if (job.schedule) return false;
  if (job.executionMode !== 'autonomous') return true;
  const planners = job.tasks.filter(task => task.kind === 'planner');
  return planners.some(task => task.state === 'SUCCEEDED' && task.plannerResult?.objective_status === 'satisfied') && job.tasks.every(task => task.state === 'SUCCEEDED');
}
export function schedule(job: Job): Job {
  detectCycles(job.tasks);
  const scopedTasks = scheduledCycleTasks(job);
  if (scopedTasks.length === 0) {
    if (job.executionMode === 'autonomous' && job.state !== 'WAITING') { assertJobTransition(job.state, 'WAITING'); job.state = 'WAITING'; job.updatedAt = new Date().toISOString(); }
    return job;
  }
  const map = new Map(job.tasks.map(t => [t.id, t]));
  for (const task of scopedTasks) { if (['QUEUED', 'WAITING'].includes(task.state) && dependencyReady(task, map)) transitionTask(task, 'READY'); }
  const active = scopedTasks.some(t => ['READY', 'RUNNING'].includes(t.state)); const blocked = scopedTasks.some(t => t.state === 'BLOCKED'); const waiting = scopedTasks.some(t => ['QUEUED', 'WAITING'].includes(t.state)); const failed = scopedTasks.some(t => t.state === 'FAILED'); const cancelled = scopedTasks.every(t => t.state === 'CANCELLED');
  const next = active ? 'RUNNING' : failed ? 'FAILED' : blocked ? 'BLOCKED' : waiting ? 'WAITING' : cancelled ? 'CANCELLED' : completionGateSatisfied(job) ? 'COMPLETED' : 'WAITING';
  if (job.schedule && next === 'WAITING') {
    const planners = scopedTasks.filter(task => task.kind === 'planner');
    const latest = planners.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1);
    if (latest?.state === 'SUCCEEDED' && latest.plannerResult?.objective_status === 'satisfied') {
      const slot = job.schedule.currentRunSlot ? Date.parse(job.schedule.currentRunSlot) : Number.NaN;
      const lastRun = job.schedule.lastRunAt ? Date.parse(job.schedule.lastRunAt) : Number.NaN;
      if (Number.isFinite(slot) && (!Number.isFinite(lastRun) || lastRun < slot)) job.schedule.lastRunAt = new Date().toISOString();
      job.schedule.currentRunSlot = null;
    }
  }
  if (job.state !== next) { assertJobTransition(job.state, next); job.state = next; job.updatedAt = new Date().toISOString(); }
  return job;
}
export function extendRetryBudget(task: Pick<Task, 'attempt' | 'maxAttempts'>, windowSize = 3): number {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('Retry window size must be a positive integer');
  const usedOrBudgeted = Math.max(task.maxAttempts, task.attempt);
  return Math.max(windowSize, (Math.floor(usedOrBudgeted / windowSize) + 1) * windowSize);
}
export function transitionTask(task: Task, state: TaskState): void { assertTaskTransition(task.state, state); task.state = state; if (['READY', 'RUNNING', 'SUCCEEDED'].includes(state)) task.error = null; task.updatedAt = new Date().toISOString(); }

export const SCHEDULE_RESOLUTION_MS = 600_000;
export const RUN_BUCKET_LABEL_COUNT = 144;
const CRON_PART = /^(?:\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/;

function cronField(raw: string, name: string, minimum: number, maximum: number): Set<number> {
  const values = new Set<number>();
  for (const part of raw.split(',')) {
    const match = CRON_PART.exec(part);
    if (!match) throw new Error(`Invalid schedule ${name}: ${part}`);
    const [whole, firstText, lastText, stepText] = match;
        if (whole === undefined) continue;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`Invalid schedule ${name} step: ${part}`);
    let start = minimum;
    let end = maximum;
    if (firstText !== undefined) {
      start = Number(firstText);
      end = lastText === undefined ? (stepText === undefined ? start : maximum) : Number(lastText);
      if (start < minimum || end > maximum || start > end) throw new Error(`Invalid schedule ${name} range: ${part}`);
    }
    for (let value = start; value <= end; value += step) {
      if (value > maximum) break;
      values.add(name === 'weekday' && value === 7 ? 0 : value);
    }
  }
  if (values.size === 0) throw new Error(`Invalid schedule ${name}: ${raw}`);
  return values;
}

type CronFields = { minute: Set<number>; hour: Set<number>; dayOfMonth: Set<number>; month: Set<number>; weekday: Set<number> };
export function parseCron(cron: string): CronFields {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Schedule cron must contain exactly five fields');
  const parsed: CronFields = {
    minute: cronField(fields[0], 'minute', 0, 59),
    hour: cronField(fields[1], 'hour', 0, 23),
    dayOfMonth: cronField(fields[2], 'day-of-month', 1, 31),
    month: cronField(fields[3], 'month', 1, 12),
    weekday: cronField(fields[4], 'weekday', 0, 7),
  };
  for (const minute of parsed.minute) if (minute % (SCHEDULE_RESOLUTION_MS / 60_000) !== 0) throw new Error(`Schedule minute ${minute} is finer than the 10-minute scheduler resolution`);
  return parsed;
}

function timezoneParts(time: Date, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(time);
  const value = (type: string): string => parts.find(part => part.type === type)?.value ?? '';
  const weekdays = new Map([['Sun', 0], ['Mon', 1], ['Tue', 2], ['Wed', 3], ['Thu', 4], ['Fri', 5], ['Sat', 6]]);
  const weekday = weekdays.get(value('weekday'));
  if (weekday === undefined) throw new Error(`Unable to resolve timezone weekday ${timeZone}`);
  return { year: Number(value('year')), month: Number(value('month')), day: Number(value('day')), hour: Number(value('hour')), minute: Number(value('minute')), weekday };
}

function cronMatches(fields: CronFields, time: Date, timeZone: string): boolean {
  const local = timezoneParts(time, timeZone);
  if (!fields.minute.has(local.minute) || !fields.hour.has(local.hour) || !fields.month.has(local.month)) return false;
  const domWildcard = fields.dayOfMonth.size === 31;
  const dowWildcard = fields.weekday.size === 7;
  const domMatch = fields.dayOfMonth.has(local.day);
  const dowMatch = fields.weekday.has(local.weekday);
  const dayMatch = domWildcard && dowWildcard ? true : domWildcard ? dowMatch : dowWildcard ? domMatch : domMatch || dowMatch;
  return dayMatch;
}

export function nextCronRun(cron: string, timeZone: string, after: Date = new Date()): Date {
  const fields = parseCron(cron);
  if (!isValidTimeZone(timeZone)) throw new Error(`Invalid schedule timezone: ${timeZone}`);
  const candidate = new Date(Math.floor((after.getTime() + 60_000) / 60_000) * 60_000);
  const limit = candidate.getTime() + 366 * 24 * 60 * 60_000;
  while (candidate.getTime() < limit) {
    if (cronMatches(fields, candidate, timeZone)) return new Date(candidate);
    candidate.setUTCMinutes(candidate.getUTCMinutes() + 1);
  }
  throw new Error(`Schedule ${cron} has no next run within one year`);
}

export function isValidTimeZone(timeZone: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone }); return true; } catch { return false; }
}

export function parseJobSchedule(options: { cron: string; timezone: string; nextRunAt?: string; missedRunPolicy?: MissedRunPolicy; concurrencyPolicy?: ScheduleConcurrencyPolicy }): JobSchedule {
  const fields = parseCron(options.cron);
  if (!isValidTimeZone(options.timezone)) throw new Error(`Invalid schedule timezone: ${options.timezone}`);
  const missedRunPolicy = options.missedRunPolicy ?? 'skip';
  const concurrencyPolicy = options.concurrencyPolicy ?? 'skip';
  if (!['run', 'skip'].includes(missedRunPolicy)) throw new Error('Invalid missed-run policy');
  if (!['skip', 'queue'].includes(concurrencyPolicy)) throw new Error('Invalid schedule concurrency policy');
  const next = options.nextRunAt ? new Date(options.nextRunAt) : nextCronRun(options.cron, options.timezone);
  if (Number.isNaN(next.getTime())) throw new Error('Invalid schedule next-run time');
  const aligned = new Date(Math.floor(next.getTime() / 60_000) * 60_000);
  if (!cronMatches(fields, aligned, options.timezone)) throw new Error('Schedule next-run time does not match the cron expression');
  return {
    cron: options.cron.trim(),
    timezone: options.timezone,
    nextRunAt: aligned.toISOString(),
    missedRunPolicy,
    concurrencyPolicy,
    lastScheduledSlot: null,
    currentRunSlot: null,
    lastRunAt: null,
  };
}

export function nextScheduleRun(schedule: JobSchedule, after: Date = new Date()): Date {
  return nextCronRun(schedule.cron, schedule.timezone, after);
}

export function bucketStart(time: Date = new Date()): Date {
  return new Date(Math.floor(time.getTime() / SCHEDULE_RESOLUTION_MS) * SCHEDULE_RESOLUTION_MS);
}

export function scheduleBucket(time: Date): string {
  const bucket = bucketStart(time);
  return `${bucket.toISOString().slice(0, 4)}${bucket.toISOString().slice(5, 7)}${bucket.toISOString().slice(8, 10)}T${bucket.toISOString().slice(11, 13)}${bucket.toISOString().slice(14, 16)}Z`;
}

export function runBucketLabel(bucket: string): string {
  if (!/^\d{8}T\d{4}Z$/.test(bucket)) throw new Error(`Invalid schedule bucket: ${bucket}`);
  const hour = Number(bucket.slice(9, 11));
  const minute = Number(bucket.slice(11, 13));
  const slot = hour * 6 + minute / 10;
  return `agents-relay:next-run:${slot}`;
}

export function parseRunBucketLabel(label: string): string | null {
  const prefix = 'agents-relay:next-run:';
  if (!label.startsWith(prefix)) return null;
  const value = label.slice(prefix.length);
  if (!/^\d{1,3}$/.test(value)) return null;
  const slot = Number(value);
  return Number.isInteger(slot) && slot >= 0 && slot < RUN_BUCKET_LABEL_COUNT ? value : null;
}
