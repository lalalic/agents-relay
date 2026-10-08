import { Job, JobSchedule, MissedRunPolicy, ScheduleConcurrencyPolicy, Task } from './types.js';
import { implementationTasks } from './runtime-status.js';
import { WorkflowContext } from './workflow/mermaid.js';
import { dispatchJobLifecycle, dispatchTaskLifecycle, dispatchTaskLifecycleSync, type WorkflowDecision } from './workflow/lifecycle.js';
import { dependencyReady, detectCycles, reconcileTaskDependencies } from './workflow/task-reconcile.js';
export { dependencyReady, detectCycles } from './workflow/task-reconcile.js';
import { dispatchScheduleCycle } from './workflow/schedule-cycle-v2.js';
import { observability } from './observability.js';
export function completionGateSatisfied(job: Job): boolean {
  if (job.schedule) return false;
  if (job.executionMode !== 'autonomous') return true;
  const latest = [...(job.plans ?? [])].sort((a, b) => a.round - b.round).at(-1);
  const previousReviewFinished = job.tasks.some(task => task.agentName === 'reviewer' && task.state === 'SUCCEEDED');
  const planSatisfied = latest?.status === 'SUCCEEDED' && (latest.objectiveStatus === 'satisfied'
    || (latest.objectiveStatus === 'in_progress' && latest.plannerResult?.next_tasks?.length === 0 && previousReviewFinished));
  const legacySatisfied = (job.plans?.length ?? 0) === 0 && job.tasks.some(task => task.kind === 'planner' && task.state === 'SUCCEEDED' && task.plannerResult?.objective_status === 'satisfied');
  return (planSatisfied || legacySatisfied) && implementationTasks(job).every(task => task.state === 'SUCCEEDED');
}
export function schedule(job: Job): Job {
  reconcileTaskDependencies(job);
  const scopedTasks = job.schedule?.currentRunSlot
    ? job.tasks.filter(task => Date.parse(task.createdAt) >= Date.parse(job.schedule?.currentRunSlot ?? ''))
    : job.tasks;
  if (job.schedule) {
    const slot = Date.parse(job.schedule.currentRunSlot ?? '');
    const scopedPlans = (job.plans ?? []).filter(plan => !Number.isFinite(slot) || Date.parse(plan.createdAt) >= slot).sort((a, b) => a.round - b.round || a.createdAt.localeCompare(b.createdAt));
    const latestPlan = scopedPlans.at(-1);
    const legacyLatest = scopedPlans.length === 0 ? scopedTasks.filter(task => task.kind === 'planner').sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).at(-1) : undefined;
    dispatchScheduleCycle({
      hasCurrentSlot: Boolean(job.schedule.currentRunSlot),
      plannerSatisfied: latestPlan ? latestPlan.status === 'SUCCEEDED' && latestPlan.objectiveStatus === 'satisfied' : legacyLatest?.state === 'SUCCEEDED' && legacyLatest.plannerResult?.objective_status === 'satisfied',
    }, () => {
      const slot = job.schedule!.currentRunSlot ? Date.parse(job.schedule!.currentRunSlot) : Number.NaN;
      const lastRun = job.schedule!.lastRunAt ? Date.parse(job.schedule!.lastRunAt) : Number.NaN;
      if (Number.isFinite(slot) && (!Number.isFinite(lastRun) || lastRun < slot)) job.schedule!.lastRunAt = new Date().toISOString();
      job.schedule!.currentRunSlot = null;
      job.updatedAt = new Date().toISOString();
    });
  }
  return job;
}
export function extendRetryBudget(task: Pick<Task, 'attempt' | 'maxAttempts'>, windowSize = 3): number {
  if (!Number.isInteger(windowSize) || windowSize < 1) throw new Error('Retry window size must be a positive integer');
  const usedOrBudgeted = Math.max(task.maxAttempts, task.attempt);
  return Math.max(windowSize, (Math.floor(usedOrBudgeted / windowSize) + 1) * windowSize);
}
export function tryTransitionTaskEvent(task: Task, event: string, context: WorkflowContext = {}): WorkflowDecision<Task['state']> {
  return dispatchTaskLifecycleSync(task as Task & Record<string, unknown>, event, context);
}
export async function transitionTaskEvent(task: Task, event: string, context: WorkflowContext = {}, executeEffect?: (actionId:string)=>void|Promise<void>, persist?:()=>void|Promise<void>): Promise<WorkflowDecision<Task['state']>> {
  const from = task.state;
  const decision = await dispatchTaskLifecycle(task as Task & Record<string, unknown>, event, context, executeEffect, persist);
  if (!decision.accepted || !decision.target) throw new Error(decision.reason === 'ambiguous'
    ? `Ambiguous workflow transition from ${from} on ${event}`
    : `No enabled workflow transition from ${from} on ${event}`);
  observability().record({
    stage: 'transition',
    event,
    outcome: 'succeeded',
    message: `Task ${task.id} ${from} -> ${decision.target}`,
    correlation: { jobId: task.jobId, taskId: task.id, executionId: task.executionId ?? undefined },
    transition: { graph: 'task-lifecycle', from, to: decision.target, actions: decision.actions },
  });
  return decision;
}
export async function transitionJobEvent(job: Job, event: string, context: WorkflowContext = {}, executeEffect?: (actionId:string)=>void|Promise<void>, persist?:()=>void|Promise<void>): Promise<WorkflowDecision<Job['state']>> {
  const from = job.state;
  const decision = await dispatchJobLifecycle(job, event, context, executeEffect, persist);
  if (!decision.accepted || !decision.target) throw new Error(decision.reason === 'ambiguous'
    ? `Ambiguous workflow transition from ${from} on ${event}`
    : `No enabled workflow transition from ${from} on ${event}`);
  observability().record({
    stage: 'transition',
    event,
    outcome: 'succeeded',
    message: `Job ${job.id} ${from} -> ${decision.target}`,
    correlation: { repository: job.repository, prNumber: job.prNumber, jobId: job.id },
    transition: { graph: 'job-lifecycle', from, to: decision.target, actions: decision.actions },
  });
  return decision;
}

export const SCHEDULE_RESOLUTION_MS = 600_000;
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
