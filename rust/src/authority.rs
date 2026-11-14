//! Transactional writer for Relay's *existing* authoritative SQLite schema.
//! Caller owns Graph validation and provides primitive mutations/effect intents.
//! No independent scheduler or workflow policy exists in this module.
mod coordinator;
mod ids;
pub use coordinator::{graph_hash, ChildMaterialization, DAGExecutor, DAGMaterialize};
mod ledger;
mod process;
mod projection;
mod review;
pub use ids::EntityKind;
pub use ledger::{ActionIdentity, ActionOutcome, ActionTrace};
pub use process::{probe_process, ExecutionProcessRecord, ProcessProbe};
pub use projection::{ProjectionItem, ProjectionRequest, ProjectionRetry};
pub use review::{review_fingerprint, ReviewDelivery, ReviewReceipt, ReviewResume};
use rusqlite::{
    params, Connection, OpenFlags, OptionalExtension, Transaction, TransactionBehavior,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

const PUBLICATION_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_event_outbox (
  event_key TEXT PRIMARY KEY, event_id TEXT NOT NULL, payload_json TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','published')),
  created_at TEXT NOT NULL, published_at TEXT
);
CREATE TABLE IF NOT EXISTS workflow_event_inbox (
  consumer_id TEXT NOT NULL, event_key TEXT NOT NULL, event_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, consumed_at TEXT NOT NULL,
  PRIMARY KEY(consumer_id,event_key)
);"#;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowEvent {
    pub key: String,
    pub event_id: String,
    pub payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommittedJob {
    pub job_id: String,
    pub job: Value,
    pub events: Vec<WorkflowEvent>,
}

pub struct RelayAuthority {
    connection: Connection,
}

impl RelayAuthority {
    /// Safety fence: an explicit existing DB path is mandatory. Never create
    /// a second operational store or silently migrate an unfamiliar schema.
    pub fn open_existing(path: &Path) -> Result<Self, String> {
        if !path.is_file() {
            return Err(format!(
                "refusing to create Relay store: {}",
                path.display()
            ));
        }
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|error| format!("Relay SQLite open failed: {error}"))?;
        conn.busy_timeout(Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.pragma_update(None, "foreign_keys", "ON")
            .map_err(|e| e.to_string())?;
        let present: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='job_snapshot'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if present != 1 {
            return Err("not a Relay V2 database: missing job_snapshot".into());
        }
        let columns = conn
            .prepare("PRAGMA table_info('job_snapshot')")
            .and_then(|mut stmt| {
                stmt.query_map([], |row| row.get::<_, String>(1))?
                    .collect::<rusqlite::Result<Vec<_>>>()
            })
            .map_err(|e| e.to_string())?;
        if !["job_id", "json", "updated_at"]
            .iter()
            .all(|col| columns.iter().any(|name| name == col))
        {
            return Err("incompatible job_snapshot layout".into());
        }
        Ok(Self { connection: conn })
    }

    fn prepare_publication(tx: &Transaction<'_>) -> Result<(), String> {
        tx.execute_batch(PUBLICATION_SCHEMA)
            .map_err(|e| e.to_string())
    }
    pub fn read_job(&self, job_id: &str) -> Result<Option<Value>, String> {
        let row: Option<String> = self
            .connection
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?1",
                [job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        row.map(|json| serde_json::from_str(&json).map_err(|e| e.to_string()))
            .transpose()
    }

    /// Exposes transaction-scoped mutation to **Graph-authorized** callers;
    /// all identity/time and event/outbox validations are enforced here.
    /// A panic in the callback unwinds the Transaction, rolling back SQLite.
    pub fn commit_job<F>(
        &mut self,
        job_id: &str,
        at: &str,
        mutate: F,
    ) -> Result<CommittedJob, String>
    where
        F: FnOnce(&Value) -> Result<(Value, Vec<WorkflowEvent>), String>,
    {
        self.commit_job_with_tx(job_id, at, |_, original| mutate(original))
    }

    /// Shared transaction: e.g. Coordinator child ID allocation and Task
    /// snapshot creation must commit or roll back together. Callers never
    /// create a second SQLite connection while holding this writer lock.
    pub(crate) fn commit_job_with_tx<F>(
        &mut self,
        job_id: &str,
        at: &str,
        mutate: F,
    ) -> Result<CommittedJob, String>
    where
        F: FnOnce(&Transaction<'_>, &Value) -> Result<(Value, Vec<WorkflowEvent>), String>,
    {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let (stored_json, stored_time): (String, String) = tx
            .query_row(
                "SELECT json,updated_at FROM job_snapshot WHERE job_id=?1",
                [job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Unknown Job {job_id}"))?;
        let original: Value = serde_json::from_str(&stored_json).map_err(|e| e.to_string())?;
        let (next, events) = mutate(&tx, &original)?;
        check_snapshot(job_id, &original, &next, &stored_time, at)?;
        Self::prepare_publication(&tx)?;
        let serialized = serde_json::to_string(&next).map_err(|e| e.to_string())?;
        let changes = tx
            .execute(
                "UPDATE job_snapshot SET json=?1,updated_at=?2 WHERE job_id=?3",
                params![serialized, at, job_id],
            )
            .map_err(|e| e.to_string())?;
        if changes != 1 {
            return Err("Job mutation did not update exactly one snapshot".into());
        }
        for event in &events {
            enqueue(&tx, event, at)?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(CommittedJob {
            job_id: job_id.to_string(),
            job: next,
            events,
        })
    }

    /// The synchronous transaction includes the consumer's own state write.
    /// Replay is idempotent; same key with different event content is fatal.
    pub fn consume<F>(
        &mut self,
        consumer_id: &str,
        event: &WorkflowEvent,
        at: &str,
        apply: F,
    ) -> Result<bool, String>
    where
        F: FnOnce(&Transaction<'_>) -> Result<(), String>,
    {
        if consumer_id.is_empty() || consumer_id.len() > 256 {
            return Err("invalid consumer ID".into());
        }
        validate_event(event)?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        Self::prepare_publication(&tx)?;
        let existing:Option<(String,String)>=tx.query_row(
            "SELECT event_id,payload_json FROM workflow_event_inbox WHERE consumer_id=?1 AND event_key=?2",
            params![consumer_id,event.key],|row|Ok((row.get(0)?,row.get(1)?))
        ).optional().map_err(|e|e.to_string())?;
        if let Some((previous_id, previous_payload)) = existing {
            let previous: Value =
                serde_json::from_str(&previous_payload).map_err(|e| e.to_string())?;
            if previous_id != event.event_id || previous != event.payload {
                return Err("consumer event key collision".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        apply(&tx)?;
        tx.execute("INSERT INTO workflow_event_inbox (consumer_id,event_key,event_id,payload_json,consumed_at) VALUES (?1,?2,?3,?4,?5)",
            params![consumer_id,event.key,event.event_id,serde_json::to_string(&event.payload).map_err(|e|e.to_string())?,at])
            .map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
    pub fn pending_events(&self) -> Result<Vec<WorkflowEvent>, String> {
        let exists:bool=self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_event_outbox')",
            [],|row|row.get(0),
        ).map_err(|e|e.to_string())?;
        if !exists {
            return Ok(Vec::new());
        }
        let mut stmt=self.connection.prepare(
            "SELECT event_key,event_id,payload_json FROM workflow_event_outbox WHERE state='pending' ORDER BY created_at,event_key"
        ).map_err(|e|e.to_string())?;
        let pending = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?
            .map(|row| {
                let (key, event_id, payload) = row.map_err(|e| e.to_string())?;
                Ok(WorkflowEvent {
                    key,
                    event_id,
                    payload: serde_json::from_str(&payload).map_err(|e| e.to_string())?,
                })
            })
            .collect();
        pending
    }
    /// Only caller-confirmed delivery may mark a pending event published.
    pub fn confirm_published(&mut self, key: &str, at: &str) -> Result<bool, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let modified=tx.execute(
            "UPDATE workflow_event_outbox SET state='published',published_at=?1 WHERE event_key=?2 AND state='pending'",
            params![at,key],
        ).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(modified == 1)
    }
}

fn check_snapshot(
    id: &str,
    old: &Value,
    next: &Value,
    before: &str,
    at: &str,
) -> Result<(), String> {
    let before_obj = old
        .as_object()
        .ok_or("corrupt Job snapshot: expected object")?;
    let after = next
        .as_object()
        .ok_or("mutation must return a Job object")?;
    if old.get("id").and_then(Value::as_str) != Some(id)
        || next.get("id").and_then(Value::as_str) != Some(id)
    {
        return Err("Cannot change authoritative Job identity".into());
    }
    for field in ["repository", "projectRoot"] {
        if before_obj.get(field) != after.get(field) {
            return Err(format!("immutable Job {field} changed"));
        }
    }
    if matches!(
        old.get("state").and_then(Value::as_str),
        Some("COMPLETED" | "CANCELLED")
    ) && old.get("state") != next.get("state")
    {
        return Err("Cannot overwrite terminal authoritative Job state".into());
    }
    if !next.get("tasks").is_some_and(Value::is_array) {
        return Err("Job tasks must be an array".into());
    }
    // Use ISO-8601 UTC lexical ordering as the canonical monotonic version.
    // The TS writer increases updatedAt on every state mutation. Do not let a
    // stale Rust writer erase a fresher snapshot.
    let prior = chrono::DateTime::parse_from_rfc3339(before)
        .map_err(|_| "corrupt Job snapshot timestamp")?;
    let after =
        chrono::DateTime::parse_from_rfc3339(at).map_err(|_| "invalid new Job timestamp")?;
    if after <= prior || next.get("updatedAt").and_then(Value::as_str) != Some(at) {
        return Err("non-monotonic Job updatedAt; caller must provide new ISO timestamp".into());
    }
    Ok(())
}

fn validate_event(event: &WorkflowEvent) -> Result<(), String> {
    if event.key.is_empty()
        || event.event_id.is_empty()
        || event.key.len() > 512
        || event.event_id.len() > 512
    {
        return Err("workflow event identity required".into());
    }
    // Relay's outbox key is the event_idempotency identity and the payload's
    // own event_id is the same, checked on replay by TypeScript.
    if !event.payload.is_object() {
        return Err("workflow event payload must be object".into());
    }
    Ok(())
}
fn enqueue(tx: &Transaction<'_>, event: &WorkflowEvent, at: &str) -> Result<(), String> {
    validate_event(event)?;
    let encoded = serde_json::to_string(&event.payload).map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT OR IGNORE INTO workflow_event_outbox(event_key,event_id,payload_json,created_at) VALUES(?1,?2,?3,?4)",
        params![event.key,event.event_id,encoded,at],
    ).map_err(|e|e.to_string())?;
    let (id, payload): (String, String) = tx
        .query_row(
            "SELECT event_id,payload_json FROM workflow_event_outbox WHERE event_key=?1",
            [&event.key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|e| e.to_string())?;
    let previous: Value = serde_json::from_str(&payload).map_err(|e| e.to_string())?;
    if id != event.event_id || previous != event.payload {
        return Err("workflow event key collision".into());
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    pub(crate) fn setup() -> (tempfile::TempDir, PathBuf) {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("relay.sqlite");
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE effect_probe(k TEXT PRIMARY KEY,value TEXT NOT NULL);").unwrap();
        let job = json!({"id":"91","repository":"example","projectRoot":"/isolated/repo",
            "state":"ACTIVE","updatedAt":"2026-11-13T20:00:00.000Z",
            "tasks":[{"id":"101","state":"QUEUED"}]});
        conn.execute(
            "INSERT INTO job_snapshot VALUES(?1,?2,?3)",
            params![
                "91",
                serde_json::to_string(&job).unwrap(),
                "2026-11-13T20:00:00.000Z"
            ],
        )
        .unwrap();
        (temp, path)
    }
    fn at(index: u8) -> String {
        format!("2026-11-13T20:00:{index:02}.000Z")
    }
    fn event(key: &str) -> WorkflowEvent {
        WorkflowEvent {
            key: key.into(),
            event_id: "task.queued".into(),
            payload: json!({"event_id":key,"type":"task.queued","taskId":"101"}),
        }
    }

    #[test]
    fn atomic_snapshot_and_event_write_is_readable_by_standard_sqlite() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let result = authority
            .commit_job("91", &at(1), |job| {
                let mut next = job.clone();
                next["tasks"][0]["state"] = json!("RUNNING");
                next["updatedAt"] = json!(at(1));
                Ok((next, vec![event("event-1")]))
            })
            .unwrap();
        assert_eq!(result.job["tasks"][0]["state"], "RUNNING");
        assert_eq!(authority.pending_events().unwrap(), vec![event("event-1")]);
        let direct = Connection::open(&path).unwrap();
        let (snapshot, time): (String, String) = direct
            .query_row(
                "SELECT json,updated_at FROM job_snapshot WHERE job_id='91'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&snapshot).unwrap(),
            result.job
        );
        assert_eq!(time, at(1));
        assert!(!authority.confirm_published("nonexistent", &at(2)).unwrap());
        assert!(authority.confirm_published("event-1", &at(2)).unwrap());
        assert!(!authority.confirm_published("event-1", &at(2)).unwrap());
        assert!(authority.pending_events().unwrap().is_empty());
    }

    #[test]
    fn callback_error_or_event_collision_undoes_all_mutations() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let original = authority.read_job("91").unwrap().unwrap();
        let bad = authority.commit_job("91", &at(1), |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!(at(1));
            let _ = next;
            Err("synthetic failure".into())
        });
        assert!(bad.is_err());
        assert_eq!(authority.read_job("91").unwrap().unwrap(), original);
        let forged = authority.commit_job("91", &at(1), |job| {
            let mut next = job.clone();
            next["repository"] = json!("other");
            next["updatedAt"] = json!(at(1));
            Ok((next, vec![]))
        });
        assert!(forged.unwrap_err().contains("immutable Job repository"));
        assert_eq!(authority.read_job("91").unwrap().unwrap(), original);
        authority
            .commit_job("91", &at(1), |job| {
                let mut next = job.clone();
                next["updatedAt"] = json!(at(1));
                Ok((next, vec![event("same-key")]))
            })
            .unwrap();
        let original = authority.read_job("91").unwrap().unwrap();
        let collision = authority.commit_job("91", &at(2), |job| {
            let mut next = job.clone();
            next["updatedAt"] = json!(at(2));
            next["state"] = json!("FAILED");
            let mut duplicate = event("same-key");
            duplicate.event_id = "different.event".into();
            Ok((next, vec![duplicate]))
        });
        assert!(collision
            .unwrap_err()
            .contains("workflow event key collision"));
        assert_eq!(authority.read_job("91").unwrap().unwrap(), original);
        assert_eq!(authority.pending_events().unwrap(), vec![event("same-key")]);
    }

    #[test]
    fn inbox_consumption_is_atomic_idempotent_and_rejects_collision() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let one = event("inbox-id");
        let consume = |tx: &Transaction<'_>| {
            tx.execute(
                "INSERT INTO effect_probe(k,value) VALUES('single','recorded')",
                [],
            )
            .map_err(|e| e.to_string())?;
            Ok(())
        };
        assert!(authority
            .consume("my-worker", &one, &at(1), consume)
            .unwrap());
        assert!(!authority
            .consume("my-worker", &one, &at(2), |_| {
                panic!("duplicate must not invoke callback")
            })
            .unwrap());
        let different = WorkflowEvent {
            payload: json!({"event_id":"changed"}),
            ..one.clone()
        };
        assert!(authority
            .consume("my-worker", &different, &at(2), |_| Ok(()))
            .unwrap_err()
            .contains("consumer event key collision"));
        let sql = Connection::open(&path).unwrap();
        let count: i64 = sql
            .query_row("SELECT count(*) FROM effect_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        let another = event("other-id");
        let result = authority.consume("my-worker", &another, &at(3), |tx| {
            tx.execute(
                "INSERT INTO effect_probe(k,value) VALUES('rolled','back')",
                [],
            )
            .map_err(|e| e.to_string())?;
            Err("synthetic failure".into())
        });
        assert!(result.is_err());
        let count: i64 = sql
            .query_row("SELECT count(*) FROM effect_probe", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 1);
        assert!(authority
            .consume("my-worker", &another, &at(4), |_| Ok(()))
            .unwrap());
    }

    #[test]
    fn terminal_job_cannot_be_reopened() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        authority
            .commit_job("91", &at(1), |job| {
                let mut next = job.clone();
                next["updatedAt"] = json!(at(1));
                next["state"] = json!("COMPLETED");
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(authority
            .commit_job("91", &at(2), |job| {
                let mut next = job.clone();
                next["state"] = json!("ACTIVE");
                next["updatedAt"] = json!(at(2));
                Ok((next, vec![]))
            })
            .unwrap_err()
            .contains("terminal"));
    }
}
