import type { EventRecord } from './types.js';

export type ReconcileSignal = {
  jobId: string;
  reason: string;
  event?: EventRecord;
  repository?: string;
  prNumber?: number;
};

type PendingSignal = {
  signal: ReconcileSignal;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type Mailbox = {
  pending: PendingSignal[];
  running: boolean;
  scheduled: boolean;
};

export class ReconcileCoordinator {
  private readonly mailboxes = new Map<string, Mailbox>();
  private readonly idleWaiters: Array<() => void> = [];

  constructor(
    private readonly consumeBatch: (jobId: string, signals: readonly ReconcileSignal[]) => Promise<void>,
    private readonly reportError?: (error: unknown, signal: ReconcileSignal) => void,
  ) {}

  accept(signal: ReconcileSignal): Promise<void> {
    return this.enqueue(signal, true);
  }

  acceptTransport(signal: ReconcileSignal): Promise<void> {
    return this.enqueue(signal, false);
  }

  acceptObserved(signal: ReconcileSignal): Promise<void> {
    const running = this.mailboxes.get(signal.jobId)?.running === true;
    return this.enqueue(signal, !running);
  }

  isIdle(): boolean {
    return [...this.mailboxes.values()].every(mailbox => !mailbox.running && !mailbox.scheduled && mailbox.pending.length === 0);
  }

  settle(): Promise<void> {
    if (this.isIdle()) return Promise.resolve();
    return new Promise<void>(resolve => this.idleWaiters.push(resolve));
  }

  private notifyIdle(): void {
    if (!this.isIdle()) return;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private enqueue(signal: ReconcileSignal, waitForProcessing: boolean): Promise<void> {
    const mailbox = this.mailboxes.get(signal.jobId) ?? { pending: [], running: false, scheduled: false };
    this.mailboxes.set(signal.jobId, mailbox);
    let accepted: Promise<void>;
    if (waitForProcessing) {
      accepted = new Promise<void>((resolve, reject) => {
        mailbox.pending.push({ signal, resolve, reject });
      });
    } else {
      mailbox.pending.push({
        signal,
        resolve: () => {},
        reject: error => this.reportError?.(error, signal),
      });
      accepted = Promise.resolve();
    }
    if (!mailbox.running && !mailbox.scheduled) {
      mailbox.scheduled = true;
      queueMicrotask(() => { void this.drain(signal.jobId); });
    }
    return accepted;
  }

  private async drain(jobId: string): Promise<void> {
    const mailbox = this.mailboxes.get(jobId);
    if (!mailbox || mailbox.running) return;
    mailbox.running = true;
    mailbox.scheduled = false;
    try {
      while (mailbox.pending.length > 0) {
        const batch = mailbox.pending.splice(0);
        try {
          await this.consumeBatch(jobId, batch.map(item => item.signal));
          for (const item of batch) item.resolve();
        } catch (error) {
          for (const item of batch) item.reject(error);
        }
        await Promise.resolve();
      }
    } finally {
      mailbox.running = false;
      if (mailbox.pending.length > 0 && !mailbox.scheduled) {
        mailbox.scheduled = true;
        queueMicrotask(() => { void this.drain(jobId); });
      } else if (mailbox.pending.length === 0) {
        this.mailboxes.delete(jobId);
      }
      this.notifyIdle();
    }
  }
}
