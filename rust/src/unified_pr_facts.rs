// Direct port of Node src/unified-pr-facts.ts: timestamp-monotonic, Job-scoped SQLite PR projection; never changes local Job truth.
use rusqlite::{params, Connection};
use serde_json::Value;

/// Preserve Node's exact ON CONFLICT semantics: update only non-regressing
/// observations and never allow MERGED to regress to OPEN or CLOSED.
pub fn save_unified_pull_request_facts(
    db: &Connection,
    job_id: &str,
    facts: &Value,
) -> Result<(), String> {
    let state = facts
        .get("state")
        .and_then(Value::as_str)
        .ok_or_else(|| "PR facts state must be a string".to_string())?;
    let observed_at = facts
        .get("observedAt")
        .and_then(Value::as_str)
        .ok_or_else(|| "PR facts observedAt must be a string".to_string())?;
    let reference = facts.pointer("/head/ref").and_then(Value::as_str);
    let sha = facts.pointer("/head/sha").and_then(Value::as_str);
    db.execute("INSERT INTO pull_request_facts(scope_job_id,id,state,head_ref,head_sha,observed_at) VALUES(?1,1,?2,?3,?4,?5)
      ON CONFLICT(scope_job_id,id) DO UPDATE SET state=excluded.state,head_ref=excluded.head_ref,
        head_sha=excluded.head_sha,observed_at=excluded.observed_at
      WHERE excluded.observed_at >= pull_request_facts.observed_at
        AND (pull_request_facts.state='OPEN'
          OR (pull_request_facts.state='CLOSED' AND excluded.state IN ('CLOSED','MERGED'))
          OR (pull_request_facts.state='MERGED' AND excluded.state='MERGED'))",
        params![job_id,state,reference,sha,observed_at]).map_err(|error|error.to_string())?;
    Ok(())
}
