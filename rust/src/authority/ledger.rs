//! Durable action-generation fence matching workflow/action-ledger.ts.
//! Graph must authorize actions; a positive reservation is not task success.
use super::RelayAuthority;
use crate::graph::Decision;
use chrono::{DateTime, FixedOffset};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const LEDGER_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS workflow_action_trace (
    attempt_key TEXT PRIMARY KEY,execution_id TEXT NOT NULL,generation INTEGER NOT NULL,
    graph TEXT NOT NULL,action_id TEXT NOT NULL,condition_id TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK(outcome IN ('Unknown','Verified','Failed')),
    observed_at TEXT NOT NULL
);"#;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionIdentity {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub lease_owner: String,
    pub attempt: i64,
    pub generation: i64,
    pub graph: String,
    pub action_id: String,
    pub attempt_key: String,
}
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub enum ActionOutcome {
    Unknown,
    Verified,
    Failed,
}
impl ActionOutcome {
    fn from_db(text: &str) -> Result<Self, String> {
        match text {
            "Unknown" => Ok(Self::Unknown),
            "Verified" => Ok(Self::Verified),
            "Failed" => Ok(Self::Failed),
            other => Err(format!("unknown outcome '{other}'")),
        }
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Unknown => "Unknown",
            Self::Verified => "Verified",
            Self::Failed => "Failed",
        }
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionTrace {
    pub attempt_key: String,
    pub execution_id: String,
    pub generation: i64,
    pub graph: String,
    pub action_id: String,
    pub condition_id: String,
    pub outcome: ActionOutcome,
    pub observed_at: String,
}
fn timestamp(value: &str) -> Result<DateTime<FixedOffset>, String> {
    DateTime::parse_from_rfc3339(value).map_err(|_| format!("invalid lease or timestamp '{value}'"))
}
type TraceRow = (String, String, i64, String, String, String, String, String);
fn trace(conn: &rusqlite::Connection, key: &str) -> Result<Option<ActionTrace>, String> {
    let data:Option<TraceRow>=conn.query_row(
        "SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at FROM workflow_action_trace WHERE attempt_key=?1",
        [key],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?,row.get(7)?))
    ).optional().map_err(|e|e.to_string())?;
    data.map(
        |(
            attempt_key,
            execution_id,
            generation,
            graph,
            action_id,
            condition_id,
            outcome,
            observed_at,
        )| {
            Ok(ActionTrace {
                attempt_key,
                execution_id,
                generation,
                graph,
                action_id,
                condition_id,
                outcome: ActionOutcome::from_db(&outcome)?,
                observed_at,
            })
        },
    )
    .transpose()
}

/// Primitive ledger insertion usable by a caller that already holds the
/// authoritative `BEGIN IMMEDIATE` lock and has validated the current
/// execution generation. This is deliberately the same attempt table as
/// `reserve_action`, not an independent Scheduler claim ledger.
pub(super) fn reserve_authorized_action_tx(
    tx: &rusqlite::Transaction<'_>,
    identity: &ActionIdentity,
    decision: &Decision,
    condition_id: &str,
    at: &str,
) -> Result<bool, String> {
    if identity.job_id.is_empty()
        || identity.task_id.is_empty()
        || identity.execution_id.is_empty()
        || identity.lease_owner.is_empty()
        || identity.attempt_key.is_empty()
        || identity.graph.is_empty()
        || condition_id.is_empty()
        || identity.attempt < 0
        || identity.attempt != identity.generation
    {
        return Err("invalid action identity".into());
    }
    if !matches!(decision,Decision::Accepted{actions,..} if actions.iter().any(|a|a.id==identity.action_id))
    {
        return Err("action not authorized by graph decision".into());
    }
    tx.execute_batch(LEDGER_TABLE).map_err(|e| e.to_string())?;
    let inserted=tx.execute("INSERT OR IGNORE INTO workflow_action_trace(attempt_key,execution_id,generation,graph,action_id,condition_id,outcome,observed_at) VALUES (?1,?2,?3,?4,?5,?6,'Unknown',?7)",
        params![identity.attempt_key,identity.execution_id,identity.generation,identity.graph,identity.action_id,condition_id,at]
    ).map_err(|e|e.to_string())? ==1;
    if !inserted {
        let existing =
            trace(tx, &identity.attempt_key)?.ok_or("missing action attempt after conflict")?;
        if existing.execution_id != identity.execution_id
            || existing.generation != identity.generation
            || existing.graph != identity.graph
            || existing.action_id != identity.action_id
            || existing.condition_id != condition_id
        {
            return Err("attempt key collision: inconsistent action identity".into());
        }
    }
    Ok(inserted)
}

impl RelayAuthority {
    /// A QUEUED launch is graph-authorized while its exact generation and
    /// lease remain valid. Reserve a *single* attempt key, never overwrite it.
    pub fn reserve_action(
        &mut self,
        identity: &ActionIdentity,
        decision: &Decision,
        condition_id: &str,
        at: &str,
        expected_state: &str,
    ) -> Result<bool, String> {
        if !matches!(expected_state, "QUEUED" | "RUNNING") {
            return Err("invalid action lease state".into());
        }
        if identity.job_id.is_empty()
            || identity.task_id.is_empty()
            || identity.execution_id.is_empty()
            || identity.lease_owner.is_empty()
            || identity.attempt_key.is_empty()
            || identity.graph.is_empty()
            || condition_id.is_empty()
            || identity.attempt < 0
            || identity.attempt != identity.generation
        {
            return Err("invalid action identity".into());
        }
        if !matches!(decision,Decision::Accepted{actions,..} if actions.iter().any(|a|a.id==identity.action_id))
        {
            return Err("action not authorized by graph decision".into());
        }
        if expected_state == "QUEUED"
            && !matches!(decision,Decision::Accepted{source,target,..} if source=="QUEUED" && target=="QUEUED" && identity.action_id=="effect.launchTask")
        {
            return Err("dispatch requires QUEUED -> QUEUED launch effect".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute_batch(LEDGER_TABLE).map_err(|e| e.to_string())?;
        let json: String = tx
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?1",
                [&identity.job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("authoritative job snapshot unavailable")?;
        let job: Value = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        if job.get("pause").is_some_and(|x| !x.is_null()) {
            return Err("paused Job execution is fenced".into());
        }
        let task = job
            .get("tasks")
            .and_then(Value::as_array)
            .and_then(|tasks| {
                tasks
                    .iter()
                    .find(|t| t.get("id").and_then(Value::as_str) == Some(&identity.task_id))
            })
            .ok_or("authoritative task unavailable")?;
        let expiration = task
            .get("leaseExpiresAt")
            .and_then(Value::as_str)
            .ok_or("missing Task lease expiry")?;
        if task.get("state").and_then(Value::as_str) != Some(expected_state)
            || task.get("executionId").and_then(Value::as_str) != Some(&identity.execution_id)
            || task.get("leaseOwner").and_then(Value::as_str) != Some(&identity.lease_owner)
            || task.get("attempt").and_then(Value::as_i64) != Some(identity.attempt)
            || timestamp(expiration)? <= timestamp(at)?
            || !task
                .get("executionHistory")
                .and_then(Value::as_array)
                .is_some_and(|history| {
                    history.iter().any(|entry| {
                        entry.get("id").and_then(Value::as_str) == Some(&identity.execution_id)
                            && entry.get("attempt").and_then(Value::as_i64)
                                == Some(identity.attempt)
                    })
                })
        {
            return Err("stale execution, owner, attempt or lease: action fenced".into());
        }
        let inserted = reserve_authorized_action_tx(&tx, identity, decision, condition_id, at)?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(inserted)
    }
    /// Compare-and-swap the *existing* launch Action reservation to one
    /// concrete launcher BEFORE spawning a process. Exactly one caller can
    /// change the still-Unknown attempt's observedAt from claimedAt to
    /// launchStartedAt. A crashed launcher leaves the attempt claimed for
    /// expiry/recovery; it never gives another caller permission to retry.
    pub fn begin_script_launch(
        &mut self,
        claim: &super::ScriptClaim,
        started_at: &str,
    ) -> Result<(), String> {
        let claimed = timestamp(&claim.claimed_at)?;
        let started = timestamp(started_at)?;
        let expiry = timestamp(&claim.lease_expires_at)?;
        if !(claimed < started && started < expiry) {
            return Err("invalid or expired native Script launch generation".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let job: String = tx
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?1",
                [&claim.job_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("native Script Job missing during launch CAS")?;
        let job: Value = serde_json::from_str(&job).map_err(|e| e.to_string())?;
        let task = job
            .get("tasks")
            .and_then(Value::as_array)
            .and_then(|tasks| tasks.iter().find(|t| t["id"] == claim.task_id))
            .ok_or("native Script Task missing during launch CAS")?;
        if job["state"] != "ACTIVE"
            || job.get("pause").is_some_and(|v| !v.is_null())
            || task["state"] != "QUEUED"
            || !matches!(claim.adapter.as_str(), "script" | "codex")
            || task["adapter"] != claim.adapter
            || (claim.adapter == "codex"
                && (task.get("routing") != claim.routing.as_ref()
                    || task.get("workerSelection") != claim.worker_selection.as_ref()))
            || !task
                .get("executionHistory")
                .and_then(Value::as_array)
                .is_some_and(|history| {
                    history
                        .iter()
                        .any(|v| v["id"] == claim.execution_id && v["attempt"] == claim.attempt)
                })
            || task["executionId"] != claim.execution_id
            || task["leaseOwner"] != claim.owner
            || task["attempt"] != claim.attempt
            || task["leaseExpiresAt"] != claim.lease_expires_at
        {
            return Err("native Script launch lost its authoritative generation".into());
        }
        // No event or Task state can be changed by CAS alone; the graph
        // selected effect.launchTask in the earlier atomic claim transaction.
        let changed=tx.execute("UPDATE workflow_action_trace SET observed_at=?1 WHERE attempt_key=?2 AND execution_id=?3 AND generation=?4 AND action_id='effect.launchTask' AND outcome='Unknown' AND observed_at=?5",
            params![started_at,claim.attempt_key,claim.execution_id,claim.attempt,claim.claimed_at]
        ).map_err(|e|e.to_string())?;
        if changed != 1 {
            return Err("Script launch already started or attempt identity not reserved".into());
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }
    pub fn action_trace(&self, key: &str) -> Result<Option<ActionTrace>, String> {
        let exists:bool=self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='workflow_action_trace')",
            [],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !exists {
            return Ok(None);
        }
        trace(&self.connection, key)
    }
    /// Postcondition facts: Unknown remains reserved, blocking reexecution.
    /// A Verified/Failed trace is immutable even if later facts disagree.
    pub fn verify_action(
        &mut self,
        key: &str,
        observed: Option<bool>,
        at: &str,
    ) -> Result<ActionTrace, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let old = trace(&tx, key)?.ok_or("unreserved action attempt")?;
        if old.outcome == ActionOutcome::Unknown {
            let outcome = match observed {
                Some(true) => ActionOutcome::Verified,
                Some(false) => ActionOutcome::Failed,
                None => ActionOutcome::Unknown,
            };
            tx.execute("UPDATE workflow_action_trace SET outcome=?1,observed_at=?2 WHERE attempt_key=?3 AND outcome='Unknown'",
                params![outcome.as_str(),at,key]).map_err(|e|e.to_string())?;
        }
        let result = trace(&tx, key)?.ok_or("action trace lost")?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    use crate::graph::{ActionDecision, GraphInput};
    use serde_json::json;
    fn identity() -> ActionIdentity {
        ActionIdentity {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "exec1".into(),
            lease_owner: "relayd-123".into(),
            attempt: 1,
            generation: 1,
            graph: "task-lifecycle.mmd".into(),
            action_id: "effect.launchTask".into(),
            attempt_key: "91/101/exec1/launch".into(),
        }
    }
    fn decision() -> Decision {
        Decision::Accepted {
            accepted: true,
            source: "QUEUED".into(),
            target: "QUEUED".into(),
            actions: vec![ActionDecision {
                id: "effect.launchTask".into(),
                input: GraphInput {
                    transport: "event".into(),
                    id: "dispatch".into(),
                    payload: json!({}),
                },
                emitted_events: vec![],
            }],
        }
    }
    #[test]
    fn graph_authorized_execution_fencing_and_receipt_verification() {
        let (_dir, path) = setup();
        let mut authority = RelayAuthority::open_existing(&path).unwrap();
        let id = identity();
        assert!(authority
            .reserve_action(
                &id,
                &decision(),
                "worker.started",
                "2026-11-13T20:00:01Z",
                "QUEUED"
            )
            .is_err());
        authority
            .commit_job("91", "2026-11-13T20:00:01.000Z", |job| {
                let mut next = job.clone();
                next["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                next["tasks"][0]["executionId"] = json!("exec1");
                next["tasks"][0]["leaseOwner"] = json!("relayd-123");
                next["tasks"][0]["leaseExpiresAt"] = json!("2026-11-13T20:01:00.000Z");
                next["tasks"][0]["attempt"] = json!(1);
                next["tasks"][0]["executionHistory"] =
                    json!([{"id":"exec1","attempt":1,"startedAt":"2026-11-13T20:00:01.000Z"}]);
                Ok((next, vec![]))
            })
            .unwrap();
        assert!(authority
            .reserve_action(
                &id,
                &decision(),
                "worker.started",
                "2026-11-13T20:00:02Z",
                "QUEUED"
            )
            .unwrap());
        assert!(!authority
            .reserve_action(
                &id,
                &decision(),
                "worker.started",
                "2026-11-13T20:00:02Z",
                "QUEUED"
            )
            .unwrap());
        let mut forged = id.clone();
        forged.execution_id = "exec2".into();
        assert!(authority
            .reserve_action(
                &forged,
                &decision(),
                "worker.started",
                "2026-11-13T20:00:02Z",
                "QUEUED"
            )
            .is_err());
        forged = id.clone();
        forged.action_id = "effect.other".into();
        assert!(authority
            .reserve_action(
                &forged,
                &decision(),
                "worker.started",
                "2026-11-13T20:00:02Z",
                "QUEUED"
            )
            .is_err());
        assert!(authority
            .reserve_action(
                &id,
                &decision(),
                "worker.started",
                "2026-11-13T20:02:00Z",
                "QUEUED"
            )
            .is_err());
        assert_eq!(
            authority
                .verify_action(&id.attempt_key, None, "2026-11-13T20:00:03Z")
                .unwrap()
                .outcome,
            ActionOutcome::Unknown
        );
        assert_eq!(
            authority
                .verify_action(&id.attempt_key, Some(true), "2026-11-13T20:00:04Z")
                .unwrap()
                .outcome,
            ActionOutcome::Verified
        );
        assert_eq!(
            authority
                .verify_action(&id.attempt_key, Some(false), "2026-11-13T20:00:05Z")
                .unwrap()
                .outcome,
            ActionOutcome::Verified
        );
    }
}
