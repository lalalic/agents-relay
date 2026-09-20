import { randomUUID } from 'node:crypto';
import { EventRecord } from './types.js';
import type { NatsConnection, Subscription } from 'nats';
type NatsModule = typeof import('nats');

export interface EventBus { publish(event: EventRecord): Promise<void>; subscribe(jobId: string, wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>>; subscribeAll(wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>>; }
export function subjectToken(value: string): string { if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`Unsafe event subject token: ${value}`); return value; }
export class MemoryEventBus implements EventBus {
  private readonly handlers = new Map<string, Set<(event: EventRecord) => Promise<void>>>();
  async publish(event: EventRecord): Promise<void> { for (const handler of [...(this.handlers.get(event.job_id) ?? []), ...(this.handlers.get('*') ?? [])]) await handler(event); }
  async subscribe(jobId: string, wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> { const set = this.handlers.get(jobId) ?? new Set(); set.add(wake); this.handlers.set(jobId, set); return async () => { set.delete(wake); }; }
  async subscribeAll(wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> { const key = '*'; const set = this.handlers.get(key) ?? new Set(); set.add(wake); this.handlers.set(key, set); return async () => { set.delete(wake); }; }
}
export class NatsEventBus implements EventBus {
  private connection: NatsConnection | null = null;
  private module: NatsModule | null = null;
  constructor(private readonly url = 'nats://127.0.0.1:4222', private readonly subjectPrefix = 'neo.events.job') { if (!/^[A-Za-z0-9_.-]+$/.test(subjectPrefix)) throw new Error(`Unsafe event subject prefix: ${subjectPrefix}`); }
  private async moduleLoaded(): Promise<NatsModule> { this.module ??= await import('nats'); return this.module; }
  private async client(): Promise<NatsConnection> { const nats = await this.moduleLoaded(); this.connection ??= await nats.connect({ servers: this.url }); return this.connection; }
  async publish(event: EventRecord): Promise<void> { const nats = await this.moduleLoaded(); const subject = `${this.subjectPrefix}.${subjectToken(event.job_id)}.${event.type}`; (await this.client()).publish(subject, nats.StringCodec().encode(JSON.stringify(event))); }
  async subscribe(jobId: string, wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> { return this.subscribeSubject(`${this.subjectPrefix}.${subjectToken(jobId)}.>`, wake); }
  async subscribeAll(wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> { return this.subscribeSubject(`${this.subjectPrefix}.>`, wake); }
  private async subscribeSubject(subject: string, wake: (event: EventRecord) => Promise<void>): Promise<() => Promise<void>> {
    const nats = await this.moduleLoaded();
    const codec = nats.StringCodec();
    const subscription: Subscription = (await this.client()).subscribe(subject);
    let active = true;
    void (async () => {
      for await (const message of subscription) {
        if (!active) break;
        let event: EventRecord;
        try {
          event = JSON.parse(codec.decode(message.data)) as EventRecord;
        } catch {
          continue;
        }
        try {
          await wake(event);
        } catch (error) {
          process.stderr.write(`warning: event handler failed for ${subject}: ${error instanceof Error ? error.message : String(error)}\n`);
        }
      }
    })();
    return async () => { active = false; subscription.unsubscribe(); };
  }
}
export function eventFor(jobId: string, taskId: string, parentTaskId: string | null, type: string, status: string, message: string, visibility: string = 'orchestrator', data?: Record<string, unknown>, source?: Record<string, unknown>): EventRecord { return { version: 1, event_id: randomUUID(), job_id: jobId, task_id: taskId, parent_task_id: parentTaskId, type, status, timestamp: new Date().toISOString(), visibility, level: status === 'failed' || status === 'blocked' ? 'error' : 'info', message, data, source }; }
