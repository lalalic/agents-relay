// Node provenance: src/chatgpt-platform-fallback.ts. Only the canonical
// routing and Task Graph may authorize pre-start platform fallback.
use crate::events::event_for;
use crate::local_merge_lock::iso8601_now;
use serde_json::{json, Value};
use std::future::Future;

fn val<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn excluded(task: &Value, candidate: &Value) -> bool {
    task.get("routingExclusions").and_then(Value::as_array).is_some_and(|items|
        items.iter().any(|item| {
            let adapter = val(item, "adapter");
            let worker_id = val(item, "workerId");
            (!adapter.is_empty() && adapter == val(candidate, "adapter"))
                || (!worker_id.is_empty() && worker_id == val(candidate, "workerId"))
        }))
}
fn eligible(candidate: &Value, task: &Value) -> bool {
    if val(candidate, "adapter") != "codex" || excluded(task, candidate)
        || val(candidate, "availability") == "offline" {return false;}
    let requirements = task.get("workerRequirements");
    let runtime = requirements.and_then(|r| r.get("runtime")).and_then(Value::as_str);
    if runtime.is_some_and(|r| r != val(candidate, "runtime")) {return false;}
    let needed = requirements.and_then(|r| r.get("capabilities"))
        .and_then(Value::as_array);
    if let Some(needed) = needed {
        if needed.iter().any(|cap| !candidate.get("capabilities")
            .and_then(Value::as_array).is_some_and(|available| available.contains(cap)))
        {return false;}
    }
    true
}

/// Candidates are the Worker Router's registered/usage-aware list, not an
/// invented Codex identity or unverified catalog default.
pub fn codex_fallback_routing(task: &Value, candidates: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let accepted = candidates.iter().filter(|candidate|eligible(candidate,task))
        .cloned().collect();
    let excluded_routes = task.get("routingExclusions").and_then(Value::as_array)
        .into_iter().flatten().map(|item| {
            let mut route = json!({
                "provider":item.get("provider"),"model":item.get("model"),
            });
            if let Some(profile) = item.get("profile").and_then(Value::as_str)
                .filter(|text| !text.is_empty()) {
                route["profile"] = json!(profile);
            }
            route
        }).collect();
    (accepted, excluded_routes)
}
pub async fn codex_fallback_compatible<Route, Fut>(
    task: &Value, candidates: &[Value], route: Route,
) -> bool
where Route: FnOnce(Vec<Value>, Vec<Value>) -> Fut,
      Fut: Future<Output = Result<Value, String>>,
{
    if val(task, "adapter") != "chatgpt"
        || task.get("chatgptThreadDelivery").is_some_and(|v|v==true)
        || task.get("workerRequirements").and_then(|r|r.get("runtime"))
            .and_then(Value::as_str) == Some("chatgpt") {return false;}
    let (candidates, excluded_routes) = codex_fallback_routing(task, candidates);
    if candidates.is_empty() {return false;}
    route(candidates, excluded_routes).await.is_ok()
}
pub async fn codex_no_start_fallback_route<Route, Fut>(
    task: &Value, candidates: &[Value], configured_default: Option<&Value>,
    route: Route,
) -> Option<Value>
where Route: FnOnce(Vec<Value>,Vec<Value>,Value) -> Fut,
      Fut: Future<Output = Result<Value, String>>,
{
    if !matches!(val(task,"adapter"), "chatgpt" | "z")
        && task.get("noStartFallback").is_none_or(|v| v.is_null()) {return None;}
    if task.get("chatgptThreadDelivery").is_some_and(|v|v==true) {return None;}
    let configured = configured_default?;
    let provider = configured.get("provider").and_then(Value::as_str)?;
    let model = configured.get("model").and_then(Value::as_str)?;
    let (candidates, exclusions) = codex_fallback_routing(task,candidates);
    if candidates.is_empty() {return None;}
    let decision = route(candidates,exclusions,
        json!({"provider":provider, "model":model})).await.ok()?;
    if val(&decision["candidate"],"adapter") != "codex"
        || val(&decision["candidate"]["routing"],"provider") != provider
        || val(&decision["candidate"]["routing"],"model") != model
        || !decision["model"]["profile"].is_null() {return None;}
    Some(decision)
}

/// Preserve the exact failed route as a one-way exclusion: do not retry
/// a quarantined Worker with an identical worker ID and adapter.
pub fn persist_chatgpt_platform_failure(
    task: &mut Value, original: Option<&Value>, execution_id: Option<&str>,
    classification: &str, evidence: &str, safe_to_reroute: bool,
) {
    let route = original.and_then(|v| v.get("routing"));
    let adapter = if original.is_some_and(|v| val(v, "adapter")=="z") { "z" } else { "chatgpt" };
    let worker_id = original.and_then(|v| v.get("workerSelection"))
        .and_then(|selection|selection.get("workerId")).and_then(Value::as_str)
        .or_else(||original.and_then(|v|v.get("adapter")).and_then(Value::as_str))
        .unwrap_or("chatgpt");
    let at = iso8601_now();
    let mut failed = json!({
        "workerId":worker_id,
        "adapter":adapter,
        "provider":route.map(|v| val(v,"provider")).filter(|v| !v.is_empty()).unwrap_or("unknown"),
        "model":route.map(|v|val(v,"model")).filter(|v| !v.is_empty()).unwrap_or("unknown")
    });
    if let Some(profile) = route.and_then(|v|v.get("profile")).and_then(Value::as_str)
        .filter(|value| !value.is_empty()) {failed["profile"] = json!(profile);}
    task["platformFailure"] = json!({
        "classification":classification,"executionId":execution_id.unwrap_or("unknown"),
        "route":failed,"evidence":evidence,"safeToReroute":safe_to_reroute,"at":at,
    });
    let exclusions = task.get("routingExclusions").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    if !exclusions.iter().any(|item|val(item,"workerId")==worker_id && val(item,"adapter")==adapter) {
        let mut next = exclusions;
        failed["reason"] = json!(classification);
        failed["at"] = json!(at);
        next.push(failed);
        task["routingExclusions"] = json!(next);
    }
}

/// The Task Graph controls the fallback failure. This helper only performs
/// its accepted mutation and synthesizes the user-visible terminal event.
pub async fn quarantine_unavailable_codex_fallback<Transition, Fut>(
    job_id: &str, task_id: &str, error: &str, transition: Transition,
) -> Result<Option<Value>, String>
where Transition: FnOnce(&str,&str,&str,Value) -> Fut,
      Fut: Future<Output = Result<Option<Value>, String>>,
{
    let context = json!({
        "facts":{"platformFallbackSafe":false},
        "eligibleState":"QUEUED","eligibleAdapters":["chatgpt","z"],
        "requiresSafeToReroute":true,
        "error":format!("Codex fallback route became unavailable: {error}")
    });
    let updated = transition(job_id,task_id,"worker.platform_failure",context).await?;
    let Some(task) = updated else {return Ok(None);};
    if task.get("state").and_then(Value::as_str) == Some("QUEUED") {
        return Ok(None);
    }
    Ok(Some(event_for(job_id,task_id,
        task.get("parentTaskId").and_then(Value::as_str),
        "task.failed","failed",
        task.get("error").and_then(Value::as_str)
            .unwrap_or("Codex fallback route unavailable"),Some("user"),
        Some(json!({"reason":task.get("failureReason"),"phase":"fallback-routing"})),None)))
}
