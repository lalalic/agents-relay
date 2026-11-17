// Node provenance: src/browser-worker-routing.ts. Graph-authorized
// pre-submission admission checks, never workflow scheduling policy.
use serde_json::Value;

/// The input candidates are produced by the Worker Router; resource availability
/// is checked only for browser-backed workers and strict Task requirements apply.
pub fn has_safe_alternative_worker(
    task: Option<&Value>,
    candidates: &[Value],
) -> bool {
    let Some(task) = task else { return false; };
    let adapter = task.get("adapter").and_then(Value::as_str).unwrap_or("");
    if adapter == "orchestrator"
        || task.get("chatgptThreadDelivery").is_some_and(js_truthy)
    { return false; }
    let requirements = task.get("workerRequirements");
    let required_runtime = requirements
        .and_then(|r| r.get("runtime")).and_then(Value::as_str);
    if required_runtime == Some(adapter) { return false; }
    let capabilities = requirements
        .and_then(|r| r.get("capabilities")).and_then(Value::as_array);
    candidates.iter().any(|candidate| {
        let candidate_adapter = candidate.get("adapter").and_then(Value::as_str).unwrap_or("");
        if candidate_adapter == adapter
            || candidate.get("availability").and_then(Value::as_str) == Some("offline")
        { return false; }
        if required_runtime.is_some_and(|required| candidate
            .get("runtime").and_then(Value::as_str) != Some(required))
        { return false; }
        if capabilities.is_some_and(|required| required.iter().any(|capability| {
            !candidate.get("capabilities").and_then(Value::as_array)
                .is_some_and(|available| available.contains(capability))
        })) { return false; }
        if candidate_adapter == "chatgpt"
            && candidate.get("browserWorkspaceCapacity")
                .and_then(|cap| cap.get("available")).and_then(Value::as_i64) == Some(0)
        { return false; }
        if candidate_adapter != "chatgpt" && candidate_adapter != "z" {
            return true;
        }
        candidate.get("browserPoolHealth").and_then(Value::as_str) == Some("HEALTHY")
    })
}
fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}
