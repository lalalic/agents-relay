// Direct port of src/projection-failure-recovery.ts: failed optional remote
// delivery reports an event and diagnostic, never a Job state transition.
use crate::{
    events::event_for,
    observability::{classify_failure, error_message},
    projection_failure_dedupe::ProjectionFailureDeduplicator,
};
use serde_json::{json, Value};

pub fn handle_github_projection_failure<P, O>(
    error: &Value,
    as_error: bool,
    job: &Value,
    deduplicator: &mut ProjectionFailureDeduplicator,
    mut publish: P,
    mut observe: O,
) -> bool
where
    P: FnMut(&Value) -> Result<(), String>,
    O: FnMut(&Value),
{
    let reason = error_message(error, as_error);
    let classification = classify_failure(error, as_error)["classification"]
        .as_str()
        .unwrap_or("terminal")
        .to_owned();
    let job_id = job["id"].as_str().unwrap_or("");
    if !deduplicator.should_report(
        job_id,
        job["updatedAt"].as_str().unwrap_or(""),
        &reason,
        &classification,
    ) {
        return false;
    }
    let event = event_for(
        job_id,
        "projection",
        None,
        "projection.delivery_failed",
        "failed",
        &format!("Optional remote delivery failed: {reason}"),
        Some("orchestrator"),
        Some(json!({"operation":"remote.deliverLocalMain","error":reason})),
        Some(json!({"agent":"relay","component":"remote-delivery"})),
    );
    // Event errors are swallowed: both optional remote delivery and events
    // are observational and cannot affect the completed Job.
    let _ = publish(&event);
    let observation = json!({
        "stage":"projection","event":"remote.delivery_failed","level":"warn","outcome":"failed",
        "message":format!("Optional remote delivery failed for {job_id}: {reason}"),
        "correlation":{"repository":job["repository"],"jobId":job_id},
        "data":{"classification":classification,"reason":reason}
    });
    observe(&observation);
    true
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn terminal_dedup_suppresses_repeat_and_swallows_event_failure() {
        let mut dedup = ProjectionFailureDeduplicator::default();
        let job = json!({"id":"42","updatedAt":"2026-11-17T12:00:00Z","repository":"r"});
        let error = json!({"message":"invalid api key"});
        let mut observed = Vec::new();
        assert!(handle_github_projection_failure(
            &error,
            true,
            &job,
            &mut dedup,
            |_| Err("event bus unavailable".into()),
            |v| observed.push(v.clone())
        ));
        assert!(!handle_github_projection_failure(
            &error,
            true,
            &job,
            &mut dedup,
            |_| panic!("duplicate should not publish"),
            |_| panic!("duplicate should not observe")
        ));
        assert_eq!(observed.len(), 1);
        assert_eq!(observed[0]["data"]["classification"], "terminal");
    }
}
