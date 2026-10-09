import type { DatabaseSync } from 'node:sqlite';
import type { PackagePublication, PackagePublishFailure } from './github-webhook.js';

export type PublicationState = {
  latest: PackagePublication | null;
  failure: PackagePublishFailure | null;
  updatedAt: string;
};

export type PublicationEvent = { deliveryId: string; type: 'package.published' | 'package.publish_failed'; observedAt: string; payload: PackagePublication | PackagePublishFailure };

/** Persist a webhook publication acknowledgement and its delivery ID in one transaction. */
export function recordPublicationInDatabase(
  db: DatabaseSync,
  jobId: string,
  deliveryId: string,
  publication: PackagePublication | null,
  failure: PackagePublishFailure | null,
  observedAt = new Date().toISOString(),
): boolean {
  if (!publication && !failure) return false;
  db.exec('BEGIN IMMEDIATE');
  try {
    const inserted = db.prepare('INSERT OR IGNORE INTO publication_delivery(job_id,delivery_id,type,json,observed_at) VALUES(?,?,?,?,?)')
      .run(jobId, deliveryId, publication ? 'package.published' : 'package.publish_failed', JSON.stringify(publication ?? failure), observedAt);
    if (inserted.changes === 0) { db.exec('COMMIT'); return false; }
    const previous = loadPublicationFromDatabase(db, jobId);
    const isNewer = !previous || observedAt >= previous.updatedAt;
    const next: PublicationState = isNewer ? {
      latest: publication ?? previous?.latest ?? null,
      failure: failure ?? (publication ? null : previous?.failure ?? null),
      updatedAt: observedAt,
    } : previous;
    db.prepare('INSERT INTO publication_state(job_id,json) VALUES(?,?) ON CONFLICT(job_id) DO UPDATE SET json=excluded.json')
      .run(jobId, JSON.stringify(next));
    db.exec('COMMIT');
    return true;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function loadPublicationFromDatabase(db: DatabaseSync, jobId: string): PublicationState | null {
  const row = db.prepare('SELECT json FROM publication_state WHERE job_id=?').get(jobId) as { json: string } | undefined;
  return row ? JSON.parse(row.json) as PublicationState : null;
}

export function listPublicationEventsFromDatabase(db: DatabaseSync, jobId: string): PublicationEvent[] {
  const rows = db.prepare('SELECT delivery_id,type,json,observed_at FROM publication_delivery WHERE job_id=? ORDER BY observed_at,delivery_id').all(jobId) as Array<{
    delivery_id: string; type: PublicationEvent['type']; json: string; observed_at: string;
  }>;
  return rows.map(row => ({ deliveryId: row.delivery_id, type: row.type, observedAt: row.observed_at, payload: JSON.parse(row.json) }));
}
