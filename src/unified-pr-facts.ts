import type { DatabaseSync } from 'node:sqlite';
import type { PullRequestFacts } from './relay-store.js';

/** Job-scoped PR projection facts; never conflate the historic singleton id=1. */
export function saveUnifiedPullRequestFacts(db: DatabaseSync, jobId: string, facts: PullRequestFacts): void {
  db.prepare(`INSERT INTO pull_request_facts(scope_job_id,id,state,head_ref,head_sha,observed_at) VALUES(?,1,?,?,?,?)
    ON CONFLICT(scope_job_id,id) DO UPDATE SET state=excluded.state,head_ref=excluded.head_ref,
      head_sha=excluded.head_sha,observed_at=excluded.observed_at
    WHERE excluded.observed_at >= pull_request_facts.observed_at
      AND (pull_request_facts.state='OPEN'
        OR (pull_request_facts.state='CLOSED' AND excluded.state IN ('CLOSED','MERGED'))
        OR (pull_request_facts.state='MERGED' AND excluded.state='MERGED'))`)
    .run(jobId, facts.state, facts.head?.ref ?? null, facts.head?.sha ?? null, facts.observedAt);
}
