// Direct port of Node src/workflow/job-reconcile-v2.ts: local facts never invent completion events; dispatch via canonical Job lifecycle.
use super::lifecycle::{decide_job_lifecycle, dispatch_job_lifecycle};
use serde_json::{json, Value};
use std::path::Path;
fn local_facts(facts: &Value) -> Value {
    json!({
        "jobActive":facts.get("jobActive").cloned().unwrap_or(Value::Null),
        "implementationComplete":facts.get("implementationComplete").cloned().unwrap_or(Value::Null),
        "headAvailable":facts.get("headAvailable").cloned().unwrap_or(Value::Null),
        "deliveryReady":facts.get("deliveryReady").cloned().unwrap_or(Value::Null)
    })
}
pub fn decide_job_reconcile(directory: &Path, job: &Value, facts: &Value) -> Result<Value, String> {
    decide_job_lifecycle(directory, job, "reconcile", &local_facts(facts))
}
pub async fn dispatch_job_reconcile<F, P>(
    directory: &Path,
    job: &mut Value,
    facts: &Value,
    timestamp: &str,
    effect: F,
    persist: P,
) -> Result<Value, String>
where
    F: FnMut(&str) -> Result<(), String>,
    P: FnMut(&Value) -> Result<(), String>,
{
    dispatch_job_lifecycle(
        directory,
        job,
        "reconcile",
        &local_facts(facts),
        timestamp,
        effect,
        persist,
    )
    .await
}
