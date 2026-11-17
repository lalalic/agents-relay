// Port of src/planner-task-context.ts: project a Task into bounded planner context.
use serde_json::{json, Map, Value};
fn bounded(v: Option<&Value>, max: usize) -> Value {
    match v {
        None => Value::Null,
        Some(Value::Null) => Value::Null,
        Some(Value::String(s)) if s.encode_utf16().count() > max => {
            let units: Vec<u16> = s.encode_utf16().collect();
            let cut = String::from_utf16_lossy(&units[..max]);
            json!(format!("{cut}\n...[truncated {} chars]", units.len() - max))
        }
        Some(x) => x.clone(),
    }
}
pub fn planner_task_context(t: &Value) -> Value {
    let mut o = Map::new();
    for (dest, src) in [("id", "id"), ("title", "title")] {
        if let Some(v) = t.get(src) {
            o.insert(dest.into(), v.clone());
        }
    }
    o.insert(
        "kind".into(),
        t.get("kind")
            .cloned()
            .filter(|v| !v.is_null())
            .unwrap_or(json!("work")),
    );
    for (dest, src) in [
        ("parent_task_id", "parentTaskId"),
        ("dependencies", "dependencies"),
        ("state", "state"),
        ("failure_reason", "failureReason"),
    ] {
        if let Some(v) = t.get(src) {
            o.insert(dest.into(), v.clone());
        }
    }
    if t["kind"] != "planner" {
        if let Some(v) = t.get("input") {
            o.insert("input".into(), bounded(Some(v), 4000));
        }
    }
    if let Some(v) = t.pointer("/result/summary") {
        o.insert("result_summary".into(), bounded(Some(v), 4000));
    }
    if let Some(v) = t.pointer("/result/data") {
        o.insert(
            "result_evidence".into(),
            bounded(Some(&json!(v.to_string())), 2000),
        );
    }
    if let Some(a) = t["executionHistory"].as_array() {
        o.insert(
            "execution_history".into(),
            json!(a
                .iter()
                .map(|x| json!({"id":x["id"],"attempt":x["attempt"],"started_at":x["startedAt"]}))
                .collect::<Vec<_>>()),
        );
    }
    if let Some(p) = t.get("platformFailure") {
        o.insert("platform_failure".into(),json!({"classification":p["classification"],"evidence":bounded(p.get("evidence"),4000),"safe_to_reroute":p["safeToReroute"]}));
    }
    if let Some(a) = t["comments"].as_array() {
        let start = a.len().saturating_sub(10);
        o.insert("comments".into(),json!(a[start..].iter().map(|x|json!({"author":x["author"],"text":bounded(x.get("text"),1000),"created_at":x["createdAt"]})).collect::<Vec<_>>()));
    }
    for (dest, src) in [
        ("resolution_classification", "resolutionClassification"),
        ("blocked_baseline", "blockedBaseline"),
        ("unblock", "unblock"),
    ] {
        if let Some(v) = t.get(src) {
            o.insert(dest.into(), v.clone());
        }
    }
    if let Some(v) = t.get("error") {
        o.insert("error".into(), bounded(Some(v), 2000));
    }
    Value::Object(o)
}
pub fn context(t: &Value) -> Value {
    planner_task_context(t)
}

// JS String.slice may cut a UTF-16 surrogate pair. serde_json::Value cannot
// store an unpaired surrogate, so this wire encoder emits its JSON escape
// losslessly when the bounded planner context crosses that boundary.
fn bounded_json_with_surrogate(original: &str, max_units: usize) -> Option<String> {
    let units: Vec<u16> = original.encode_utf16().collect();
    if units.len() <= max_units || !(0xD800..=0xDBFF).contains(&units[max_units - 1]) {
        return None;
    }
    let prefix = String::from_utf16(&units[..max_units - 1]).ok()?;
    let suffix = format!("\n...[truncated {} chars]", units.len() - max_units);
    let mut output = serde_json::to_string(&prefix).ok()?;
    output.pop(); // remove closing quote of first JSON segment
    output.push_str(&format!("\\u{:04x}", units[max_units - 1]));
    let tail = serde_json::to_string(&suffix).ok()?;
    output.push_str(&tail[1..]); // skip opening quote of second JSON segment
    Some(output)
}

fn source_for_bounded_path<'a>(task: &'a Value, path: &str) -> Option<(&'a str, usize)> {
    match path {
        "/input" => task["input"].as_str().map(|value| (value, 4000)),
        "/result_summary" => task
            .pointer("/result/summary")?
            .as_str()
            .map(|value| (value, 4000)),
        "/error" => task["error"].as_str().map(|value| (value, 2000)),
        "/platform_failure/evidence" => task
            .pointer("/platformFailure/evidence")?
            .as_str()
            .map(|value| (value, 4000)),
        "/result_evidence" => None, // handled explicitly from serialized source below
        _ => {
            let index = path
                .strip_prefix("/comments/")?
                .strip_suffix("/text")?
                .parse::<usize>()
                .ok()?;
            let comments = task["comments"].as_array()?;
            let source_index = index + comments.len().saturating_sub(10);
            comments
                .get(source_index)?
                .get("text")?
                .as_str()
                .map(|value| (value, 1000))
        }
    }
}

fn context_wire_node(node: &Value, task: &Value, path: &str) -> String {
    match node {
        Value::String(_) => {
            if path == "/result_evidence" {
                if let Some(data) = task.pointer("/result/data") {
                    if let Some(encoded) = bounded_json_with_surrogate(&data.to_string(), 2000) {
                        return encoded;
                    }
                }
            }
            if let Some((source, max)) = source_for_bounded_path(task, path) {
                if let Some(encoded) = bounded_json_with_surrogate(source, max) {
                    return encoded;
                }
            }
            node.to_string()
        }
        Value::Array(items) => {
            let parts = items
                .iter()
                .enumerate()
                .map(|(index, value)| context_wire_node(value, task, &format!("{path}/{index}")))
                .collect::<Vec<_>>();
            format!("[{}]", parts.join(","))
        }
        Value::Object(fields) => {
            let parts = fields
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("valid JSON key"),
                        context_wire_node(value, task, &format!("{path}/{key}"))
                    )
                })
                .collect::<Vec<_>>();
            format!("{{{}}}", parts.join(","))
        }
        _ => node.to_string(),
    }
}

pub fn planner_task_context_json_wire(task: &Value) -> String {
    context_wire_node(&planner_task_context(task), task, "")
}
