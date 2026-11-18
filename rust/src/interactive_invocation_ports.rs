// Candidate public Node src/interactive-invocation.ts HostInvocationPorts and
// HostInteractiveInvocationCoordinator.applyEvent port for sole Rust2 owner.
// This is a scratch proposal only; it is NOT yet tested, merged or enabled.
// All write effects are delegated to the canonical SQLite durable store.
use crate::{
    interactive_invocation::{
        accepted_interactive_event, decide_interactive_invocation,
        interactive_decision_fingerprint, normalize_interactive_decision,
        HostInteractiveInvocationCoordinator,
    },
    relay_store::SQLiteRelayStore,
};
use serde_json::{json, Value};
use std::path::Path;

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Rust-owned equivalent of the Node prototype-bound hostInvocationPorts.
/// There are no object spreads: every call reaches the same SQLite Store.
pub struct HostInvocationPorts<'a> {
    store: &'a mut SQLiteRelayStore,
}
pub fn host_invocation_ports(store: &mut SQLiteRelayStore) -> HostInvocationPorts<'_> {
    HostInvocationPorts { store }
}
impl HostInvocationPorts<'_> {
    pub fn load_job(&self, job_id: &str) -> Result<Option<Value>, String> {
        self.store.load_job(job_id)
    }
    pub fn mutate_job<F>(&self, job_id: &str, mutate: F) -> Result<Value, String>
    where
        F: FnOnce(Value) -> Result<Value, String>,
    {
        self.store.mutate_job(job_id, mutate)
    }
    pub fn record_host_invocation_event(
        &self,
        delivery: &Value,
        outcome: &str,
        fingerprint: &str,
    ) -> Result<(), String> {
        self.store
            .record_host_invocation_event(delivery, outcome, fingerprint)
    }
    pub fn has_host_invocation_decision(
        &self,
        job_id: &str,
        task_id: &str,
        invocation_id: &str,
        fingerprint: Option<&str>,
    ) -> Result<bool, String> {
        self.store
            .has_host_invocation_decision(job_id, task_id, invocation_id, fingerprint)
    }
    pub fn record_host_invocation_decision(
        &mut self,
        delivery: &Value,
        fingerprint: &str,
    ) -> Result<Value, String> {
        self.store
            .record_host_invocation_decision(delivery, fingerprint)
    }
}

/// Real Graph + SQLite-backed public applyEvent. An observed UI event is
/// not an approval until the SQLite decision transaction accepts it.
/// `on_accepted` and `emit` are injected runtime callbacks, invoked only
/// after the decision has durably committed.
pub fn apply_host_event<Accepted, Emit>(
    coordinator: &mut HostInteractiveInvocationCoordinator,
    ports: &mut HostInvocationPorts<'_>,
    graph_dir: &Path,
    event: &Value,
    mut on_accepted: Accepted,
    mut emit: Emit,
) -> Result<Value, String>
where
    Accepted: FnMut(&Value, &Value) -> Result<(), String>,
    Emit: FnMut(&Value) -> Result<(), String>,
{
    let Some(delivery) = normalize_interactive_decision(event) else {
        return Ok(json!({"outcome":"ignored","reason":"invalid_interactive_delivery"}));
    };
    if delivery.get("jobId") != event.get("job_id")
        || delivery.get("taskId") != event.get("task_id")
    {
        return Ok(json!({"outcome":"ignored","reason":"invalid_interactive_delivery"}));
    }
    let fingerprint = interactive_decision_fingerprint(&delivery);
    let job = ports.load_job(s(&delivery, "jobId"))?;
    let maybe_task = job.as_ref().and_then(|job| {
        job.get("tasks")
            .and_then(Value::as_array)
            .and_then(|tasks| {
                tasks
                    .iter()
                    .find(|task| task.get("id") == delivery.get("taskId"))
            })
    });
    let eligible = maybe_task.is_some_and(|task| {
        task.get("executionId") == delivery.get("executionId")
            || s(task, "state") == "AWAITING_DECISION"
    });
    if !eligible {
        ports.record_host_invocation_event(&delivery, "stale", &fingerprint)?;
        return Ok(json!({"outcome":"stale","reason":"execution_not_bound"}));
    }
    let job = job.ok_or("Host invocation Job disappeared")?;
    let task = job
        .get("tasks")
        .and_then(Value::as_array)
        .and_then(|tasks| {
            tasks
                .iter()
                .find(|task| task.get("id") == delivery.get("taskId"))
        })
        .ok_or("Host invocation Task disappeared")?;
    let duplicate = ports.has_host_invocation_decision(
        s(&delivery, "jobId"),
        s(&delivery, "taskId"),
        s(&delivery, "invocationId"),
        Some(&fingerprint),
    )?;
    let graph = decide_interactive_invocation(graph_dir, &job, task, &delivery, duplicate)?;
    let actions = graph.get("actions").and_then(Value::as_array);
    let selected = actions.is_some_and(|items| {
        items.iter().any(|item| {
            matches!(
                s(item, "id"),
                "interactive.requestChanges" | "interactive.approve"
            )
        })
    });
    let wake = actions.is_some_and(|items| {
        items
            .iter()
            .any(|item| s(item, "id") == "interactive.wakeWorker")
    });
    if graph.get("accepted") != Some(&Value::Bool(true)) || !selected || duplicate {
        let outcome = if duplicate { "duplicate" } else { "stale" };
        ports.record_host_invocation_event(&delivery, outcome, &fingerprint)?;
        return Ok(json!({
            "outcome":outcome,"reason":format!("{outcome}_interactive_decision"),
            "decision":delivery,"resumeWorker":duplicate&&wake,
        }));
    }
    let persisted = ports.record_host_invocation_decision(&delivery, &fingerprint)?;
    if s(&persisted, "outcome") != "accepted" {
        return Ok(json!({"outcome":persisted.get("outcome"),
                "reason":persisted.get("reason")}));
    }
    // Node acceptedEvent is built from the AcceptedInteractiveDecision
    // (selected public fields plus the original event), not from the
    // complete transport delivery (eventId and deliveredAt are excluded).
    let mut accepted = json!({
        "jobId": delivery.get("jobId"),
        "taskId": delivery.get("taskId"),
        "executionId": delivery.get("executionId"),
        "invocationId": delivery.get("invocationId"),
        "revision": delivery.get("revision"),
        "decision": delivery.get("decision"),
        "event": event,
    });
    for key in ["feedback", "comments", "idempotencyKey"] {
        if let Some(value) = delivery.get(key) {
            accepted[key] = value.clone();
        }
    }
    coordinator.accept(&delivery);
    on_accepted(&accepted, event)?;
    emit(&accepted_interactive_event(&accepted))?;
    Ok(json!({
        "outcome":"accepted","reason":"latest_interactive_decision",
        "invocation":persisted.get("invocation"),"decision":delivery,
        "resumeWorker":wake,
    }))
}
