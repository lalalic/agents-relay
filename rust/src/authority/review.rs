//! Host-neutral interactive Review decision durability. This ports the
//! `host_invocation_*` SQLite contract; it never emits an approval simply
//! because a delivery receipt arrived. The canonical review Mermaid Graph
//! selects the only accepted transition.
use super::RelayAuthority;
use crate::graph::{Decision, Graph, GraphInput};
use chrono::{DateTime, Duration};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

const HOST_TABLES: &str = r#"
CREATE TABLE IF NOT EXISTS host_invocation_event (
  job_id TEXT NOT NULL,task_id TEXT NOT NULL,event_id TEXT NOT NULL,
  invocation_id TEXT NOT NULL,execution_id TEXT NOT NULL,revision TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
  outcome TEXT NOT NULL CHECK(outcome IN ('accepted','duplicate','stale','ignored')),
  fingerprint TEXT NOT NULL,received_at TEXT NOT NULL,
  PRIMARY KEY(job_id,task_id,event_id)
);
CREATE TABLE IF NOT EXISTS host_invocation_decision (
  job_id TEXT NOT NULL,task_id TEXT NOT NULL,invocation_id TEXT NOT NULL,
  execution_id TEXT NOT NULL,revision TEXT NOT NULL,
  decision TEXT NOT NULL CHECK(decision IN ('approved','changes_requested')),
  feedback TEXT,fingerprint TEXT NOT NULL,event_id TEXT NOT NULL,decided_at TEXT NOT NULL,
  PRIMARY KEY(job_id,task_id,invocation_id),UNIQUE(job_id,task_id,event_id)
);"#;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewDelivery {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub invocation_id: String,
    pub revision: String,
    pub decision: String,
    pub feedback: Option<String>,
    pub comments: Option<Vec<Value>>,
    pub idempotency_key: Option<String>,
    pub event_id: String,
    pub delivered_at: String,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReviewReceipt {
    pub outcome: String,
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub invocation: Option<Value>,
}

// Struct serialization is field-ordered, matching the deliberately ordered
// JSON.stringify object in interactiveDecisionFingerprint() (TypeScript).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FingerprintFields<'a> {
    job_id: &'a str,
    task_id: &'a str,
    execution_id: &'a str,
    invocation_id: &'a str,
    revision: &'a str,
    decision: &'a str,
    feedback: Option<&'a str>,
    comments: Option<&'a [Value]>,
}

pub fn review_fingerprint(delivery: &ReviewDelivery) -> Result<String, String> {
    let fields = FingerprintFields {
        job_id: &delivery.job_id,
        task_id: &delivery.task_id,
        execution_id: &delivery.execution_id,
        invocation_id: &delivery.invocation_id,
        revision: &delivery.revision,
        decision: &delivery.decision,
        feedback: delivery.feedback.as_deref(),
        comments: delivery.comments.as_deref(),
    };
    let serialized = serde_json::to_vec(&fields).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(serialized)))
}

fn record_event(
    tx: &rusqlite::Transaction<'_>,
    delivery: &ReviewDelivery,
    status: &str,
    fingerprint: &str,
) -> Result<(), String> {
    tx.execute(
        "INSERT OR IGNORE INTO host_invocation_event(job_id,task_id,event_id,invocation_id,execution_id,revision,decision,outcome,fingerprint,received_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![delivery.job_id, delivery.task_id, delivery.event_id,
            delivery.invocation_id, delivery.execution_id, delivery.revision,
            delivery.decision, status, fingerprint, delivery.delivered_at],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

fn validate_delivery(delivery: &ReviewDelivery) -> Result<(), String> {
    if delivery.job_id.is_empty()
        || delivery.task_id.is_empty()
        || delivery.execution_id.is_empty()
        || delivery.invocation_id.is_empty()
        || delivery.revision.is_empty()
        || delivery.event_id.is_empty()
    {
        return Err("incomplete interactive Review identity".into());
    }
    if !matches!(delivery.decision.as_str(), "approved" | "changes_requested") {
        return Err("invalid interactive Review decision".into());
    }
    DateTime::parse_from_rfc3339(&delivery.delivered_at)
        .map_err(|_| "invalid Review delivery timestamp")?;
    if let Some(comments) = &delivery.comments {
        if comments.len() > 100
            || comments
                .iter()
                .any(|item| !item.is_object() || !item.get("text").is_some_and(Value::is_string))
        {
            return Err("invalid interactive Review comments".into());
        }
    }
    Ok(())
}

impl RelayAuthority {
    pub fn accept_review_decision(
        &mut self,
        delivery: &ReviewDelivery,
    ) -> Result<ReviewReceipt, String> {
        validate_delivery(delivery)?;
        let fingerprint = review_fingerprint(delivery)?;
        let graph = Graph::parse(include_str!("../../../workflow/interactive-invocation.mmd"))?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute_batch(HOST_TABLES).map_err(|e| e.to_string())?;
        let existing: Option<String> = tx.query_row(
            "SELECT fingerprint FROM host_invocation_decision WHERE job_id=?1 AND task_id=?2 AND invocation_id=?3",
            params![delivery.job_id, delivery.task_id, delivery.invocation_id], |row| row.get(0),
        ).optional().map_err(|e| e.to_string())?;
        if let Some(existing_fingerprint) = existing {
            let duplicate = existing_fingerprint == fingerprint;
            let outcome = if duplicate { "duplicate" } else { "stale" };
            record_event(&tx, delivery, outcome, &fingerprint)?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(ReviewReceipt {
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
        let row: Option<(String, String)> = tx
            .query_row(
                "SELECT json,updated_at FROM job_snapshot WHERE job_id=?1",
                [&delivery.job_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut job: Value = match row.as_ref() {
            Some((encoded, _)) => serde_json::from_str(encoded).map_err(|e| e.to_string())?,
            None => Value::Null,
        };
        let bound = job.get("state").and_then(Value::as_str) == Some("ACTIVE")
            && job
                .get("tasks")
                .and_then(Value::as_array)
                .and_then(|tasks| {
                    tasks.iter().find(|task| {
                        task.get("id").and_then(Value::as_str) == Some(&delivery.task_id)
                    })
                })
                .is_some_and(|task| {
                    let state = task.get("state").and_then(Value::as_str);
                    let inv = task.get("interactiveInvocation");
                    matches!(state, Some("RUNNING" | "AWAITING_DECISION"))
                        && (task.get("executionId").and_then(Value::as_str)
                            == Some(&delivery.execution_id)
                            || state == Some("AWAITING_DECISION"))
                        && inv
                            .and_then(|v| v.get("executionId"))
                            .and_then(Value::as_str)
                            == Some(&delivery.execution_id)
                        && inv
                            .and_then(|v| v.get("invocationId"))
                            .and_then(Value::as_str)
                            == Some(&delivery.invocation_id)
                        && inv.and_then(|v| v.get("revision")).and_then(Value::as_str)
                            == Some(&delivery.revision)
                        && inv.and_then(|v| v.get("status")).and_then(Value::as_str)
                            == Some("awaiting_decision")
                });
        if !bound {
            // There is no event-only Review path: its eligibility is always
            // false in the current TypeScript contract.
            record_event(&tx, delivery, "stale", &fingerprint)?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(ReviewReceipt {
                outcome: "stale".into(),
                reason: "invocation_or_revision_mismatch".into(),
                invocation: None,
            });
        }
        let facts = HashMap::from([
            ("currentInvocation".to_string(), true),
            ("awaitingDecision".to_string(), true),
            ("currentRevision".to_string(), true),
            ("duplicateDelivery".to_string(), false),
            ("eventOnlyCurrentExecution".to_string(), false),
            ("eventOnlyNextRevision".to_string(), false),
            (
                "changesRequested".to_string(),
                delivery.decision == "changes_requested",
            ),
        ]);
        let decision = graph.decide(
            "awaiting_decision",
            GraphInput {
                transport: "event".into(),
                id: "task.interactive_decision".into(),
                payload: json!({}),
            },
            &facts,
        )?;
        let expected = if delivery.decision == "approved" {
            "approved"
        } else {
            "changes_requested"
        };
        let Decision::Accepted {
            target, actions, ..
        } = decision
        else {
            return Err("interactive Graph rejected bound Review decision".into());
        };
        if target != expected
            || !actions
                .iter()
                .any(|action| action.id == "interactive.wakeWorker")
        {
            return Err("interactive Graph returned unexpected effects".into());
        }
        let observed_at = &delivery.delivered_at;
        tx.execute(
            "INSERT INTO host_invocation_decision(job_id,task_id,invocation_id,execution_id,revision,decision,feedback,fingerprint,event_id,decided_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![delivery.job_id, delivery.task_id, delivery.invocation_id,
                delivery.execution_id, delivery.revision, delivery.decision, delivery.feedback,
                fingerprint, delivery.event_id, observed_at],
        ).map_err(|e| e.to_string())?;
        record_event(&tx, delivery, "accepted", &fingerprint)?;
        let tasks = job
            .get_mut("tasks")
            .and_then(Value::as_array_mut)
            .ok_or("Job tasks missing")?;
        let current = tasks
            .iter_mut()
            .find(|task| task.get("id").and_then(Value::as_str) == Some(&delivery.task_id))
            .ok_or("bound Task disappeared")?;
        let original_invocation = current
            .get("interactiveInvocation")
            .ok_or("bound invocation disappeared")?;
        let bound_at = original_invocation
            .get("boundAt")
            .and_then(Value::as_str)
            .ok_or("invocation missing boundAt")?
            .to_owned();
        let mut decided = json!({
            "invocationId": delivery.invocation_id, "revision": delivery.revision,
            "executionId": delivery.execution_id, "status": delivery.decision,
            "boundAt": bound_at, "decidedAt": delivery.delivered_at,
        });
        if let Some(feedback) = &delivery.feedback {
            decided["feedback"] = json!(feedback);
        }
        if let Some(comments) = &delivery.comments {
            decided["comments"] = json!(comments);
        }
        if let Some(key) = &delivery.idempotency_key {
            decided["idempotencyKey"] = json!(key);
        }
        current["interactiveInvocation"] = decided.clone();
        let old = row.as_ref().ok_or("Job snapshot lost")?.1.as_str();
        // TypeScript increments Job.updatedAt by 1ms when the receipt's
        // deliveredAt is not newer than its previous durable timestamp.
        let previous =
            DateTime::parse_from_rfc3339(job["updatedAt"].as_str().ok_or("missing Job updatedAt")?)
                .map_err(|_| "bad Job updatedAt")?;
        let candidate =
            DateTime::parse_from_rfc3339(observed_at).map_err(|_| "bad Review timestamp")?;
        let next = if candidate > previous {
            candidate
        } else {
            previous + Duration::milliseconds(1)
        };
        job["updatedAt"] = json!(next.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        // Keep snapshot column and JSON version in the same transaction. The
        // column is the receipt time, matching native TS writeJobSnapshot.
        let _ = old;
        tx.execute(
            "UPDATE job_snapshot SET json=?1, updated_at=?2 WHERE job_id=?3",
            params![
                serde_json::to_string(&job).map_err(|e| e.to_string())?,
                observed_at,
                delivery.job_id
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(ReviewReceipt {
            outcome: "accepted".into(),
            reason: "latest_interactive_decision".into(),
            invocation: Some(decided),
        })
    }
}

mod resume;
pub use resume::ReviewResume;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    #[test]
    fn review_approve_is_atomic_and_duplicate_does_not_wake_again() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01.000Z", |previous| {
                let mut job = previous.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                job["tasks"][0]["state"] = json!("AWAITING_DECISION");
                job["tasks"][0]["executionId"] = Value::Null;
                job["tasks"][0]["interactiveInvocation"] = json!({
                    "invocationId":"exec1","executionId":"exec1","revision":"exec1",
                    "status":"awaiting_decision","boundAt":"2026-11-13T20:00:01.000Z"
                });
                Ok((job, vec![]))
            })
            .unwrap();
        let delivery = ReviewDelivery {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "exec1".into(),
            invocation_id: "exec1".into(),
            revision: "exec1".into(),
            decision: "approved".into(),
            feedback: Some("fine".into()),
            comments: Some(vec![json!({"text":"ok"})]),
            idempotency_key: Some("test-key".into()),
            event_id: "event-1".into(),
            delivered_at: "2026-11-13T20:00:02.000Z".into(),
        };
        let accepted = store.accept_review_decision(&delivery).unwrap();
        assert_eq!(accepted.outcome, "accepted");
        assert_eq!(accepted.invocation.unwrap()["status"], "approved");
        assert_eq!(
            store.accept_review_decision(&delivery).unwrap().outcome,
            "duplicate"
        );
        let mut changed = delivery.clone();
        changed.decision = "changes_requested".into();
        changed.event_id = "event-2".into();
        assert_eq!(
            store.accept_review_decision(&changed).unwrap().outcome,
            "stale"
        );
        assert_eq!(
            store.read_job("91").unwrap().unwrap()["tasks"][0]["interactiveInvocation"]["status"],
            "approved"
        );
    }
    #[test]
    fn unbound_and_stale_decisions_are_not_approved() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        let delivery = ReviewDelivery {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "exec1".into(),
            invocation_id: "exec1".into(),
            revision: "exec1".into(),
            decision: "approved".into(),
            feedback: None,
            comments: None,
            idempotency_key: None,
            event_id: "stale-event".into(),
            delivered_at: "2026-11-13T20:00:01.000Z".into(),
        };
        assert_eq!(
            store.accept_review_decision(&delivery).unwrap().outcome,
            "stale"
        );
        assert!(store.read_job("91").unwrap().unwrap()["tasks"][0]
            .get("interactiveInvocation")
            .is_none());
    }
}
