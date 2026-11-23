// Direct port of Node src/workflow/action-ledger.ts: atomic SQLite execution/generation reservation and postcondition fencing for Graph-authorized effects.
use crate::{observability::json_wire, workflow::conditions::ConditionRegistry};
use chrono::{DateTime, NaiveDateTime, SecondsFormat, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::time::SystemTime;
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn now() -> String {
    DateTime::<Utc>::from(SystemTime::now()).to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn parse_timestamp(raw: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(raw)
        .ok()
        .map(|date| date.timestamp_millis())
        .or_else(|| {
            NaiveDateTime::parse_from_str(raw, "%Y-%m-%dT%H:%M:%S")
                .ok()
                .map(|date| date.and_utc().timestamp_millis())
        })
}
fn valid_identity(id: &Value, condition_id: &str) -> bool {
    !text(id, "executionId").is_empty()
        && !text(id, "attemptKey").is_empty()
        && !condition_id.is_empty()
        && id
            .get("generation")
            .and_then(Value::as_i64)
            .is_some_and(|generation| (0..=9_007_199_254_740_991).contains(&generation))
}
fn authorized(id: &Value, decision: &Value) -> bool {
    decision.get("accepted") == Some(&Value::Bool(true))
        && decision
            .get("actions")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .any(|action| action.get("id") == id.get("actionId"))
}
fn trace_row(db: &Connection, key: &str) -> Result<Option<Value>, String> {
    db.query_row("SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at FROM workflow_action_trace WHERE attempt_key=?",params![key],|row|{
        Ok(json!({"attemptKey":row.get::<_,String>(0)?,"executionId":row.get::<_,String>(1)?,"generation":row.get::<_,i64>(2)?,
            "graph":row.get::<_,String>(3)?,"actionId":row.get::<_,String>(4)?,"conditionId":row.get::<_,String>(5)?,
            "outcome":row.get::<_,String>(6)?,"observedAt":row.get::<_,String>(7)?}))
    }).optional().map_err(|error|error.to_string())
}
pub struct WorkflowActionLedger<'a> {
    db: &'a Connection,
}
impl<'a> WorkflowActionLedger<'a> {
    pub fn new(db: &'a Connection) -> Result<Self, String> {
        db.execute_batch("CREATE TABLE IF NOT EXISTS workflow_action_trace (\
          attempt_key TEXT PRIMARY KEY,execution_id TEXT NOT NULL,generation INTEGER NOT NULL,\
          graph TEXT NOT NULL,action_id TEXT NOT NULL,condition_id TEXT NOT NULL,\
          outcome TEXT NOT NULL CHECK(outcome IN ('Unknown','Verified','Failed')),observed_at TEXT NOT NULL)")
            .map_err(|error|error.to_string())?;
        Ok(Self { db })
    }
    pub fn trace(&self, attempt_key: &str) -> Result<Option<Value>, String> {
        trace_row(self.db, attempt_key)
    }
    pub fn reserve(
        &self,
        identity: &Value,
        decision: &Value,
        condition_id: &str,
    ) -> Result<bool, String> {
        if !valid_identity(identity, condition_id) {
            return Err("invalid action identity".into());
        }
        if !authorized(identity, decision) {
            return Err("action not authorized by graph decision".into());
        }
        let attempt_key = text(identity, "attemptKey");
        let inserted=self.db.execute("INSERT OR IGNORE INTO workflow_action_trace (attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at) VALUES(?,?,?,?,?,?,'Unknown',?)",
            params![attempt_key,text(identity,"executionId"),identity.get("generation").and_then(Value::as_i64),text(identity,"graph"),text(identity,"actionId"),condition_id,now()])
            .map_err(|error|error.to_string())?==1;
        if !inserted {
            let prior = self
                .trace(attempt_key)?
                .ok_or("attempt key collision: inconsistent action identity")?;
            for key in ["executionId", "generation", "graph", "actionId"] {
                if prior.get(key) != identity.get(key) {
                    return Err("attempt key collision: inconsistent action identity".into());
                }
            }
            if prior.get("conditionId").and_then(Value::as_str) != Some(condition_id) {
                return Err("attempt key collision: inconsistent action identity".into());
            }
        }
        Ok(inserted)
    }
    pub fn reserve_for_running_task(
        &self,
        identity: &Value,
        decision: &Value,
        condition_id: &str,
        clock: &str,
        allowed_state: &str,
    ) -> Result<bool, String> {
        self.db
            .execute_batch("BEGIN IMMEDIATE")
            .map_err(|error| error.to_string())?;
        let result = (|| {
            let job_id = text(identity, "jobId");
            let raw = self
                .db
                .query_row(
                    "SELECT json FROM job_snapshot WHERE job_id=?",
                    params![job_id],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| error.to_string())?
                .ok_or("authoritative job snapshot unavailable")?;
            let job: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
            let task = job
                .get("tasks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .find(|task| task.get("id") == identity.get("taskId"));
            let task = task.ok_or("stale execution, owner, attempt or lease: action fenced")?;
            let attempt = identity.get("attempt");
            let generation = identity.get("generation");
            let valid = text(task, "state") == allowed_state
                && task.get("executionId") == identity.get("executionId")
                && task.get("attempt") == attempt
                && attempt == generation
                && task
                    .get("executionHistory")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .any(|entry| {
                        entry.get("id") == identity.get("executionId")
                            && entry.get("attempt") == generation
                    })
                && job
                    .get("pause")
                    .is_none_or(|pause| pause.is_null() || pause == false)
                ;
            if !valid {
                return Err("stale execution, owner, attempt or lease: action fenced".into());
            }
            self.reserve(identity, decision, condition_id)
        })();
        if result.is_ok() {
            self.db
                .execute_batch("COMMIT")
                .map_err(|error| error.to_string())?;
        } else {
            self.db
                .execute_batch("ROLLBACK")
                .map_err(|error| error.to_string())?;
        }
        result
    }
    pub fn reserve_for_claimed_dispatch(
        &self,
        identity: &Value,
        decision: &Value,
        condition_id: &str,
    ) -> Result<bool, String> {
        if decision.get("accepted") != Some(&Value::Bool(true))
            || text(decision, "source") != "QUEUED"
            || text(decision, "target") != "QUEUED"
            || text(identity, "actionId") != "effect.launchTask"
        {
            return Err(
                "dispatch reservation requires canonical QUEUED Graph launch decision".into(),
            );
        }
        self.reserve_for_running_task(identity, decision, condition_id, &now(), "QUEUED")
    }
    pub fn verify(
        &self,
        attempt_key: &str,
        conditions: &ConditionRegistry,
        facts: &Value,
    ) -> Result<Value, String> {
        let existing = self
            .trace(attempt_key)?
            .ok_or("unreserved action attempt")?;
        if text(&existing, "outcome") != "Unknown" {
            return Ok(existing);
        }
        let outcome = conditions.check(text(&existing, "conditionId"), facts)?;
        self.db.execute("UPDATE workflow_action_trace SET outcome=?,observed_at=? WHERE attempt_key=? AND outcome=?",
            params![outcome,now(),attempt_key,"Unknown"]).map_err(|error|error.to_string())?;
        self.trace(attempt_key)?
            .ok_or_else(|| "unreserved action attempt".into())
    }
}
pub fn action_ledger_json_wire(record: &Value) -> String {
    json_wire(record)
}
