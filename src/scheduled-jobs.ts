import { GitHubClient, GitHubStore, loadManagedGitHubPullRequestGraphql } from './store.js';
import { Job } from './types.js';
import { bucketStart, nextScheduleRun, parseRunBucketLabel, runBucketLabel, scheduleBucket } from './scheduler.js';

export const AUTONOMOUS_LABEL = 'agents-relay:autonomous';
export type ScheduledJobRef = { prNumber: number; jobId: string; bucket: string };
export type ScheduledRunStatus = 'completed' | 'skipped-idempotent' | 'skipped-active';
export type ScheduledRunResult = { job: Job; status: ScheduledRunStatus };
export type SchedulerEngine = { reconcile(jobId: string): Promise<unknown>; idle(): Promise<void> };

function repositoryParts(repository: string): { owner: string; name: string } {
  const [owner, name] = repository.split('/', 2);
  if (!owner || !name) throw new Error(`Invalid GitHub repository ${repository}`);
  return { owner, name };
}

function searchPath(query: string): string {
  return `search/issues?q=${encodeURIComponent(query)}&sort=created&order=asc&per_page=100`;
}

export function dueBuckets(now: Date, lookbackBuckets: number): string[] {
  if (!Number.isInteger(lookbackBuckets) || lookbackBuckets < 1 || lookbackBuckets > 36) throw new Error('--lookback-buckets must be an integer from 1 to 36');
  const result: string[] = [];
  for (let age = lookbackBuckets - 1; age >= 0; age -= 1) {
    result.push(scheduleBucket(new Date(bucketStart(now).getTime() - age * 600_000)));
  }
  return result;
}

export function indexedDueQuery(repository: string, bucket: string): string {
  const label = runBucketLabel(bucket);
  return `repo:${repository} is:open is:pr label:"${AUTONOMOUS_LABEL}" label:"${label}"`;
}

async function issueLabels(client: GitHubClient, repository: string, prNumber: number): Promise<string[]> {
  const labels: string[] = [];
  let page = 1;
  for (;;) {
    const response = await client.request(`repos/${repository}/issues/${prNumber}/labels?per_page=100&page=${page}`) as unknown;
    const items = Array.isArray(response) ? response : (response as { items?: unknown }).items;
    if (!Array.isArray(items)) throw new Error(`GitHub label response for PR #${prNumber} was invalid`);
    for (const item of items) {
      const name = (item as { name?: unknown }).name;
      if (typeof name === 'string') labels.push(name);
    }
    if (items.length < 100) return labels;
    page += 1;
  }
}

async function addLabel(client: GitHubClient, repository: string, prNumber: number, label: string): Promise<void> {
  await client.request(`repos/${repository}/issues/${prNumber}/labels`, {
    method: 'POST',
    body: JSON.stringify({ labels: [label] }),
  });
}

async function removeLabel(client: GitHubClient, repository: string, prNumber: number, label: string): Promise<void> {
  await client.request(`repos/${repository}/issues/${prNumber}/labels/${encodeURIComponent(label)}`, { method: 'DELETE' });
}

async function ensureRepositoryLabel(client: GitHubClient, repository: string, label: string, color: string): Promise<void> {
  try {
    await client.request(`repos/${repository}/labels/${encodeURIComponent(label)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/404|Not Found/i.test(message)) throw error;
    await client.request(`repos/${repository}/labels`, {
      method: 'POST',
      body: JSON.stringify({ name: label, color }),
    });
  }
}

export async function syncScheduleLabels(client: GitHubClient, repository: string, job: Job): Promise<void> {
  const current = await issueLabels(client, repository, job.prNumber);
  const target = job.schedule ? runBucketLabel(scheduleBucket(new Date(job.schedule.nextRunAt))) : null;
  const expected = new Set(job.schedule ? [AUTONOMOUS_LABEL, target] : []);
  if (job.schedule || current.includes(AUTONOMOUS_LABEL)) await ensureRepositoryLabel(client, repository, AUTONOMOUS_LABEL, '0E8A16');
  if (target !== null) await ensureRepositoryLabel(client, repository, target, 'D4C5F9');
  for (const label of current) {
    const isSchedulerLabel = label === AUTONOMOUS_LABEL || parseRunBucketLabel(label) !== null || /^agents-relay:next-run:\d{8}T\d{4}Z$/.test(label);
    if (isSchedulerLabel && !expected.has(label)) await removeLabel(client, repository, job.prNumber, label);
  }
  if (job.schedule) {
    if (!current.includes(AUTONOMOUS_LABEL)) await addLabel(client, repository, job.prNumber, AUTONOMOUS_LABEL);
    if (target !== null && !current.includes(target)) await addLabel(client, repository, job.prNumber, target);
  }
}

export async function listIndexedScheduledJobs(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>, buckets: readonly string[]): Promise<ScheduledJobRef[]> {
  const found = new Map<string, ScheduledJobRef>();
  for (const bucket of buckets) {
    const response = await client.request(searchPath(indexedDueQuery(repository, bucket))) as { items?: unknown };
    const items = Array.isArray(response?.items) ? response.items : [];
    for (const item of items) {
      const prNumber = Number((item as { number?: unknown }).number);
      if (!Number.isInteger(prNumber) || prNumber <= 0) continue;
      const overviews = await loadManagedGitHubPullRequestGraphql(client, repository, prNumber, trustedAuthors).catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('has no durable')) return [];
        throw error;
      });
      const job = overviews.find(overview => overview.githubState === 'OPEN' && overview.job.schedule !== undefined)?.job;
      if (!job?.schedule) continue;
      const slotBucket = scheduleBucket(new Date(job.schedule.nextRunAt));
      if (!buckets.includes(slotBucket)) continue;
      const key = `${prNumber}:${job.id}`;
      if (!found.has(key)) found.set(key, { prNumber, jobId: job.id, bucket: slotBucket });
    }
  }
  return [...found.values()];
}

async function refresh(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>, ref: ScheduledJobRef): Promise<Job> {
  const store = new GitHubStore(client, repository, ref.prNumber, trustedAuthors);
  return await store.load(ref.jobId);
}

export async function runScheduledBucket(client: GitHubClient, repository: string, trustedAuthors: ReadonlySet<string>, ref: ScheduledJobRef, engine: SchedulerEngine, now: Date = new Date()): Promise<ScheduledRunResult> {
  let job = await refresh(client, repository, trustedAuthors, ref);
  const schedule = job.schedule;
  if (!schedule) throw new Error(`Scheduled job ${job.id} has no schedule metadata`);
  const slot = new Date(schedule.nextRunAt);
  if (scheduleBucket(slot) !== ref.bucket || slot.getTime() > now.getTime()) {
    await syncScheduleLabels(client, repository, job);
    return { job, status: 'skipped-idempotent' };
  }
  if (schedule.lastScheduledSlot && new Date(schedule.lastScheduledSlot).getTime() >= slot.getTime()) {
    await syncScheduleLabels(client, repository, job);
    return { job, status: 'skipped-idempotent' };
  }

  const active = job.state === 'RUNNING' || job.tasks.some(task => ['READY', 'RUNNING'].includes(task.state));
  if (active && schedule.concurrencyPolicy === 'skip') {
    schedule.lastScheduledSlot = slot.toISOString();
    schedule.nextRunAt = nextScheduleRun(schedule, now).toISOString();
    job.updatedAt = now.toISOString();
    await new GitHubStore(client, repository, ref.prNumber, trustedAuthors).saveJob(job);
    await syncScheduleLabels(client, repository, job);
    return { job, status: 'skipped-active' };
  }
  if (active && schedule.concurrencyPolicy === 'queue') {
    await syncScheduleLabels(client, repository, job);
    return { job, status: 'skipped-active' };
  }

  const missedRunPolicy = schedule.missedRunPolicy;
  schedule.lastScheduledSlot = slot.toISOString();
  schedule.nextRunAt = nextScheduleRun(schedule, missedRunPolicy === 'run' ? slot : now).toISOString();
  job.updatedAt = now.toISOString();
  const schedulerStore = new GitHubStore(client, repository, ref.prNumber, trustedAuthors);
  await schedulerStore.saveJob(job);
  if (job.state !== 'RUNNING') {
    const saved = await schedulerStore.load(job.id);
    saved.schedule = saved.schedule ? { ...saved.schedule, nextRunAt: schedule.nextRunAt, lastScheduledSlot: schedule.lastScheduledSlot } : schedule;
    saved.state = 'RUNNING';
    saved.updatedAt = now.toISOString();
    await schedulerStore.saveJob(saved);
  }
  job = await schedulerStore.load(job.id);
  await syncScheduleLabels(client, repository, job);
  await engine.reconcile(job.id);
  await engine.idle();

  const finished = await schedulerStore.load(job.id);
  if (!finished.schedule) throw new Error(`Scheduled job ${job.id} lost its schedule metadata`);
  finished.schedule.lastRunAt = now.toISOString();
  finished.updatedAt = now.toISOString();
  await schedulerStore.saveJob(finished);
  return { job: finished, status: 'completed' };
}

export async function processDueScheduledJobs(options: {
  client: GitHubClient;
  repository: string;
  trustedAuthors: ReadonlySet<string>;
  buckets: readonly string[];
  now: Date;
  engine: (job: Job) => SchedulerEngine;
}): Promise<ScheduledRunResult[]> {
  const due = await listIndexedScheduledJobs(options.client, options.repository, options.trustedAuthors, options.buckets);
  const results: ScheduledRunResult[] = [];
  for (const ref of due) {
    const engine = options.engine(await refresh(options.client, options.repository, options.trustedAuthors, ref));
    results.push(await runScheduledBucket(options.client, options.repository, options.trustedAuthors, ref, engine, options.now));
  }
  return results;
}
