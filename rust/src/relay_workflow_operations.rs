// Direct port of src/relay-workflow-operations.ts: SQLite owns lifecycle
// truth, Graph authorizes launch, and outbox events commit in one transaction.
use crate::{
    relay_job_snapshot_reads::normalize_relay_job,
    task_comments::append_task_comment,
    workflow::{
        action_ledger::WorkflowActionLedger,
        conditions::{boolean_condition, ConditionRegistry},
        definitions_v2::task_lifecycle_v2,
        dispatcher::{decide_workflow_graph, DispatchOptions},
        durable_publication::DurableWorkflowPublication,
    },
};
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{future::Future, path::Path};

fn now() -> String {
    DateTime::<Utc>::from(std::time::SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn js_truthy(value: &Value) -> bool {
    !value.is_null() && value != false && value != "" && value != 0
}
fn text<'a>(v: &'a Value, field: &str) -> &'a str {
    v.get(field).and_then(Value::as_str).unwrap_or("")
}
fn js_equal(a: &Value, b: &Value) -> bool {
    a == b
}

/// Node Date.parse compares epoch-milliseconds; a real mutation must advance
/// the timestamp even if two writes happen inside the same clock millisecond.
fn monotonic_job_timestamp(previous: &str, candidate: &str) -> String {
    let old = DateTime::parse_from_rfc3339(previous)
        .ok()
        .map(|d| d.timestamp_millis());
    let proposed = DateTime::parse_from_rfc3339(candidate)
        .ok()
        .map(|d| d.timestamp_millis());
    let fallback = DateTime::<Utc>::from(std::time::SystemTime::now()).timestamp_millis();
    let millis = (old.unwrap_or(fallback) + 1).max(proposed.unwrap_or(fallback));
    (DateTime::<Utc>::from_timestamp_millis(millis)
        .unwrap_or_else(|| DateTime::<Utc>::from(std::time::SystemTime::now())))
    .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn read_job(db: &Connection, job_id: &str, prefix: &str) -> Result<Value, String> {
    let raw: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            params![job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(raw) = raw.filter(|s| !s.is_empty()) else {
        return Err(format!("{prefix}{job_id}"));
    };
    normalize_relay_job(&raw)
}
fn history_fields(current: &Value, next: &mut Value) -> Result<Vec<Value>, String> {
    let mut out = Vec::new();
    let Some(tasks) = next["tasks"].as_array() else {
        return Ok(out);
    };
    let changes = tasks
        .iter()
        .filter_map(|task| {
            let before = current["tasks"]
                .as_array()?
                .iter()
                .find(|t| t["id"] == task["id"])?;
            Some((task["id"].clone(), before.clone(), task.clone()))
        })
        .collect::<Vec<_>>();
    for (id, before, after) in changes {
        for field in ["resolution", "escalation"] {
            let prior = &before[field];
            let value = &after[field];
            if js_equal(prior, value) || value.is_null() {
                continue;
            }
            let resolution = field == "resolution";
            let responded = field == "escalation" && value["status"] == "responded";
            let kind = if resolution {
                "resolution.changed"
            } else if responded {
                "escalation.responded"
            } else {
                "escalation.requested"
            };
            let action = if resolution {
                format!("Authoritative resolution changed: {}", value)
            } else if responded {
                format!("Human response to escalation {}: {}. Re-evaluate the historical resolution condition against original execution evidence.",
                    text(value,"id"),text(value,"response"))
            } else {
                format!("Authoritative escalation changed: {}", value)
            };
            let transition = if resolution {
                format!("resolution.{}", text(value, "state"))
            } else {
                format!("escalation.{}", text(value, "status"))
            };
            // Per-transition UUID prevents accidental collapse of independent
            // authoritative state history, while Task comments remain append-only.
            let uuid = unique_key()?;
            let execution = if resolution {
                before
                    .get("executionId")
                    .filter(|id| js_truthy(id))
                    .or_else(|| after.get("executionId").filter(|id| js_truthy(id)))
            } else {
                value
                    .get("originalExecutionId")
                    .filter(|id| js_truthy(id))
                    .or_else(|| before.get("executionId").filter(|id| js_truthy(id)))
            };
            let mut options = json!({"author":if responded{"human"}else{"relay"},"kind":kind,
                "transition":transition,
                "idempotencyKey":format!("task-state/{}/{}/{field}/{uuid}",text(next,"id"),id.as_str().unwrap_or(""))});
            if let Some(execution) = execution {
                options["executionId"] = execution.clone();
            }
            let comment = append_task_comment(next, id.as_str().unwrap_or(""), &action, &options)?;
            out.push(comment);
        }
    }
    Ok(out)
}
fn unique_key() -> Result<String, String> {
    use std::{fs::File, io::Read};
    let mut bytes = [0u8; 16];
    File::open("/dev/urandom")
        .map_err(|e| e.to_string())?
        .read_exact(&mut bytes)
        .map_err(|e| e.to_string())?;
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    Ok(bytes
        .iter()
        .enumerate()
        .map(|(i, x)| {
            if matches!(i, 4 | 6 | 8 | 10) {
                format!("-{x:02x}")
            } else {
                format!("{x:02x}")
            }
        })
        .collect::<String>())
}
pub struct SQLiteWorkflowOperations<'a, W, E>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    pub db: &'a Connection,
    pub write: W,
    pub enqueue: Option<E>,
}
impl<'a, W, E> SQLiteWorkflowOperations<'a, W, E>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    fn enqueue_comments(&mut self, next: &Value, history: &[Value]) -> Result<(), String> {
        if next["prNumber"].as_i64().unwrap_or(0) > 0 {
            for comment in history {
                let key = comment["idempotencyKey"]
                    .as_str()
                    .or_else(|| comment["id"].as_str())
                    .unwrap_or("");
                let request = json!({"idempotencyKey":format!("append_task_comment:{key}"),
                    "operation":"append_task_comment",
                    "payload":{"operation":"append_task_comment","value":comment},"priority":20});
                if let Some(enqueue) = &mut self.enqueue {
                    enqueue(&request, &now())?;
                }
            }
        }
        Ok(())
    }
    pub fn commit_workflow_mutation_and_events(
        &mut self,
        job_id: &str,
        mutate: impl FnOnce(Value) -> Result<Value, String>,
        events: &[Value],
    ) -> Result<Value, String> {
        let publication = DurableWorkflowPublication::new(self.db)?;
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let current = read_job(self.db, job_id, "Unknown Job ")?;
            let previous = current.clone();
            let mut next = mutate(current.clone())?;
            if next["id"] != job_id {
                return Err("Cannot change authoritative Job identity".into());
            }
            if next["state"] != current["state"]
                && (current["state"] == "COMPLETED" || current["state"] == "CANCELLED")
            {
                return Err("Cannot overwrite terminal authoritative state".into());
            }
            let history = history_fields(&previous, &mut next)?;
            if let Ok(before) = DateTime::parse_from_rfc3339(text(&current, "updatedAt")) {
                let new = DateTime::parse_from_rfc3339(text(&next, "updatedAt")).ok();
                if new.is_none_or(|new| new <= before) {
                    next["updatedAt"] = json!((before + Duration::milliseconds(1))
                        .with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true));
                }
            }
            (self.write)(&next, &now())?;
            self.enqueue_comments(&next, &history)?;
            for item in events {
                publication.enqueue(
                    text(item, "key"),
                    text(&item["event"], "type"),
                    &item["event"],
                )?;
                if item["alreadyPublished"]==true {
                    // An incoming Events Bus event has already reached NATS.
                    // Write its published receipt in the same transaction as
                    // the Graph mutation, so a crash cannot echo it later.
                    self.db.execute(
                        "UPDATE workflow_event_outbox SET state='published',
                         published_at=? WHERE event_key=? AND state='pending'",
                        params![now(),text(item,"key")],
                    ).map_err(|e|e.to_string())?;
                }
            }
            Ok(next)
        })();
        self.db
            .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
            .map_err(|e| e.to_string())?;
        result
    }
    pub fn commit_workflow_mutation_with_events(
        &mut self,
        job_id: &str,
        mutate: impl FnOnce(Value) -> Result<(Value, Vec<Value>), String>,
    ) -> Result<Value, String> {
        let publication = DurableWorkflowPublication::new(self.db)?;
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let current = read_job(self.db, job_id, "Unknown Job ")?;
            let previous = current.clone();
            let (mut next, events) = mutate(current.clone())?;
            if next["id"] != job_id {
                return Err("Cannot change authoritative Job identity".into());
            }
            if next["state"] != current["state"]
                && (current["state"] == "COMPLETED" || current["state"] == "CANCELLED")
            {
                return Err("Cannot overwrite terminal authoritative state".into());
            }
            let history = history_fields(&previous, &mut next)?;
            if let Ok(before) = DateTime::parse_from_rfc3339(text(&current, "updatedAt")) {
                if DateTime::parse_from_rfc3339(text(&next, "updatedAt"))
                    .ok()
                    .is_none_or(|at| at <= before)
                {
                    next["updatedAt"] = json!((before + Duration::milliseconds(1))
                        .with_timezone(&Utc)
                        .to_rfc3339_opts(SecondsFormat::Millis, true));
                }
            }
            (self.write)(&next, &now())?;
            self.enqueue_comments(&next, &history)?;
            for item in &events {
                publication.enqueue(
                    text(item, "key"),
                    text(&item["event"], "type"),
                    &item["event"],
                )?;
            }
            Ok(next)
        })();
        self.db
            .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
            .map_err(|e| e.to_string())?;
        result
    }
    pub fn mutate_job(
        &mut self,
        job_id: &str,
        mutate: impl FnOnce(Value) -> Result<Value, String>,
    ) -> Result<Value, String> {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|e| e.to_string())?;
        let result = (|| {
            let current = read_job(self.db, job_id, "Local authoritative Job ")?;
            let before = current.clone();
            let before_wire = serde_json::to_string(&current).map_err(|e| e.to_string())?;
            let mut next = mutate(current)?;
            let history = history_fields(&before, &mut next)?;
            if next["id"] != job_id {
                return Err("Cannot change authoritative Job identity".into());
            }
            if next["repository"] != before["repository"]
                || next["projectRoot"] != before["projectRoot"]
            {
                return Err("Job local repository identity and projectRoot are immutable".into());
            }
            if serde_json::to_string(&next).map_err(|e| e.to_string())? != before_wire
                && text(&next, "updatedAt") <= text(&before, "updatedAt")
            {
                next["updatedAt"] =
                    json!(monotonic_job_timestamp(text(&before, "updatedAt"), &now()));
            }
            (self.write)(&next, &now())?;
            self.enqueue_comments(&next, &history)?;
            Ok(next)
        })();
        self.db
            .execute_batch(if result.is_ok() { "COMMIT" } else { "ROLLBACK" })
            .map_err(|e| e.to_string())?;
        result
    }
    pub fn reserve_workflow_launch(
        &self,
        directory: &Path,
        identity: &Value,
    ) -> Result<bool, String> {
        let job_id = text(identity, "jobId");
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?",
                params![job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(raw) = raw.filter(|x| !x.is_empty()) else {
            return Err("authoritative job snapshot unavailable".into());
        };
        let job: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let _task = job["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == identity["taskId"]);
        let graph = task_lifecycle_v2(directory)?;
        let mut options =
            DispatchOptions::event("QUEUED", "dispatch", &json!({"dispatchable":true}), 4);
        options.graph_name = Some("task-lifecycle".into());
        let decision = decide_workflow_graph(&graph, &options, |_| false)?;
        if decision["accepted"] != true {
            return Err("canonical Task Graph did not authorize launch".into());
        }
        let Some(action) = decision["actions"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|a| a["id"] == "effect.launchTask")
        else {
            return Err("canonical Task Graph did not authorize launch".into());
        };
        let key = format!(
            "{}/{}/{}/launch",
            job_id,
            text(identity, "taskId"),
            text(identity, "executionId")
        );
        let mut claimed = identity.clone();
        claimed["generation"] = identity["attempt"].clone();
        claimed["graph"] = json!("task-lifecycle.mmd");
        claimed["actionId"] = action["id"].clone();
        claimed["attemptKey"] = json!(key);
        WorkflowActionLedger::new(self.db)?.reserve_for_claimed_dispatch(
            &claimed,
            &decision,
            "worker.started",
        )
    }
    pub fn verify_workflow_launch(
        &self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
    ) -> Result<String, String> {
        let ledger = WorkflowActionLedger::new(self.db)?;
        let key = format!("{job_id}/{task_id}/{execution_id}/launch");
        if ledger.trace(&key)?.is_none() {
            return Ok("Unknown".into());
        }
        let raw: Option<String> = self
            .db
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?",
                params![job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(raw) = raw else {
            return Ok("Unknown".into());
        };
        let job: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let task = job["tasks"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|t| t["id"] == task_id);
        let started = task.is_some_and(|t| {
            t["state"] == "RUNNING"
                && t["executionId"] == execution_id
                && js_truthy(&t["leaseOwner"])
                && t["executionHistory"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|e| e["id"] == execution_id && e["attempt"] == t["attempt"])
        });
        let conditions = ConditionRegistry::new(vec![boolean_condition("worker.started")])?;
        let facts = if started {
            json!({"worker.started":true})
        } else {
            json!({})
        };
        Ok(text(&ledger.verify(&key, &conditions, &facts)?, "outcome").into())
    }
    pub fn drain_workflow_events(
        &self,
        mut publish: impl FnMut(&Value) -> Result<(), String>,
    ) -> Result<usize, String> {
        DurableWorkflowPublication::new(self.db)?.replay(|item| {
            let payload = &item.payload;
            if payload["event_id"] != item.key || payload["type"] != item.event_id {
                return Err("Outbox event identity mismatch".into());
            }
            publish(payload)
        })
    }
    pub async fn drain_workflow_events_async<F, Fut>(&self, mut publish: F) -> Result<usize, String>
    where
        F: FnMut(Value) -> Fut,
        Fut: Future<Output = Result<(), String>>,
    {
        // Serial awaiting preserves outbox receipt order. The caller's adapter
        // remains responsible for publishing to the configured bus.
        let publication = DurableWorkflowPublication::new(self.db)?;
        let mut count = 0;
        for item in publication.pending()? {
            if item.payload["event_id"] != item.key || item.payload["type"] != item.event_id {
                return Err("Outbox event identity mismatch".into());
            }
            publish(item.payload.clone()).await?;
            self.db.execute("UPDATE workflow_event_outbox SET state='published',published_at=? WHERE event_key=? AND state='pending'",
                params![now(),item.key]).map_err(|e|e.to_string())?;
            count += 1;
        }
        Ok(count)
    }
}
