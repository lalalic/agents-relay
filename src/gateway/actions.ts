import { randomUUID } from 'node:crypto';
import { eventFor } from '../events.js';
import { GitHubStore } from '../store.js';
import { Job, Task } from '../types.js';
import { GatewayConfig, GatewayProject, findProject, projectForJobId } from './config.js';
import { EventSink } from './events.js';
import { GitHubGatewayClient, GitHubRequestError, GitHubUnavailableError, isConflict } from './github.js';
import {
  PullSummary,
  addLabel,
  branchNameFor,
  createDraftPull,
  createEmptyCommitBranch,
  findPull,
  readJobOrNull,
  resolveAnchor,
  storeFor,
} from './anchor.js';
import { CapacityError, JobSupervisor, isTerminalJobState } from './supervisor.js';
import {
  GatewayErrorCode,
  ValidatedCreateJobRequest,
  composeTaskInput,
  composeTitle,
  jobIdFor,
  keyFingerprintFor,
  parseCreateJobRequest,
  requestFingerprint,
} from './schema.js';

const POLL_AFTER_MS = 5000;
const CAPACITY_RETRY_MS = 30000;

export class GatewayError extends Error {
  readonly status: number;
  readonly code: GatewayErrorCode;
  readonly retryable: boolean;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: GatewayErrorCode, message: string, retryable: boolean, extra?: Record<string, unknown>) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.extra = extra;
  }
}

export type ActionOutcome = { status: number; body: Record<string, unknown> };
export type GatewayActions = { createJob(body: unknown): Promise<ActionOutcome>; getJob(jobId: string): Promise<ActionOutcome> };

export type ActionDeps = {
  config: GatewayConfig;
  client: GitHubGatewayClient;
  supervisor: JobSupervisor;
  events: EventSink;
  now?: () => Date;
};

export function createActions(deps: ActionDeps): GatewayActions {
  return {
    createJob: (body: unknown) => createJob(deps, body),
    getJob: (jobId: string) => getJob(deps, jobId),
  };
}

type AnchorTarget = { prNumber: number; branch: string; store: GitHubStore; pull: PullSummary | null };
type ResolvedAnchor = ({ kind: 'job'; job: Job } | { kind: 'anchor' }) & AnchorTarget;

async function createJob(deps: ActionDeps, body: unknown): Promise<ActionOutcome> {
  const parsed = parseCreateJobRequest(body);
  if (!parsed.ok) throw new GatewayError(400, parsed.code, parsed.message, false);
  const request = parsed.value;
  const project = findProject(deps.config, request.project);
  if (!project) throw new GatewayError(400, 'unknown_project', `No gateway project is configured for "${request.project}"`, false);
  const fingerprint = requestFingerprint(request);
  const jobId = jobIdFor(project.name, request.idempotencyKey);

  const existing = await resolveExisting(deps, project, jobId);
  if (existing) return settle(deps, project, request, jobId, fingerprint, existing);

  if (deps.supervisor.atCapacity()) {
    throw new GatewayError(429, 'capacity_exceeded', `Active job limit of ${deps.config.maxActiveJobs} is reached`, true, { retry_after_ms: CAPACITY_RETRY_MS });
  }

  let anchor: ResolvedAnchor;
  try {
    const created = await createAnchor(deps, project, jobId, composeTitle(request.intent));
    anchor = { kind: 'anchor', ...created };
  } catch (error) {
    if (isConflict(error)) {
      const raced = await resolveExisting(deps, project, jobId);
      if (raced) return settle(deps, project, request, jobId, fingerprint, raced);
    }
    await deps.events.publish(eventFor(jobId, 'job', null, 'job.create.failed', 'failed', `Job ${jobId} anchor failed: ${messageOf(error)}`, 'user'));
    throw toGatewayError(error);
  }
  return settle(deps, project, request, jobId, fingerprint, anchor);
}

function settle(deps: ActionDeps, project: GatewayProject, request: ValidatedCreateJobRequest, jobId: string, fingerprint: string, anchor: ResolvedAnchor): Promise<ActionOutcome> | ActionOutcome {
  if (anchor.kind === 'anchor') return persistNewJob(deps, project, request, jobId, fingerprint, anchor);

  const { job } = anchor;
  if (job.requestFingerprint !== fingerprint) {
    const taskId = job.tasks[0]?.id ?? 'job';
    void deps.events.publish(eventFor(jobId, taskId, null, 'job.idempotency.conflict', 'failed', `Idempotency key reused for ${jobId} with a different request`, 'orchestrator'));
    throw new GatewayError(409, 'idempotency_conflict', `Idempotency key is already used by ${jobId} with a different request`, false);
  }
  return reuseExistingJob(deps, project, request, jobId, fingerprint, anchor);
}

async function reuseExistingJob(deps: ActionDeps, project: GatewayProject, request: ValidatedCreateJobRequest, jobId: string, fingerprint: string, anchor: Extract<ResolvedAnchor, { kind: 'job' }>): Promise<ActionOutcome> {
  let job = anchor.job;
  if (job.tasks.length === 0) {
    // The durable job marker exists but the initial task marker does not: finish the anchor writes.
    const task = buildInitialTask(project, request, jobId, job.createdAt);
    await anchor.store.saveTask(task);
    job = (await readJobOrNull(anchor.store, jobId)) ?? { ...job, tasks: [task] };
  }
  if (!isTerminalJobState(job.state) && !deps.supervisor.has(jobId)) {
    try {
      await deps.supervisor.ensure(project, jobId, anchor.prNumber, job.state);
    } catch (error) {
      if (!(error instanceof CapacityError)) throw error;
    }
  }
  await deps.events.publish(eventFor(jobId, job.tasks[0]?.id ?? 'job', null, 'job.reused', 'queued', `Job ${jobId} reused for an identical request`, 'orchestrator'));
  return { status: 200, body: createResponse(deps.config, project, job, anchor.prNumber, anchor.branch, anchor.pull, fingerprint, false, false) };
}

async function persistNewJob(deps: ActionDeps, project: GatewayProject, request: ValidatedCreateJobRequest, jobId: string, fingerprint: string, anchor: Extract<ResolvedAnchor, { kind: 'anchor' }>): Promise<ActionOutcome> {
  const now = isoNow(deps);
  const job = buildJob(project, request, jobId, fingerprint, anchor.prNumber, now);
  const task = buildInitialTask(project, request, jobId, now);
  try {
    await anchor.store.saveJob(job);
    await anchor.store.appendTask(task);
  } catch (error) {
    await deps.events.publish(eventFor(jobId, task.id, null, 'job.create.failed', 'failed', `Job ${jobId} marker write failed: ${messageOf(error)}`, 'user'));
    throw toGatewayError(error);
  }
  await deps.events.publish(eventFor(jobId, task.id, null, 'job.created', 'queued', `Job ${jobId} created`, 'orchestrator', { project: project.name, pr_number: anchor.prNumber }));
  try {
    await deps.supervisor.ensure(project, jobId, anchor.prNumber, job.state);
  } catch (error) {
    if (!(error instanceof CapacityError)) throw error;
  }
  const reconciled = await deps.supervisor.reconcileBounded(jobId, deps.config.createTimeoutMs);
  const durable = (await readJobOrNull(anchor.store, jobId)) ?? job;
  return { status: 201, body: createResponse(deps.config, project, durable, anchor.prNumber, anchor.branch, anchor.pull, fingerprint, true, reconciled) };
}

async function createAnchor(deps: ActionDeps, project: GatewayProject, jobId: string, title: string): Promise<AnchorTarget> {
  await createEmptyCommitBranch(deps.client, project, jobId);
  const branch = branchNameFor(project, jobId);
  const pull = await createDraftPull(deps.client, project, branch, jobId, title);
  await addLabel(deps.client, project.repository, pull.number, project.label);
  return { prNumber: pull.number, branch, store: storeFor(deps.client, project, pull.number), pull };
}

/** Supervisor cache first, then the durable anchor on the derived branch. */
async function resolveExisting(deps: ActionDeps, project: GatewayProject, jobId: string): Promise<ResolvedAnchor | null> {
  const cached = deps.supervisor.get(jobId);
  if (cached) {
    deps.supervisor.touch(jobId);
    const job = await readJobOrNull(cached.store, jobId);
    if (job) return { kind: 'job', job, prNumber: cached.prNumber, branch: branchNameFor(project, jobId), store: cached.store, pull: null };
  }
  const anchor = await resolveAnchor(deps.client, project, jobId);
  if (!anchor) return null;
  const pull = anchor.pull ?? (await findPull(deps.client, project.repository, anchor.branch, 'all'));
  if (!pull) return null;
  const store = storeFor(deps.client, project, pull.number);
  const job = await readJobOrNull(store, jobId);
  return job
    ? { kind: 'job', job, prNumber: pull.number, branch: anchor.branch, store, pull }
    : { kind: 'anchor', prNumber: pull.number, branch: anchor.branch, store, pull };
}

async function getJob(deps: ActionDeps, jobId: string): Promise<ActionOutcome> {
  const project = projectForJobId(deps.config, jobId);
  if (!project) throw new GatewayError(404, 'not_found', `Unknown job ${jobId}`, false);
  const anchor = await resolveAnchor(deps.client, project, jobId);
  if (!anchor) throw new GatewayError(404, 'not_found', `No anchor pull request for ${jobId}`, false);
  const pull = anchor.pull ?? (await findPull(deps.client, project.repository, anchor.branch, 'all'));
  if (!pull) throw new GatewayError(404, 'not_found', `No anchor pull request for ${jobId}`, false);
  const job = await readJobOrNull(storeFor(deps.client, project, pull.number), jobId);
  if (!job) throw new GatewayError(404, 'not_found', `Job ${jobId} has no durable marker`, false);
  return { status: 200, body: readResponse(deps.config, project, job, pull.number, anchor.branch, pull) };
}

function buildJob(project: GatewayProject, request: ValidatedCreateJobRequest, jobId: string, fingerprint: string, prNumber: number, now: string): Job {
  const createdBy: NonNullable<Job['createdBy']> = { kind: 'gateway', keyFingerprint: keyFingerprintFor(project.name, request.idempotencyKey) };
  if (request.agent?.name) createdBy.agentName = request.agent.name;
  const job: Job = {
    id: jobId,
    title: composeTitle(request.intent),
    prNumber,
    repository: project.repository,
    state: 'OPEN',
    continuation: null,
    createdAt: now,
    updatedAt: now,
    tasks: [],
    project: project.name,
    requirements: [...request.requirements],
    requestFingerprint: fingerprint,
    createdBy,
  };
  if (request.parent?.jobId) job.parentJobId = request.parent.jobId;
  if (request.parent?.taskId) job.parentTaskId = request.parent.taskId;
  return job;
}

function buildInitialTask(project: GatewayProject, request: ValidatedCreateJobRequest, jobId: string, now: string): Task {
  const task: Task = {
    jobId,
    id: randomUUID(),
    projectName: project.name,
    parentTaskId: null,
    dependencies: [],
    capabilities: [...project.capabilities],
    adapter: project.adapter,
    input: composeTaskInput(request),
    routing: { ...project.routing, cwd: project.localPath, decidedBy: 'gateway-config', decidedAt: now },
    continuation: null,
    continuationDeliveredAt: null,
    state: 'QUEUED',
    attempt: 0,
    maxAttempts: project.maxAttempts,
    leaseOwner: null,
    leaseExpiresAt: null,
    executionId: null,
    threadId: null,
    result: null,
    error: null,
    timeoutMs: project.timeoutMs,
    createdAt: now,
    updatedAt: now,
  };
  if (request.agent?.name) task.agentName = request.agent.name;
  return task;
}

function prUrlFor(project: GatewayProject, prNumber: number, pull: PullSummary | null): string {
  return pull && pull.url ? pull.url : `https://github.com/${project.repository}/pull/${prNumber}`;
}

function linksFor(config: GatewayConfig, project: GatewayProject, jobId: string, prUrl: string): Record<string, string> {
  const self = config.publicBaseUrl ? `${config.publicBaseUrl}/v1/jobs/${encodeURIComponent(jobId)}` : `/v1/jobs/${encodeURIComponent(jobId)}`;
  const links: Record<string, string> = { self, status: self, pr: prUrl };
  if (project.dashboardUrl) links.dashboard = project.dashboardUrl;
  return links;
}

function createResponse(config: GatewayConfig, project: GatewayProject, job: Job, prNumber: number, branch: string, pull: PullSummary | null, fingerprint: string, created: boolean, reconciled: boolean): Record<string, unknown> {
  const prUrl = prUrlFor(project, prNumber, pull);
  return {
    job_id: job.id,
    state: job.state,
    project: project.name,
    created,
    reconciled,
    request_fingerprint: fingerprint,
    task_id: job.tasks[0]?.id ?? null,
    title: job.title,
    pr: { repository: project.repository, number: prNumber, branch, url: prUrl },
    links: linksFor(config, project, job.id, prUrl),
    poll_after_ms: POLL_AFTER_MS,
  };
}

function readResponse(config: GatewayConfig, project: GatewayProject, job: Job, prNumber: number, branch: string, pull: PullSummary): Record<string, unknown> {
  const prUrl = prUrlFor(project, prNumber, pull);
  return {
    job_id: job.id,
    project: job.project ?? project.name,
    state: job.state,
    terminal: isTerminalJobState(job.state),
    updated_at: job.updatedAt,
    closed: pull.state !== 'open' || pull.merged,
    title: job.title,
    request_fingerprint: job.requestFingerprint ?? null,
    lineage: lineageOf(job),
    pr: { repository: job.repository, number: prNumber, branch, url: prUrl },
    tasks: job.tasks.map(summarizeTask),
    links: linksFor(config, project, job.id, prUrl),
  };
}

/** Bounded, non-secret view: never `input`, `context`, `routing`, `continuation`, or credentials. */
function summarizeTask(task: Task): Record<string, unknown> {
  return {
    task_id: task.id,
    state: task.state,
    attempt: task.attempt,
    adapter: task.adapter,
    result_summary: task.result?.summary ?? null,
    error: task.error,
    thread_id: task.threadId,
    updated_at: task.updatedAt,
  };
}

function lineageOf(job: Job): Record<string, unknown> | null {
  const agent = job.createdBy?.kind === 'gateway' ? job.createdBy.agentName ?? null : null;
  if (!job.parentJobId && !job.parentTaskId && agent === null) return null;
  return { parent_job_id: job.parentJobId ?? null, parent_task_id: job.parentTaskId ?? null, agent };
}

function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof GitHubRequestError || error instanceof GitHubUnavailableError) {
    return new GatewayError(502, 'github_unavailable', error.message, true);
  }
  return new GatewayError(500, 'internal', messageOf(error), true);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isoNow(deps: ActionDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString();
}
