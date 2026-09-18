import { Job, Task } from './types.js';
import { parseJob, parseTask, renderJobComment, renderTaskComment, JOB_MARKER, TASK_MARKER } from './markers.js';
export type Comment = { id: number; body: string; updatedAt: string };
export interface DurableStore { load(jobId: string): Promise<Job>; saveJob(job: Job): Promise<void>; appendTask(task: Task): Promise<void>; saveTask(task: Task): Promise<void>; comments(): Promise<Comment[]>; }
export class InMemoryStore implements DurableStore {
  private readonly values = new Map<string, string>();
  constructor(job?: Job) { if (job) { this.values.set(JOB_MARKER, renderJobComment(job)); for (const task of job.tasks) this.values.set(`${TASK_MARKER}:${task.id}`, renderTaskComment(task)); } }
  async load(jobId: string): Promise<Job> { const job = parseJob(this.values.get(JOB_MARKER) ?? ''); if (!job || job.id !== jobId) throw new Error(`Job ${jobId} not found`); job.tasks = [...this.values.values()].map(parseTask).filter((x): x is Task => x !== null); return job; }
  async saveJob(job: Job): Promise<void> { this.values.set(JOB_MARKER, renderJobComment(job)); }
  async appendTask(task: Task): Promise<void> { this.values.set(`${TASK_MARKER}:${task.id}`, renderTaskComment(task)); }
  async saveTask(task: Task): Promise<void> { await this.appendTask(task); }
  async comments(): Promise<Comment[]> { return [...this.values.values()].map((body, i) => ({ id: i + 1, body, updatedAt: new Date().toISOString() })); }
}
export type GitHubClient = { request(path: string, init?: RequestInit): Promise<unknown> };
export class GitHubStore implements DurableStore {
  constructor(private readonly client: GitHubClient, private readonly repository: string, private readonly prNumber: number) {}
  private async list(): Promise<Comment[]> { const data = await this.client.request(`/repos/${this.repository}/issues/${this.prNumber}/comments`); if (!Array.isArray(data)) throw new Error('GitHub comments response was not an array'); return data.map((x: unknown) => { const v = x as Record<string, unknown>; return { id: Number(v.id), body: String(v.body ?? ''), updatedAt: String(v.updated_at ?? '') }; }); }
  async comments(): Promise<Comment[]> { return this.list(); }
  async load(jobId: string): Promise<Job> { const comments = await this.list(); const job = comments.map(x => parseJob(x.body)).find((x): x is Job => x !== null && x.id === jobId); if (!job) throw new Error(`Job ${jobId} not found in PR`); job.tasks = comments.map(x => parseTask(x.body)).filter((x): x is Task => x !== null); return job; }
  private async comment(body: string): Promise<void> { await this.client.request(`/repos/${this.repository}/issues/${this.prNumber}/comments`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body }) }); }
  async saveJob(job: Job): Promise<void> { const comments = await this.list(); const existing = comments.find(x => parseJob(x.body)?.id === job.id); if (existing) await this.client.request(`/repos/${this.repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderJobComment(job) }) }); else await this.comment(renderJobComment(job)); }
  async appendTask(task: Task): Promise<void> { await this.comment(renderTaskComment(task)); }
  async saveTask(task: Task): Promise<void> { const comments = await this.list(); const existing = comments.find(x => parseTask(x.body)?.id === task.id); if (existing) await this.client.request(`/repos/${this.repository}/issues/comments/${existing.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: renderTaskComment(task) }) }); else await this.appendTask(task); }
}
