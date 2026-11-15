//! Durable binding and delivery-failure actions for host-owned Review Preview.
//! Authentication belongs to the host/control adapter; these effects recheck
//! its Job, Task and execution binding in the SQLite writer transaction.
use super::*;
use crate::lifecycle::apply_pure_task_actions;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveReviewBinding {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub reused: bool,
    pub invocation: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InteractiveReviewFailure {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub requeued: bool,
}

impl RelayAuthority {
    /// Bind exactly one host-owned Preview invocation to the current Task
    /// execution. The caller must authenticate the host before requesting this
    /// effect; the durable identity is still checked under SQLite's writer lock.
    pub fn begin_interactive_review(
        &mut self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
        at: &str,
    ) -> Result<InteractiveReviewBinding, String> {
        validate_identity(job_id, task_id, execution_id)?;
        let mut binding = None;
        self.commit_job_with_tx(job_id, at, |_, prior| {
            if prior["state"] != "ACTIVE"
                || prior.get("pause").is_some_and(|value| !value.is_null())
            {
                return Err("interactive Preview requires an active, unpaused Job".into());
            }
            let mut next = prior.clone();
            let task = next["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
                .ok_or("interactive Preview Task missing")?;
            if task["state"] != "RUNNING" || task["executionId"] != execution_id {
                return Err(
                    "interactive Preview requires the current RUNNING Task execution".into(),
                );
            }
            let existing = task
                .get("interactiveInvocation")
                .filter(|value| !value.is_null());
            let reused = existing.is_some_and(|invocation| {
                invocation["status"] == "awaiting_decision"
                    && invocation["executionId"] == execution_id
            });
            if reused {
                let invocation = existing.unwrap().clone();
                next["updatedAt"] = json!(at);
                binding = Some(InteractiveReviewBinding {
                    job_id: job_id.into(),
                    task_id: task_id.into(),
                    execution_id: execution_id.into(),
                    reused,
                    invocation,
                });
                return Ok((next, vec![]));
            }
            if existing.is_some_and(|invocation| {
                invocation["executionId"] == execution_id
                    || !matches!(
                        invocation["status"].as_str(),
                        Some("changes_requested" | "awaiting_decision" | "approved")
                    )
            }) {
                return Err("conflicting interactive Preview invocation on Task".into());
            }
            let invocation = json!({
                "invocationId":execution_id,
                "executionId":execution_id,
                "revision":execution_id,
                "status":"awaiting_decision",
                "boundAt":at
            });
            task["interactiveInvocation"] = invocation.clone();
            task["updatedAt"] = json!(at);
            next["updatedAt"] = json!(at);
            binding = Some(InteractiveReviewBinding {
                job_id: job_id.into(),
                task_id: task_id.into(),
                execution_id: execution_id.into(),
                reused,
                invocation,
            });
            Ok((next, vec![]))
        })?;
        binding.ok_or_else(|| "interactive Preview binding did not commit".into())
    }

    /// Clear a Preview that the host could not deliver. A Task already moved
    /// to AWAITING_DECISION is resumed only through the Task Lifecycle Graph.
    pub fn fail_interactive_review(
        &mut self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
        reason: &str,
        at: &str,
    ) -> Result<InteractiveReviewFailure, String> {
        validate_identity(job_id, task_id, execution_id)?;
        if reason.trim().is_empty() {
            return Err("interactive Preview failure reason is required".into());
        }
        let snapshot = self
            .read_job(job_id)?
            .ok_or("interactive Preview Job missing")?;
        let current_task = snapshot["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id));
        let eligible = current_task.is_some_and(|task| {
            task["interactiveInvocation"]["executionId"] == execution_id
                && task["interactiveInvocation"]["status"] == "awaiting_decision"
                && (task["executionId"] == execution_id || task["state"] == "AWAITING_DECISION")
        });
        if !eligible {
            return Ok(InteractiveReviewFailure {
                job_id: job_id.into(),
                task_id: task_id.into(),
                execution_id: execution_id.into(),
                requeued: false,
            });
        }
        let mut requeued = false;
        let committed = self.commit_job_with_tx(job_id, at, |_, prior| {
            let mut next = prior.clone();
            let task = next["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
                .ok_or("interactive Preview Task missing")?;
            let invocation = task.get("interactiveInvocation").filter(|value| !value.is_null());
            if task["executionId"] != execution_id
                && !(task["state"] == "AWAITING_DECISION"
                    && invocation.is_some_and(|value| value["executionId"] == execution_id))
            {
                return Err("stale_interactive_preview_failure".into());
            }
            if invocation.is_none_or(|value| {
                value["executionId"] != execution_id || value["status"] != "awaiting_decision"
            }) {
                return Err("stale_interactive_preview_failure".into());
            }
            if task["state"] == "AWAITING_DECISION" {
                let graph = Graph::parse(include_str!("../../../../workflow/task-lifecycle.mmd"))?;
                let decision = graph.decide(
                    "AWAITING_DECISION",
                    GraphInput { transport: "event".into(), id: "interactive.resume".into(), payload: json!({}) },
                    &HashMap::new(),
                )?;
                let Decision::Accepted { target, actions, .. } = decision else {
                    return Err("Task Lifecycle Graph rejected Preview failure recovery".into());
                };
                if target != "QUEUED" { return Err("Task Lifecycle Graph selected an invalid Preview recovery state".into()); }
                apply_pure_task_actions(task, &actions)?;
                task["state"] = json!(target);
                task["attempt"] = json!(0);
                task["maxAttempts"] = json!(task["maxAttempts"].as_i64().unwrap_or(0).max(3));
                task["error"] = Value::Null;
                task["leaseOwner"] = Value::Null;
                task["leaseExpiresAt"] = Value::Null;
                task["executionId"] = Value::Null;
                task["updatedAt"] = json!(at);
                let comment = json!({
                    "id":uuid::Uuid::new_v4().to_string(),
                    "text":format!("Interactive review delivery failed; rerun review request: {}", reason.chars().take(500).collect::<String>()),
                    "author":"cli","createdAt":at,"jobId":job_id,"taskId":task_id
                });
                if let Some(comments) = task["comments"].as_array_mut() {
                    comments.push(comment.clone());
                }
                if task.get("comments").is_none_or(|value| !value.is_array()) { task["comments"] = json!([comment]); }
                requeued = true;
            }
            if let Some(fields) = task.as_object_mut() { fields.shift_remove("interactiveInvocation"); }
            next["updatedAt"] = json!(at);
            Ok((next, vec![]))
        });
        if let Err(error) = committed {
            if error == "stale_interactive_preview_failure" {
                return Ok(InteractiveReviewFailure {
                    job_id: job_id.into(),
                    task_id: task_id.into(),
                    execution_id: execution_id.into(),
                    requeued: false,
                });
            }
            return Err(error);
        }
        Ok(InteractiveReviewFailure {
            job_id: job_id.into(),
            task_id: task_id.into(),
            execution_id: execution_id.into(),
            requeued,
        })
    }

    /// Abort only the matching, still-running Preview invocation. Stale aborts
    /// are an idempotent no-op and never change Task lifecycle state.
    pub fn abort_interactive_review(
        &mut self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
        at: &str,
    ) -> Result<bool, String> {
        validate_identity(job_id, task_id, execution_id)?;
        let snapshot = self
            .read_job(job_id)?
            .ok_or("interactive Preview Job missing")?;
        let eligible = snapshot["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
            .is_some_and(|task| {
                task["state"] == "RUNNING"
                    && task["executionId"] == execution_id
                    && task["interactiveInvocation"]["executionId"] == execution_id
                    && task["interactiveInvocation"]["status"] == "awaiting_decision"
            });
        if !eligible {
            return Ok(false);
        }
        let mut aborted = false;
        let committed = self.commit_job_with_tx(job_id, at, |_, prior| {
            let mut next = prior.clone();
            let task = next["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
                .ok_or("interactive Preview Task missing")?;
            if task["state"] == "RUNNING"
                && task["executionId"] == execution_id
                && task["interactiveInvocation"]["executionId"] == execution_id
                && task["interactiveInvocation"]["status"] == "awaiting_decision"
            {
                if let Some(fields) = task.as_object_mut() {
                    fields.shift_remove("interactiveInvocation");
                }
                task["updatedAt"] = json!(at);
                next["updatedAt"] = json!(at);
                aborted = true;
                Ok((next, vec![]))
            } else {
                Err("stale_interactive_preview_abort".into())
            }
        });
        if let Err(error) = committed {
            if error == "stale_interactive_preview_abort" {
                return Ok(false);
            }
            return Err(error);
        }
        Ok(aborted)
    }
}

fn validate_identity(job_id: &str, task_id: &str, execution_id: &str) -> Result<(), String> {
    if job_id.trim().is_empty() || task_id.trim().is_empty() || execution_id.trim().is_empty() {
        return Err("interactive Preview requires Job, Task and execution identities".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;

    fn running(store: &mut RelayAuthority) -> String {
        let at = crate::supervised_script::after_time("2026-11-13T20:00:00.000Z").unwrap();
        store.commit_job("91", &at, |prior| {
            let mut job = prior.clone();
            job["updatedAt"] = json!(at);
            job["tasks"][0] = json!({"id":"101","state":"RUNNING","executionId":"exec-1","attempt":1,"maxAttempts":1,"leaseOwner":"worker","leaseExpiresAt":"2026-11-15T13:00:00.000Z","comments":[]});
            Ok((job, vec![]))
        }).unwrap();
        at
    }

    #[test]
    fn preview_binding_is_execution_fenced_and_delivery_failure_uses_task_graph() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        let at = running(&mut store);
        assert!(store
            .begin_interactive_review("91", "101", " ", &at)
            .is_err());
        let bind_at = crate::supervised_script::after_time(&at).unwrap();
        let bound = store
            .begin_interactive_review("91", "101", "exec-1", &bind_at)
            .unwrap();
        assert!(!bound.reused);
        let reopened = RelayAuthority::open_existing(&path).unwrap();
        assert_eq!(
            reopened.read_job("91").unwrap().unwrap()["tasks"][0]["interactiveInvocation"]
                ["revision"],
            "exec-1"
        );
        let retry_at = crate::supervised_script::after_time(&bind_at).unwrap();
        let duplicate = store
            .begin_interactive_review("91", "101", "exec-1", &retry_at)
            .unwrap();
        assert!(duplicate.reused);
        let failed_at = crate::supervised_script::after_time(&retry_at).unwrap();
        assert!(
            !store
                .fail_interactive_review("91", "101", "stale-exec", "failed", &failed_at)
                .unwrap()
                .requeued
        );
        let transition_at = crate::supervised_script::after_time(&failed_at).unwrap();
        store
            .commit_job("91", &transition_at, |prior| {
                let mut job = prior.clone();
                job["updatedAt"] = json!(transition_at);
                job["tasks"][0]["state"] = json!("AWAITING_DECISION");
                job["tasks"][0]["executionId"] = Value::Null;
                job["tasks"][0]["leaseOwner"] = Value::Null;
                job["tasks"][0]["leaseExpiresAt"] = Value::Null;
                Ok((job, vec![]))
            })
            .unwrap();
        let resumed_at = crate::supervised_script::after_time(&transition_at).unwrap();
        let failed = store
            .fail_interactive_review("91", "101", "exec-1", "host preview rejected", &resumed_at)
            .unwrap();
        assert!(failed.requeued);
        let job = store.read_job("91").unwrap().unwrap();
        assert_eq!(job["tasks"][0]["id"], "101");
        assert_eq!(job["tasks"][0]["state"], "QUEUED");
        assert!(job["tasks"][0].get("interactiveInvocation").is_none());
        assert_eq!(job["tasks"][0]["attempt"], 0);
        assert_eq!(job["tasks"][0]["comments"][0]["author"], "cli");
    }

    #[test]
    fn stale_preview_abort_is_inert_and_current_abort_clears_only_its_binding() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        let at = running(&mut store);
        let bind_at = crate::supervised_script::after_time(&at).unwrap();
        store
            .begin_interactive_review("91", "101", "exec-1", &bind_at)
            .unwrap();
        let stale_at = crate::supervised_script::after_time(&bind_at).unwrap();
        assert!(!store
            .abort_interactive_review("91", "101", "stale-exec", &stale_at)
            .unwrap());
        let abort_at = crate::supervised_script::after_time(&stale_at).unwrap();
        assert!(store
            .abort_interactive_review("91", "101", "exec-1", &abort_at)
            .unwrap());
        let job = store.read_job("91").unwrap().unwrap();
        assert_eq!(job["tasks"][0]["state"], "RUNNING");
        assert_eq!(job["tasks"][0]["executionId"], "exec-1");
        assert!(job["tasks"][0].get("interactiveInvocation").is_none());
    }
}
