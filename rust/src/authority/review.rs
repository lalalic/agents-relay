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
    pub content_hash: Option<String>,
    pub revision_id: Option<String>,
    pub preview_id: Option<String>,
    pub request_id: Option<String>,
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
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventOnlyFingerprintFields<'a> {
    job_id: &'a str,
    task_id: &'a str,
    execution_id: &'a str,
    invocation_id: &'a str,
    revision: &'a str,
    decision: &'a str,
    feedback: Option<&'a str>,
    comments: Option<&'a [Value]>,
    content_hash: Option<&'a str>,
    revision_id: Option<&'a str>,
    preview_id: Option<&'a str>,
    request_id: Option<&'a str>,
    idempotency_key: Option<&'a str>,
}

pub fn review_fingerprint(delivery: &ReviewDelivery) -> Result<String, String> {
    let serialized = if event_only_eligible(delivery) {
        serde_json::to_vec(&EventOnlyFingerprintFields {
            job_id: &delivery.job_id,
            task_id: &delivery.task_id,
            execution_id: &delivery.execution_id,
            invocation_id: &delivery.invocation_id,
            revision: &delivery.revision,
            decision: &delivery.decision,
            feedback: delivery.feedback.as_deref(),
            comments: delivery.comments.as_deref(),
            content_hash: delivery.content_hash.as_deref(),
            revision_id: delivery.revision_id.as_deref(),
            preview_id: delivery.preview_id.as_deref(),
            request_id: delivery.request_id.as_deref(),
            idempotency_key: delivery.idempotency_key.as_deref(),
        })
    } else {
        serde_json::to_vec(&FingerprintFields {
            job_id: &delivery.job_id,
            task_id: &delivery.task_id,
            execution_id: &delivery.execution_id,
            invocation_id: &delivery.invocation_id,
            revision: &delivery.revision,
            decision: &delivery.decision,
            feedback: delivery.feedback.as_deref(),
            comments: delivery.comments.as_deref(),
        })
    }
    .map_err(|e| e.to_string())?;
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
    let event_only_fields = delivery.content_hash.is_some()
        || delivery.revision_id.is_some()
        || delivery.preview_id.is_some()
        || delivery.request_id.is_some();
    if event_only_fields {
        let hash = delivery
            .content_hash
            .as_deref()
            .ok_or("event-only Review contentHash required")?;
        if hash.len() != 64
            || !hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || hash != delivery.revision
            || delivery.revision_id.as_deref().is_none_or(str::is_empty)
            || delivery.request_id.as_deref().is_none_or(str::is_empty)
            || delivery
                .idempotency_key
                .as_deref()
                .is_none_or(str::is_empty)
            || delivery.feedback.is_none()
            || delivery.preview_id.as_deref().is_some_and(str::is_empty)
        {
            return Err("incomplete or inconsistent event-only Review identity".into());
        }
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

fn event_only_eligible(delivery: &ReviewDelivery) -> bool {
    delivery.content_hash.as_deref().is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && hash == delivery.revision
            && delivery
                .revision_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && delivery
                .request_id
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && delivery
                .idempotency_key
                .as_deref()
                .is_some_and(|value| !value.is_empty())
            && delivery
                .preview_id
                .as_deref()
                .is_none_or(|value| !value.is_empty())
    })
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
        let current_task = job
            .get("tasks")
            .and_then(Value::as_array)
            .and_then(|tasks| {
                tasks
                    .iter()
                    .find(|task| task.get("id").and_then(Value::as_str) == Some(&delivery.task_id))
            });
        let invocation = current_task.and_then(|task| task.get("interactiveInvocation"));
        let task_state = current_task
            .and_then(|task| task.get("state"))
            .and_then(Value::as_str);
        let running_current = job.get("state").and_then(Value::as_str) == Some("ACTIVE")
            && task_state == Some("RUNNING")
            && current_task
                .and_then(|task| task.get("executionId"))
                .and_then(Value::as_str)
                == Some(&delivery.execution_id);
        let bound = job.get("state").and_then(Value::as_str) == Some("ACTIVE")
            && current_task.is_some_and(|task| {
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
        let seen_revision: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM host_invocation_decision WHERE job_id=?1 AND task_id=?2 AND execution_id=?3 AND revision=?4)",
                params![delivery.job_id, delivery.task_id, delivery.execution_id, delivery.revision],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        let event_only_current = running_current
            && invocation.is_none()
            && !seen_revision
            && event_only_eligible(delivery);
        let event_only_next = running_current
            && !seen_revision
            && event_only_eligible(delivery)
            && invocation.is_some_and(|inv| {
                inv.get("status").and_then(Value::as_str) == Some("changes_requested")
                    && inv.get("executionId").and_then(Value::as_str)
                        == Some(&delivery.execution_id)
                    && inv.get("revision").and_then(Value::as_str) != Some(&delivery.revision)
            });
        if !bound && !event_only_current && !event_only_next {
            record_event(&tx, delivery, "stale", &fingerprint)?;
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(ReviewReceipt {
                outcome: "stale".into(),
                reason: "invocation_or_revision_mismatch".into(),
                invocation: None,
            });
        }
        let start_state = invocation
            .and_then(|value| value.get("status"))
            .and_then(Value::as_str)
            .filter(|status| matches!(*status, "awaiting_decision" | "changes_requested"))
            .unwrap_or("awaiting_decision");
        let facts = HashMap::from([
            ("currentInvocation".to_string(), bound),
            ("awaitingDecision".to_string(), bound),
            ("currentRevision".to_string(), bound),
            ("duplicateDelivery".to_string(), false),
            ("eventOnlyCurrentExecution".to_string(), event_only_current),
            ("eventOnlyNextRevision".to_string(), event_only_next),
            (
                "changesRequested".to_string(),
                delivery.decision == "changes_requested",
            ),
        ]);
        let decision = graph.decide(
            start_state,
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
        let bound_at = current
            .get("interactiveInvocation")
            .and_then(|invocation| invocation.get("boundAt"))
            .and_then(Value::as_str)
            .unwrap_or(&delivery.delivered_at)
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
        if let Some(hash) = &delivery.content_hash {
            decided["contentHash"] = json!(hash);
        }
        if let Some(revision_id) = &delivery.revision_id {
            decided["revisionId"] = json!(revision_id);
        }
        if let Some(preview_id) = &delivery.preview_id {
            decided["previewId"] = json!(preview_id);
        }
        if let Some(request_id) = &delivery.request_id {
            decided["requestId"] = json!(request_id);
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
            content_hash: None,
            revision_id: None,
            preview_id: None,
            request_id: None,
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
    fn vlog_producer_review_changes_then_approves_same_task_without_fake_completion() {
        // This is an isolated Rust authority fixture. A real Neo Mobile ACK
        // is intentionally NOT represented as an approval; only an accepted
        // decision event may requeue the original Producer Task.
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01.000Z", |previous| {
                let mut job = previous.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                let task = &mut job["tasks"][0];
                task["state"] = json!("AWAITING_DECISION");
                task["executionId"] = Value::Null;
                task["adapter"] = json!("script");
                task["dagNode"] = json!({"executor":"script","nodeId":"producer"});
                task["input"] = json!(json!({
                    "stage":"vlog-producer",
                    "run":"runs/2026-11-14-rust-review-e2e-clean",
                    "video":"output/video.mp4"
                })
                .to_string());
                task["maxAttempts"] = json!(2);
                task["interactiveInvocation"] = json!({
                    "invocationId":"producer-exec-1","executionId":"producer-exec-1",
                    "revision":"producer-exec-1","status":"awaiting_decision",
                    "boundAt":"2026-11-13T20:00:01.000Z"
                });
                Ok((job, vec![]))
            })
            .unwrap();
        let change = ReviewDelivery {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "producer-exec-1".into(),
            invocation_id: "producer-exec-1".into(),
            revision: "producer-exec-1".into(),
            content_hash: None,
            revision_id: None,
            preview_id: None,
            request_id: None,
            decision: "changes_requested".into(),
            feedback: Some("前两秒太长；请提前出现马的镜头".into()),
            comments: Some(vec![json!({"text":"提前出现马","sceneName":"Horse-Look"})]),
            idempotency_key: Some("mobile-round-1".into()),
            event_id: "mobile-request-changes".into(),
            delivered_at: "2026-11-13T20:00:02.000Z".into(),
        };
        let accepted = store.accept_review_decision(&change).unwrap();
        assert_eq!(accepted.outcome, "accepted");
        assert_eq!(accepted.invocation.unwrap()["status"], "changes_requested");
        let before_resume = store.read_job("91").unwrap().unwrap();
        assert_eq!(before_resume["tasks"][0]["state"], "AWAITING_DECISION");
        assert_eq!(before_resume["tasks"][0]["adapter"], "script");
        assert_eq!(
            store.accept_review_decision(&change).unwrap().outcome,
            "duplicate"
        );
        let first = store
            .resume_review_task("91", "101", "2026-11-13T20:00:03.000Z")
            .unwrap();
        assert_eq!(
            (
                first.status.as_str(),
                first.state.as_str(),
                first.adapter.as_str()
            ),
            ("changes_requested", "QUEUED", "codex")
        );
        let revised = store.read_job("91").unwrap().unwrap();
        assert_eq!(revised["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(revised["tasks"][0]["id"], "101");
        assert_eq!(revised["tasks"][0]["adapter"], "codex");
        let task_input: Value =
            serde_json::from_str(revised["tasks"][0]["input"].as_str().unwrap()).unwrap();
        assert_eq!(task_input["reviewRevision"]["status"], "changes_requested");
        assert_eq!(
            task_input["reviewRevision"]["feedback"],
            "前两秒太长；请提前出现马的镜头"
        );
        assert_eq!(
            task_input["reviewRevision"]["comments"][0]["sceneName"],
            "Horse-Look"
        );
        assert_eq!(revised["tasks"][0]["comments"].as_array().unwrap().len(), 1);
        assert_eq!(revised["tasks"][0]["state"], "QUEUED");
        assert_eq!(revised["state"], "ACTIVE");
        let mut late_approve = change.clone();
        late_approve.decision = "approved".into();
        late_approve.event_id = "stale-approve-round-1".into();
        assert_eq!(
            store.accept_review_decision(&late_approve).unwrap().outcome,
            "stale"
        );

        // An actual revision Worker must create a fresh execution-bound
        // invocation before the second decision. The test owns only setup;
        // it never infers approval from notification or media compilation.
        store
            .commit_job("91", "2026-11-13T20:00:04.000Z", |previous| {
                let mut next = previous.clone();
                next["updatedAt"] = json!("2026-11-13T20:00:04.000Z");
                let task = &mut next["tasks"][0];
                task["state"] = json!("AWAITING_DECISION");
                task["executionId"] = Value::Null;
                task["interactiveInvocation"] = json!({
                    "invocationId":"producer-exec-2","executionId":"producer-exec-2",
                    "revision":"producer-exec-2","status":"awaiting_decision",
                    "boundAt":"2026-11-13T20:00:04.000Z"
                });
                Ok((next, vec![]))
            })
            .unwrap();
        let approved = ReviewDelivery {
            execution_id: "producer-exec-2".into(),
            invocation_id: "producer-exec-2".into(),
            revision: "producer-exec-2".into(),
            decision: "approved".into(),
            feedback: None,
            comments: None,
            idempotency_key: Some("mobile-round-2".into()),
            event_id: "mobile-approved-round-2".into(),
            delivered_at: "2026-11-13T20:00:05.000Z".into(),
            ..change.clone()
        };
        assert_eq!(
            store.accept_review_decision(&approved).unwrap().outcome,
            "accepted"
        );
        let resumed = store
            .resume_review_task("91", "101", "2026-11-13T20:00:06.000Z")
            .unwrap();
        assert_eq!(
            (
                resumed.status.as_str(),
                resumed.state.as_str(),
                resumed.adapter.as_str()
            ),
            ("approved", "QUEUED", "script")
        );
        assert!(store
            .resume_review_task("91", "101", "2026-11-13T20:00:07.000Z")
            .is_err());
        let finished = store.read_job("91").unwrap().unwrap();
        assert_eq!(finished["tasks"].as_array().unwrap().len(), 1);
        assert_eq!(finished["tasks"][0]["state"], "QUEUED");
        assert_eq!(
            finished["tasks"][0]["interactiveInvocation"]["status"],
            "approved"
        );
        assert_eq!(
            finished["state"], "ACTIVE",
            "Review is not Task/Job completion"
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
            content_hash: None,
            revision_id: None,
            preview_id: None,
            request_id: None,
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

    #[test]
    fn event_only_review_requires_content_identity_deduplicates_after_restart_and_never_completes_task(
    ) {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        store
            .commit_job("91", "2026-11-13T20:00:01.000Z", |previous| {
                let mut job = previous.clone();
                job["updatedAt"] = json!("2026-11-13T20:00:01.000Z");
                job["tasks"][0]["state"] = json!("RUNNING");
                job["tasks"][0]["executionId"] = json!("exec1");
                Ok((job, vec![]))
            })
            .unwrap();
        let delivery = ReviewDelivery {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "exec1".into(),
            invocation_id: "review-invocation-1".into(),
            revision: "a".repeat(64),
            content_hash: Some("a".repeat(64)),
            revision_id: Some("preview-revision-1".into()),
            preview_id: None,
            request_id: Some("review-request-1".into()),
            decision: "changes_requested".into(),
            feedback: Some("revise".into()),
            comments: None,
            idempotency_key: Some("delivery-1".into()),
            event_id: "event-only-1".into(),
            delivered_at: "2026-11-13T20:00:02.000Z".into(),
        };
        assert_eq!(
            review_fingerprint(&delivery).unwrap(),
            "7be78ea266bcfd56c94acb0b9c389d11d01e0c8163221f20bc6ee4ef19af44e4",
            "event-only fingerprint must match the Node JSON.stringify contract"
        );
        let accepted = store.accept_review_decision(&delivery).unwrap();
        assert_eq!(accepted.outcome, "accepted");
        let job = store.read_job("91").unwrap().unwrap();
        assert_eq!(job["state"], "ACTIVE");
        assert_eq!(job["tasks"][0]["state"], "RUNNING");
        assert_eq!(job["tasks"][0]["executionId"], "exec1");
        assert_eq!(
            job["tasks"][0]["interactiveInvocation"]["status"],
            "changes_requested"
        );
        assert_eq!(
            job["tasks"][0]["interactiveInvocation"]["contentHash"],
            "a".repeat(64)
        );
        assert!(
            store
                .resume_review_task("91", "101", "2026-11-13T20:00:03.000Z")
                .is_err(),
            "an event-only decision is consumed by the active execution, not requeued by receipt"
        );
        drop(store);

        let mut restarted = RelayAuthority::open_existing(&path).unwrap();
        assert_eq!(
            restarted.accept_review_decision(&delivery).unwrap().outcome,
            "duplicate"
        );
        let mut replay = delivery.clone();
        replay.invocation_id = "different-invocation".into();
        replay.event_id = "event-only-replayed-revision".into();
        replay.idempotency_key = Some("delivery-2".into());
        assert_eq!(
            restarted.accept_review_decision(&replay).unwrap().outcome,
            "stale",
            "a new invocation cannot replay an already decided content revision"
        );
        let mut revised = delivery.clone();
        revised.invocation_id = "review-invocation-2".into();
        revised.revision = "b".repeat(64);
        revised.content_hash = Some("b".repeat(64));
        revised.revision_id = Some("preview-revision-2".into());
        revised.request_id = Some("review-request-2".into());
        revised.idempotency_key = Some("delivery-3".into());
        revised.event_id = "event-only-2".into();
        revised.decision = "approved".into();
        revised.feedback = Some(String::new());
        assert_eq!(
            restarted.accept_review_decision(&revised).unwrap().outcome,
            "accepted"
        );
        let revised_job = restarted.read_job("91").unwrap().unwrap();
        assert_eq!(revised_job["tasks"][0]["state"], "RUNNING");
        assert_eq!(revised_job["tasks"][0]["executionId"], "exec1");
        assert_eq!(
            revised_job["tasks"][0]["interactiveInvocation"]["status"],
            "approved"
        );
        let mut stale_execution = revised.clone();
        stale_execution.execution_id = "old-execution".into();
        stale_execution.invocation_id = "old-review".into();
        stale_execution.revision = "c".repeat(64);
        stale_execution.content_hash = Some("c".repeat(64));
        stale_execution.revision_id = Some("preview-revision-3".into());
        stale_execution.request_id = Some("review-request-3".into());
        stale_execution.idempotency_key = Some("delivery-4".into());
        stale_execution.event_id = "stale-execution".into();
        assert_eq!(
            restarted
                .accept_review_decision(&stale_execution)
                .unwrap()
                .outcome,
            "stale"
        );
        let mut incomplete = delivery.clone();
        incomplete.request_id = None;
        assert!(restarted.accept_review_decision(&incomplete).is_err());
        incomplete = delivery.clone();
        incomplete.feedback = None;
        assert!(restarted.accept_review_decision(&incomplete).is_err());
    }
}
