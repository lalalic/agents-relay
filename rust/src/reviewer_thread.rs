// Direct port of src/reviewer-thread.ts pure destination/provenance predicates.
// Atomic recordThreadDelivery store mutation is intentionally not reimplemented here.
use crate::final_review_role::is_final_review_agent;
use serde_json::{json, Value};
fn js_truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|x| x != 0.),
        _ => true,
    }
}
pub fn normalize_thread_id(value: &Value, label: &str) -> Result<Option<String>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(s) = value.as_str() else {
        return Err(format!("{label} must be a string"));
    };
    let s = s.trim();
    if s.is_empty() {
        return Err(format!("{label} cannot be empty"));
    }
    if s.encode_utf16().count() > 256 {
        return Err(format!("{label} cannot exceed 256 characters"));
    }
    Ok(Some(s.into()))
}
pub fn resolve_implementation_thread_destination(job: &Value) -> Result<Value, String> {
    if !js_truthy(&job["implementationThreadId"]) {
        return Ok(Value::Null);
    }
    Ok(json!(normalize_thread_id(
        &job["implementationThreadId"],
        "Job implementation thread ID"
    )?))
}
pub fn resolve_implementation_task_thread_destination(
    job: &Value,
    task: &Value,
) -> Result<Value, String> {
    if task["agentName"] == "implementation"
        || task.get("agentName").is_none()
        || task["agentName"].is_null()
    {
        resolve_implementation_thread_destination(job)
    } else {
        Ok(Value::Null)
    }
}
pub fn resolve_reviewer_thread_destination(
    job: &Value,
    override_id: Option<&Value>,
) -> Result<Value, String> {
    if let Some(v) = override_id {
        if let Some(id) = normalize_thread_id(v, "--thread-id")? {
            return Ok(json!({"threadId":id,"source":"override"}));
        }
    }
    if js_truthy(&job["reviewerThreadId"]) {
        if let Some(id) = normalize_thread_id(&job["reviewerThreadId"], "Job reviewer thread ID")? {
            return Ok(json!({"threadId":id,"source":"reviewer"}));
        }
    }
    if let Some(tasks) = job["tasks"].as_array() {
        if let Some(previous) = tasks.iter().rev().find(|task| {
            is_final_review_agent(task["agentName"].as_str())
                && task["state"] == "SUCCEEDED"
                && task["adapter"] == "chatgpt"
                && task["routing"]["provider"] == "chatgpt"
                && js_truthy(&task["threadId"])
                && task["threadUrl"]
                    .as_str()
                    .is_some_and(|s| s.starts_with("https://chatgpt.com/c/"))
                && !js_truthy(&task["threadDeletedAt"])
        }) {
            return Ok(
                json!({"threadId":normalize_thread_id(&previous["threadId"],"thread ID")?,"source":"reviewer"}),
            );
        }
    }
    if js_truthy(&job["creatorThreadId"]) {
        return Ok(
            json!({"threadId":normalize_thread_id(&job["creatorThreadId"],"Job creator thread ID")?,"source":"creator"}),
        );
    }
    Ok(Value::Null)
}
pub fn prepare_reviewer_thread_delivery(
    job: &Value,
    task: &Value,
    override_id: Option<&Value>,
) -> Result<Value, String> {
    if !is_final_review_agent(task["agentName"].as_str()) {
        return Ok(Value::Null);
    }
    let d = resolve_reviewer_thread_destination(job, override_id)?;
    if d.is_null() {
        return Ok(Value::Null);
    }
    let existing = &task["chatgptThreadDelivery"];
    if js_truthy(&existing["deliveredAt"]) {
        if existing["threadId"] != d["threadId"] {
            return Err("Cannot redirect an already delivered reviewer task".into());
        }
        return Ok(existing.clone());
    }
    let id = if js_truthy(&existing["requestId"]) {
        existing["requestId"].clone()
    } else {
        json!(format!(
            "{}:{}:{}",
            jsval(&job["id"]),
            jsval(&task["id"]),
            task["reviewHeadSha"]
                .as_str()
                .or_else(|| job["headSha"].as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("review")
        ))
    };
    let mut value = json!({"kind":"new-turn","threadId":d["threadId"],"threadSource":d["source"],"requestId":id,
        "jobId":job["id"],"projectId":task["routing"]["projectId"]});
    if let Some(o) = value.as_object_mut() {
        if let Some(v) = job.get("prNumber") {
            o.insert("prNumber".into(), v.clone());
        }
        if js_truthy(&task["reviewHeadSha"]) {
            o.insert("reviewHeadSha".into(), task["reviewHeadSha"].clone());
        }
        if js_truthy(&existing["executionId"]) {
            o.insert("executionId".into(), existing["executionId"].clone());
        }
    }
    Ok(value)
}
fn jsval(v: &Value) -> String {
    v.as_str().map(str::to_string).unwrap_or_else(|| {
        if v.is_null() {
            "undefined".into()
        } else {
            v.to_string()
        }
    })
}
pub fn chatgpt_thread_requirements(configured: &Value) -> Value {
    let base = if configured.is_null() {
        json!({"capabilities":["model"]})
    } else {
        configured.clone()
    };
    let mut v = base.clone();
    let mut caps = base["capabilities"].as_array().cloned().unwrap_or_default();
    for c in ["model", "chatgpt", "webhelm"] {
        if !caps.contains(&json!(c)) {
            caps.push(json!(c))
        }
    }
    v["capabilities"] = json!(caps);
    v["runtime"] = json!("chatgpt");
    v
}
pub fn runtime_reviewer(args: &[String]) -> Result<Value, String> {
    let mut thread = String::new();
    let mut has = false;
    for (i, a) in args.iter().enumerate() {
        if a == "--thread-id" {
            has = true;
            thread = args.get(i + 1).cloned().unwrap_or_default();
            break;
        }
    }
    if has {
        normalize_thread_id(&json!(thread), "--thread-id")?;
    }
    let mut v = json!({"requirements":{"capabilities":["model"]}});
    if !thread.trim().is_empty() {
        v["threadId"] = json!(thread.trim());
    }
    Ok(v)
}
pub fn prepare_revision_thread_delivery(job: &Value, child: &mut Value) -> Result<Value, String> {
    if child["revision"]["kind"] != "targeted" {
        return Ok(Value::Null);
    }
    let original = job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"] == child["revision"]["originalTaskId"])
        .ok_or("revision original Task missing")?;
    let compatible = child["adapter"] == "chatgpt"
        && original["adapter"] == "chatgpt"
        && child["routing"]["provider"] == original["routing"]["provider"]
        && original["routing"]["provider"] == "chatgpt"
        && child["routing"]["projectId"] == original["routing"]["projectId"]
        && js_truthy(&child["executionId"])
        && js_truthy(&original["threadId"])
        && original["threadUrl"]
            .as_str()
            .is_some_and(|s| s.starts_with("https://chatgpt.com/c/"))
        && !js_truthy(&original["threadDeletedAt"]);
    let existing = &child["revision"]["threadContinuation"];
    if existing["decision"] == "reuse" && !compatible {
        return Err("revision original-thread affinity changed after being selected; refuse uncertain duplicate send".into());
    }
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("system time")
            .as_millis() as i64,
    )
    .expect("valid timestamp")
    .to_rfc3339_opts(chrono::SecondsFormat::Millis, true);
    let reason = if compatible {
        "matched original ChatGPT provider/project and durable live-compatible thread provenance"
    } else {
        "original thread missing/deleted or adapter/provider/project incompatible; safe full-context new execution"
    };
    let mut cont = json!({"decision":if compatible{"reuse"}else{"fallback"},"reason":reason,
        "decidedAt":existing["decidedAt"].as_str().filter(|s|!s.is_empty()).unwrap_or(&now)});
    if compatible {
        cont["originalThreadId"] = original["threadId"].clone();
    }
    child["revision"]["threadContinuation"] = cont;
    if !compatible {
        return Ok(Value::Null);
    }
    let mut d = json!({"kind":"new-turn","threadId":original["threadId"],"threadSource":"original-task",
        "requestId":format!("{}:{}:{}",jsval(&job["id"]),jsval(&child["id"]),jsval(&child["executionId"])),
        "jobId":job["id"],"repository":job["repository"],"taskId":child["id"],
        "executionId":child["executionId"],"projectId":child["routing"]["projectId"],"deliveredAt":null});
    if let Some(v) = job.get("prNumber") {
        d["prNumber"] = v.clone();
    }
    Ok(d)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn invalid_thread() {
        assert!(normalize_thread_id(&json!(1), "id").is_err());
        assert!(normalize_thread_id(&json!(" "), "id").is_err());
    }
    #[test]
    fn provenance() {
        let j = json!({"reviewerThreadId":"  a  ","creatorThreadId":"b"});
        assert_eq!(
            resolve_reviewer_thread_destination(&j, None).unwrap()["threadId"],
            "a"
        );
    }
}
