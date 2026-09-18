import { Job, Task } from './types.js';
import { spawn } from 'node:child_process';
import { parseJob, parseTask, renderJobComment, renderTaskComment, JOB_MARKER, TASK_MARKER } from './markers.js';
export type Comment = { id: number; body: string; updatedAt: string; authorLogin: string | null };
export interface DurableStore { load(jobId: string): Promise<Job>; saveJob(job: Job): Promise<void>; appendTask(task: Task): Promise<void>; saveTask(task: Task): Promise<void>; comments(): Promise<Comment[]>; }
export class InMemoryStore implements DurableStore {
  private readonly values = new Map<string, string>();
  constructor(job?: Job) {
    if (job) {
      this.values.set(`${JOB_MARKER}:${job.id}`, renderJobComment(job));
      for (const task of job.tasks) this.values.set(`${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`, renderTaskComment(task));
    }
  }
  async load(jobId: string): Promise<Job> { const job = await this.findJob(jobId); if (!job) throw new Error(`Job ${jobId} not found`); job.tasks = this.tasksForJob(jobId); return job; }
  async saveJob(job: Job): Promise<void> { this.values.set(`${JOB_MARKER}:${job.id}`, renderJobComment(job)); }
  async appendTask(task: Task): Promise<void> {
    const key = `${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`;
    if (this.values.has(key)) throw new Error(`Task ${task.id} already exists in this PR`);
    this.values.set(key, renderTaskComment(task));
  }
  async saveTask(task: Task): Promise<void> { this.values.set(`${TASK_MARKER}:${task.jobId ?? ''}:${task.id}`, renderTaskComment(task)); }
  async comments(): Promise<Comment[]> { return [...this.values.values()].map((body, i) => ({ id: i + 1, body, updatedAt: new Date().toISOString(), authorLogin: 'local' })); }
  private findJob(jobId: string): Job | null { return [...this.values.values()].map(parseJob).find((x): x is Job => x !== null && x.id === jobId) ?? null; }
  private tasksForJob(jobId: string): Task[] {
    const jobs = [...this.values.values()].map(parseJob).filter((x): x is Job => x !== null && typeof x.id === 'string' && x.id.length > 0);
    return [...this.values.values()].map(parseTask).filter((x): x is Task => x !== null).filter(task => isTaskForJob(task, jobId, jobs.length === 1));
  }
}
export type GitHubClient = { request(path: string, init?: RequestInit): Promise<unknown> };
export class GhApiClient implements GitHubClient {
  async request(path: string, init: RequestInit = {}): Promise<unknown> { const args = ['api', path]; const method = String(init.method ?? 'GET'); if (method !== 'GET') args.push('--method', method); if (init.body) args.push('--input', '-'); return new Promise<unknown>((resolve, reject) => { const child = spawn('gh', args); let stdout = ''; let stderr = ''; child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); }); child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); }); child.on('error', reject); if (init.body) child.stdin.write(String(init.body)); child.stdin.end(); child.on('close', code => { if (code !== 0) { reject(new Error(stderr.trim() || `gh api exited ${code}`)); return; } if (stdout.trim()) { try { resolve(JSON.parse(stdout) as unknown); } catch { resolve(stdout); } } else resolve(null); }); }); }
  async currentLogin(): Promise<string> { const value = await this.request('/user') as Record<string, unknown>; if (typeof value.login !== 'string' || value.login.length === 0) throw new Error('gh authentication did not return a login'); return value.login; }
}
export class GitHubStore implements DurableStore {
  constructor(private readonly client: GitHubClient, private readonly repository: string, private readonly prNumber: number, private readonly trustedAuthors: ReadonlySet<string> = new Set()) {}
  private isTrusted(comment: Comment): boolean { return comment.authorLogin !== null && this.trustedAuthors.has(comment.authorLogin); }
  private async list(): Promise<Comment[]> { const all: Comment[] = []; for (let page = 1; page <= 100; page += 1) { const data = await this.client.request(`/repos/${this.repository}/issues/${this.prNumber}/comments?per_page=100&page=${page}`); if (!Array.isArray(data)) throw new Error('GitHub comments response was not an array'); const values = data.map((x: unknown) => { const v = x as Record<string, unknown>; const user = v.user as Record<string, unknown> | null | undefined; return { id: Number(v.id), body: String(v.body ?? ''), updatedAt: String(v.updated_at ?? ''), authorLogin: typeof user?.login === 'string' ? user.login : null }; }); all.push(...values); if (values.length < 100) break; } return all; }
  async comments(): Promise<Comment[]> { return this.list(); }
  async load(jobId: string): Promise<Job> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const jobs = comments.map(x => parseJob(x.body)).filter((x): x is Job => x !== null && typeof x.id === 'string' && x.id.length > 0);
    const job = jobs.find(x => x.id === jobId);
    if (!job) throw new Error(`Job ${jobId} not found in PR`);
    const soleTrustedJob = jobs.length === 1;
    job.tasks = comments.map(x => parseTask(x.body)).filter((x): x is Task => x !== null).filter(task => isTaskForJob(task, jobId, soleTrustedJob));
    return job;
  }
  private async comment(body: string): Promise<void> { await this.client.request(`/repos/${this.repository}/issues/${this.prNumber}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }); }
  async saveJob(job: Job): Promise<void> { const comments = (await this.list()).filter(comment => this.isTrusted(comment)); const existing = comments.find(x => parseJob(x.body)?.id === job.id); if (existing) await this.client.request(`/repos/${this.repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderJobComment(job) }) }); else await this.comment(renderJobComment(job)); }
  async appendTask(task: Task): Promise<void> { await this.comment(renderTaskComment(task)); }
  async saveTask(task: Task): Promise<void> {
    const comments = (await this.list()).filter(comment => this.isTrusted(comment));
    const existing = comments.find(comment => { const markerTask = parseTask(comment.body); return markerTask !== null && markerTask.jobId === task.jobId && markerTask.id === task.id; });
    if (existing) await this.client.request(`/repos/${this.repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderTaskComment(task) }) });
    else await this.appendTask(task);
  }
}

function isTaskForJob(task: Task, jobId: string, soleTrustedJob: boolean): boolean {
  if (task.jobId === jobId) return true;
  return !task.jobId && soleTrustedJob;
}
