/** SQLite durable publication receipts. External consumers must dedupe event_key. */
import type { DatabaseSync } from 'node:sqlite';
export type PendingWorkflowEvent = Readonly<{ key: string; eventId: string; payload: unknown }>;
export class DurableWorkflowPublication {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS workflow_event_outbox (
      event_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, payload_json TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published')),
      created_at TEXT NOT NULL, published_at TEXT
    )`);
  }
  /** State mutation callback MUST use this.db synchronously; rollback covers both writes. */
  commitTransitionAndEvents(transition: () => void, events: readonly PendingWorkflowEvent[]): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      transition();
      for (const event of events) this.enqueue(event.key, event.eventId, event.payload);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  enqueue(key: string, eventId: string, payload: unknown): void {
    if (!key || !eventId) throw new Error('event identity required');
    const encoded = JSON.stringify(payload ?? null);
    this.db.prepare(`INSERT OR IGNORE INTO workflow_event_outbox(event_key,event_id,payload_json,created_at) VALUES(?,?,?,?)`)
      .run(key,eventId,encoded,new Date().toISOString());
    const existing = this.db.prepare('SELECT event_id,payload_json FROM workflow_event_outbox WHERE event_key=?').get(key) as {event_id:string;payload_json:string};
    if (existing.event_id !== eventId || existing.payload_json !== encoded) throw new Error('workflow event key collision');
  }
  pending(): readonly PendingWorkflowEvent[] {
    return (this.db.prepare("SELECT event_key,event_id,payload_json FROM workflow_event_outbox WHERE state='pending' ORDER BY created_at,event_key").all() as Array<{event_key:string;event_id:string;payload_json:string}>).map(row=>({key:row.event_key,eventId:row.event_id,payload:JSON.parse(row.payload_json)}));
  }
  async replay(publish: (event: PendingWorkflowEvent)=>Promise<void>): Promise<number> {
    let delivered=0;
    for (const event of this.pending()) {
      await publish(event);
      this.db.prepare("UPDATE workflow_event_outbox SET state='published',published_at=? WHERE event_key=? AND state='pending'").run(new Date().toISOString(),event.key);
      delivered++;
    }
    return delivered;
  }
}
