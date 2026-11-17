// Direct port of Node src/review-generation-fence.ts: immutable Task execution/head generation fence for durable Final Review acceptance.
use crate::final_review_role::is_final_review_agent;
use serde_json::Value;

fn exists_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(number)) => number.as_f64() != Some(0.0),
        _ => true,
    }
}
fn strict_equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    // JavaScript strict equality treats absent (undefined) and null differently.
    a == b
}

/// Validates against the *current* SQLite-mutated Job, never a cached Job view.
/// Only pure snapshot comparisons occur here; no Review is accepted or persisted.
pub fn review_generation_matches(
    current: &Value,
    original: &Value,
    task: &Value,
    head_sha: &str,
) -> bool {
    let Some(fresh) = current
        .get("tasks")
        .and_then(Value::as_array)
        .and_then(|tasks| tasks.iter().find(|item| item.get("id") == task.get("id")))
    else {
        return false;
    };
    if fresh.get("reviewHeadSha").and_then(Value::as_str) != Some(head_sha)
        || (current.get("state").and_then(Value::as_str) != Some("ACTIVE")
            && current
                .pointer("/projectionRecovery/status")
                .and_then(Value::as_str)
                != Some("repairing"))
        || (exists_truthy(current.get("headSha"))
            && current.get("headSha").and_then(Value::as_str) != Some(head_sha))
        || !strict_equal(fresh.get("executionId"), task.get("executionId"))
    {
        return false;
    }
    let current_review = current.get("review").filter(|value| !value.is_null());
    let original_review = original.get("review").filter(|value| !value.is_null());
    if current_review
        .and_then(|review| review.get("outcome"))
        .and_then(Value::as_str)
        == Some("stale")
        && original_review
            .and_then(|review| review.get("outcome"))
            .and_then(Value::as_str)
            == Some("stale")
        && current_review
            .and_then(|review| review.get("headSha"))
            .and_then(Value::as_str)
            != Some(head_sha)
        && exists_truthy(task.get("planningDecisionId"))
    {
        let latest = current
            .get("tasks")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .rfind(|item| {
                is_final_review_agent(item.get("agentName").and_then(Value::as_str))
                    && item.get("reviewHeadSha").and_then(Value::as_str) == Some(head_sha)
                    && item.get("state").and_then(Value::as_str) != Some("CANCELLED")
            });
        return latest.and_then(|item| item.get("id")) == task.get("id");
    }
    if let Some(review) = current_review {
        let expected_outcome = original_review
            .and_then(|entry| entry.get("outcome"))
            .filter(|value| !value.is_null())
            .and_then(Value::as_str)
            .unwrap_or("pending");
        return review.get("taskId") == task.get("id")
            && review.get("headSha").and_then(Value::as_str) == Some(head_sha)
            && review.get("outcome").and_then(Value::as_str) == Some(expected_outcome);
    }
    exists_truthy(task.get("planningDecisionId"))
        && !exists_truthy(original_review.and_then(|review| review.get("taskId")))
}
