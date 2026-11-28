// Direct port of src/reviewer-thread.ts pure destination/provenance predicates.
// Delivery receipts are fenced by the current authoritative Task execution and
// committed through the shared SQLite mutateJob transaction, never inferred as approval.
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
pub fn resolve_reviewer_thread_destination(job: &Value) -> Result<Value, String> {
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
    Ok(Value::Null)
}
pub fn prepare_reviewer_thread_delivery(
    job: &Value,
    task: &Value,
) -> Result<Value, String> {
    if !is_final_review_agent(task["agentName"].as_str()) {
        return Ok(Value::Null);
    }
    let d = resolve_reviewer_thread_destination(job)?;
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
    if args.iter().any(|arg| arg == "--thread-id" || arg.starts_with("--thread-id=")) {
        return Err("--thread-id is not supported for runtime reviewer configuration".into());
    }
    Ok(json!({"requirements":{"capabilities":["model"]}}))
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

/// Node recordThreadDelivery: never mark an uncorrelated send, and never record
/// delivery on a Task that is no longer RUNNING in the exact execution.
/// The receipt is committed by the canonical store transaction.
pub fn record_thread_delivery<W, E>(
    store: &mut crate::relay_workflow_operations::SQLiteWorkflowOperations<'_, W, E>,
    job_id: &str,
    task_id: &str,
    execution_id: &str,
    worker_task: &Value,
) -> Result<bool, String>
where
    W: FnMut(&Value, &str) -> Result<(), String>,
    E: FnMut(&Value, &str) -> Result<(), String>,
{
    let Some(delivery) = worker_task
        .get("chatgptThreadDelivery")
        .filter(|v| !v.is_null())
    else {
        return Ok(false);
    };
    if js_truthy(&delivery["deliveredAt"])
        || delivery
            .get("executionId")
            .is_some_and(|v| v != execution_id)
    {
        return Ok(false);
    }
    let mut recorded = false;
    store.mutate_job(job_id, |mut job| {
        if let Some(task) = job["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|task| task["id"] == task_id))
        {
            if task["executionId"] == execution_id
                && task["state"] == "RUNNING"
                && task
                    .get("chatgptThreadDelivery")
                    .is_some_and(|v| !v.is_null())
                && task["chatgptThreadDelivery"]["requestId"] == delivery["requestId"]
                && !js_truthy(&task["chatgptThreadDelivery"]["deliveredAt"])
            {
                task["chatgptThreadDelivery"]["executionId"] = json!(execution_id);
                task["chatgptThreadDelivery"]["deliveredAt"] =
                    json!(crate::local_merge_lock::iso8601_now());
                recorded = true;
            }
        }
        Ok(job)
    })?;
    Ok(recorded)
}

/// Node's legacy DurableStore branch for callers without mutateJob.
/// This uses the caller's actual load/saveTask effects; it never fabricates a
/// delivery receipt, and a failed save is propagated rather than acknowledged.
/// Modern callers use the SQLite transaction in record_thread_delivery.
pub fn record_thread_delivery_without_atomic_store<Load, Save>(
    job_id: &str,
    task_id: &str,
    execution_id: &str,
    worker_task: &Value,
    mut load: Load,
    mut save_task: Save,
) -> Result<bool, String>
where
    Load: FnMut(&str) -> Result<Value, String>,
    Save: FnMut(&Value) -> Result<(), String>,
{
    let delivery = &worker_task["chatgptThreadDelivery"];
    if delivery.is_null()
        || js_truthy(&delivery["deliveredAt"])
        || delivery
            .get("executionId")
            .is_some_and(|v| v != execution_id)
    {
        return Ok(false);
    }
    let job = load(job_id)?;
    let Some(current) = job["tasks"]
        .as_array()
        .and_then(|items| items.iter().find(|task| task["id"] == task_id))
    else {
        return Ok(false);
    };
    if current["executionId"] != execution_id
        || current["state"] != "RUNNING"
        || current["chatgptThreadDelivery"].is_null()
        || current["chatgptThreadDelivery"]["requestId"] != delivery["requestId"]
        || js_truthy(&current["chatgptThreadDelivery"]["deliveredAt"])
    {
        return Ok(false);
    }
    let mut task = current.clone();
    task["chatgptThreadDelivery"]["executionId"] = json!(execution_id);
    task["chatgptThreadDelivery"]["deliveredAt"] = json!(crate::local_merge_lock::iso8601_now());
    save_task(&task)?;
    Ok(true)
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
        let j = json!({"reviewerThreadId":"legacy-reviewer","creatorThreadId":"legacy-creator",
            "tasks":[{"agentName":"job-acceptance-reviewer","state":"SUCCEEDED",
            "adapter":"chatgpt","routing":{"provider":"chatgpt"},"threadId":"  a  ",
            "threadUrl":"https://chatgpt.com/c/a"}]});
        assert_eq!(
            resolve_reviewer_thread_destination(&j).unwrap()["threadId"],
            "a"
        );
        assert!(resolve_reviewer_thread_destination(&json!({
            "reviewerThreadId":"legacy-reviewer","creatorThreadId":"legacy-creator",
            "tasks":[]
        })).unwrap().is_null());
    }
    #[test]
    fn runtime_reviewer_rejects_retired_destination() {
        assert!(runtime_reviewer(&["--thread-id".into(),"legacy".into()]).is_err());
        assert!(runtime_reviewer(&["--thread-id=legacy".into()]).is_err());
        assert_eq!(runtime_reviewer(&[]).unwrap(),json!({"requirements":{"capabilities":["model"]}}));
    }
}

#[cfg(test)]
mod wave4_legacy_store_tests {
    use super::*;
    #[test]
    fn fallback_reads_and_saves_only_current_correlated_delivery() {
        let job = json!({"tasks":[{"id":"11","executionId":"e1","state":"RUNNING",
            "chatgptThreadDelivery":{"threadId":"t","requestId":"r1","deliveredAt":null}}]});
        let worker = json!({"chatgptThreadDelivery":{"requestId":"r1"}});
        let mut saved: Vec<Value> = vec![];
        assert!(record_thread_delivery_without_atomic_store(
            "j",
            "11",
            "e1",
            &worker,
            |_| Ok(job.clone()),
            |task| {
                saved.push(task.clone());
                Ok(())
            }
        )
        .unwrap());
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0]["chatgptThreadDelivery"]["executionId"], "e1");
        assert!(saved[0]["chatgptThreadDelivery"]["deliveredAt"].is_string());
        let mut reads = 0;
        assert!(!record_thread_delivery_without_atomic_store(
            "j",
            "11",
            "e0",
            &json!({
            "chatgptThreadDelivery":{"requestId":"r1","executionId":"e1"}}),
            |_| {
                reads += 1;
                Ok(job.clone())
            },
            |_| panic!("must not save mismatched execution")
        )
        .unwrap());
        assert_eq!(reads, 0);
        assert!(!record_thread_delivery_without_atomic_store(
            "j",
            "11",
            "e2",
            &worker,
            |_| Ok(job.clone()),
            |_| panic!("must not save stale execution")
        )
        .unwrap());
    }
    #[test]
    fn legacy_store_failed_save_does_not_report_delivery() {
        let job = json!({"tasks":[{"id":"11","executionId":"e1","state":"RUNNING",
            "chatgptThreadDelivery":{"requestId":"r1","deliveredAt":null}}]});
        let err = record_thread_delivery_without_atomic_store(
            "j",
            "11",
            "e1",
            &json!({"chatgptThreadDelivery":{"requestId":"r1"}}),
            |_| Ok(job.clone()),
            |_| Err("disk write rejected".into()),
        )
        .unwrap_err();
        assert_eq!(err, "disk write rejected");
    }
}
