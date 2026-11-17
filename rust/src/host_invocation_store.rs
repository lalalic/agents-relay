// Direct port of src/host-invocation-store.ts. SQLite is the sole durable
// decision ledger; a host receipt cannot approve an unbound or stale execution.
use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

pub const HOST_INVOCATION_TABLES_SQL: &str = r#"
  CREATE TABLE IF NOT EXISTS host_invocation_event (
    job_id TEXT NOT NULL, task_id TEXT NOT NULL, event_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL, execution_id TEXT NOT NULL, revision TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
    outcome TEXT NOT NULL CHECK(outcome IN ('accepted','duplicate','stale','ignored')),
    fingerprint TEXT NOT NULL, received_at TEXT NOT NULL,
    PRIMARY KEY(job_id,task_id,event_id)
  );
  CREATE TABLE IF NOT EXISTS host_invocation_decision (
    job_id TEXT NOT NULL, task_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    execution_id TEXT NOT NULL, revision TEXT NOT NULL,
    decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
    feedback TEXT, fingerprint TEXT NOT NULL, event_id TEXT NOT NULL,
    decided_at TEXT NOT NULL,
    PRIMARY KEY(job_id,task_id,invocation_id), UNIQUE(job_id,task_id,event_id)
  );"#;

#[derive(Debug, Clone, PartialEq)]
pub struct HostInvocationReceipt {
    pub outcome: String,
    pub reason: String,
    pub invocation: Option<Value>,
}
impl HostInvocationReceipt {
    pub fn value(&self) -> Value {
        let mut result = json!({"outcome":self.outcome,"reason":self.reason});
        if let Some(ref invocation) = self.invocation {
            result["invocation"] = invocation.clone();
        }
        result
    }
}
fn string<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn record_event(
    db: &Connection,
    delivery: &Value,
    outcome: &str,
    fingerprint: &str,
) -> Result<(), String> {
    db.execute("INSERT OR IGNORE INTO host_invocation_event (job_id,task_id,event_id,invocation_id,execution_id,revision,decision,outcome,fingerprint,received_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    params![string(delivery,"jobId"),string(delivery,"taskId"),string(delivery,"eventId"),string(delivery,"invocationId"),
        string(delivery,"executionId"),string(delivery,"revision"),string(delivery,"decision"),outcome,fingerprint,
        string(delivery,"deliveredAt")]).map_err(|e|e.to_string())?;
    Ok(())
}
pub fn record_host_invocation_event(
    db: &Connection,
    delivery: &Value,
    outcome: &str,
    fingerprint: &str,
) -> Result<(), String> {
    record_event(db, delivery, outcome, fingerprint)
}
pub fn has_host_invocation_decision(
    db: &Connection,
    job_id: &str,
    task_id: &str,
    invocation_id: &str,
    fingerprint: Option<&str>,
) -> Result<bool, String> {
    db.query_row("SELECT 1 FROM host_invocation_decision WHERE job_id=? AND task_id=? AND invocation_id=? AND (? IS NULL OR fingerprint=?)",
        params![job_id,task_id,invocation_id,fingerprint,fingerprint],|row|row.get::<_,i32>(0))
        .optional().map(|result|result.is_some()).map_err(|e|e.to_string())
}
fn parse_time(s: &str) -> Result<i64, String> {
    DateTime::parse_from_rfc3339(s)
        .map(|d| d.timestamp_millis())
        .map_err(|e| e.to_string())
}
fn next_updated_at(previous: &str, delivery: &str) -> Result<String, String> {
    let old = parse_time(previous)?;
    if parse_time(delivery).is_ok_and(|candidate| candidate > old) {
        return Ok(delivery.to_owned());
    }
    let at = Utc
        .timestamp_millis_opt(old + 1)
        .single()
        .ok_or("Invalid timestamp")?;
    Ok(at.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

/// The caller's writeSnapshot must use the supplied connection within the
/// active transaction. Failure rolls back both rows and any snapshot updates.
pub fn record_host_invocation_decision<F>(
    db: &mut Connection,
    delivery: &Value,
    fingerprint: &str,
    mut write_snapshot: F,
) -> Result<HostInvocationReceipt, String>
where
    F: FnMut(&Connection, &Value, &str) -> Result<(), String>,
{
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let job_id = string(delivery, "jobId");
    let task_id = string(delivery, "taskId");
    let invocation_id = string(delivery, "invocationId");
    let execution_id = string(delivery, "executionId");
    let revision = string(delivery, "revision");
    let existing:Option<String>=tx.query_row(
        "SELECT fingerprint FROM host_invocation_decision WHERE job_id=? AND task_id=? AND invocation_id=?",
        params![job_id,task_id,invocation_id],|row|row.get(0)).optional().map_err(|e|e.to_string())?;
    if let Some(existing) = existing {
        let duplicate = existing == fingerprint;
        let outcome = if duplicate { "duplicate" } else { "stale" };
        record_event(&tx, delivery, outcome, fingerprint)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(HostInvocationReceipt {
            outcome: outcome.into(),
            reason: if duplicate {
                "invocation_already_decided"
            } else {
                "conflicting_invocation_decision"
            }
            .into(),
            invocation: None,
        });
    }
    let snapshot: Option<String> = tx
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            params![job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let mut job = match snapshot {
        Some(raw) => Some(serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())?),
        None => None,
    };
    let task_index = job
        .as_ref()
        .and_then(|j| j["tasks"].as_array())
        .and_then(|tasks| tasks.iter().position(|t| string(t, "id") == task_id));
    let bound = job.as_ref().zip(task_index).is_some_and(|(j, index)| {
        let task = &j["tasks"][index];
        let invocation = &task["interactiveInvocation"];
        matches!(string(task, "state"), "RUNNING" | "AWAITING_DECISION")
            && string(invocation, "executionId") == execution_id
            && (string(task, "executionId") == execution_id
                || string(task, "state") == "AWAITING_DECISION")
            && string(invocation, "status") == "awaiting_decision"
            && string(invocation, "invocationId") == invocation_id
            && string(invocation, "revision") == revision
    });
    // eventOnlyReviewEligible is always false in the authoritative Node adapter.
    if !bound || !job.as_ref().is_some_and(|j| string(j, "state") == "ACTIVE") {
        record_event(&tx, delivery, "stale", fingerprint)?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(HostInvocationReceipt {
            outcome: "stale".into(),
            reason: "invocation_or_revision_mismatch".into(),
            invocation: None,
        });
    }
    tx.execute("INSERT INTO host_invocation_decision (job_id,task_id,invocation_id,execution_id,revision,decision,feedback,fingerprint,event_id,decided_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        params![job_id,task_id,invocation_id,execution_id,revision,string(delivery,"decision"),
            delivery["feedback"].as_str(),fingerprint,string(delivery,"eventId"),string(delivery,"deliveredAt")])
        .map_err(|e|e.to_string())?;
    record_event(&tx, delivery, "accepted", fingerprint)?;
    let mut job = job.take().expect("bound active job");
    let task = &mut job["tasks"][task_index.expect("bound task")];
    let old_invocation = &task["interactiveInvocation"];
    let mut decided = json!({
        "invocationId":invocation_id,"revision":revision,"executionId":execution_id,
        "status":string(delivery,"decision"),"boundAt":old_invocation["boundAt"],
        "decidedAt":string(delivery,"deliveredAt")
    });
    for key in ["feedback", "comments", "idempotencyKey"] {
        if let Some(value) = delivery.get(key) {
            decided[key] = value.clone();
        }
    }
    task["interactiveInvocation"] = decided.clone();
    job["updatedAt"] = Value::String(next_updated_at(
        string(&job, "updatedAt"),
        string(delivery, "deliveredAt"),
    )?);
    write_snapshot(&tx, &job, string(delivery, "deliveredAt"))?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(HostInvocationReceipt {
        outcome: "accepted".into(),
        reason: "latest_interactive_decision".into(),
        invocation: Some(decided),
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(&format!("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);{HOST_INVOCATION_TABLES_SQL}")).unwrap();
        db
    }
    fn delivery() -> Value {
        json!({"jobId":"42","taskId":"3","eventId":"e1","invocationId":"inv1",
        "executionId":"ex1","revision":"rev1","decision":"approved","deliveredAt":"2026-11-17T12:00:00.000Z","feedback":"ok"})
    }
    fn job() -> Value {
        json!({"id":"42","state":"ACTIVE","updatedAt":"2026-11-17T11:00:00.000Z",
        "tasks":[{"id":"3","state":"AWAITING_DECISION","executionId":"ex1",
        "interactiveInvocation":{"invocationId":"inv1","executionId":"ex1","revision":"rev1",
            "status":"awaiting_decision","boundAt":"2026-11-17T10:00:00.000Z"}}]})
    }
    fn write(db: &Connection, job: &Value, _: &str) -> Result<(), String> {
        db.execute(
            "UPDATE job_snapshot SET json=? WHERE job_id=?",
            params![job.to_string(), job["id"].as_str()],
        )
        .map_err(|e| e.to_string())
        .map(|_| ())
    }
    #[test]
    fn accepted_duplicate_conflicting_and_stale() {
        let mut db = db();
        db.execute(
            "INSERT INTO job_snapshot VALUES('42',?)",
            params![job().to_string()],
        )
        .unwrap();
        let d = delivery();
        assert_eq!(
            record_host_invocation_decision(&mut db, &d, "hash1", write)
                .unwrap()
                .outcome,
            "accepted"
        );
        assert!(has_host_invocation_decision(&db, "42", "3", "inv1", Some("hash1")).unwrap());
        assert!(!has_host_invocation_decision(&db, "42", "3", "inv1", Some("hash2")).unwrap());
        assert_eq!(
            record_host_invocation_decision(&mut db, &d, "hash1", write)
                .unwrap()
                .outcome,
            "duplicate"
        );
        assert_eq!(
            record_host_invocation_decision(&mut db, &d, "hash2", write)
                .unwrap()
                .outcome,
            "stale"
        );
        let mut d2 = d.clone();
        d2["invocationId"] = json!("inv2");
        d2["eventId"] = json!("e2");
        assert_eq!(
            record_host_invocation_decision(&mut db, &d2, "hash3", write)
                .unwrap()
                .outcome,
            "stale"
        );
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM host_invocation_decision", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 1);
    }
    #[test]
    fn snapshot_failure_rolls_back_decision_and_event() {
        let mut db = db();
        db.execute(
            "INSERT INTO job_snapshot VALUES('42',?)",
            params![job().to_string()],
        )
        .unwrap();
        let result = record_host_invocation_decision(&mut db, &delivery(), "hash", |_, _, _| {
            Err("denied".into())
        });
        assert_eq!(result.unwrap_err(), "denied");
        assert!(!has_host_invocation_decision(&db, "42", "3", "inv1", None).unwrap());
        let count: i64 = db
            .query_row("SELECT COUNT(*) FROM host_invocation_event", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }
}
