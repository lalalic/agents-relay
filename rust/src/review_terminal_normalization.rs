// Port of src/review-terminal-normalization.ts: normalize authenticated reviewer terminal events.
use serde_json::{json, Map, Value};
fn object(v: &Value) -> Map<String, Value> {
    v.as_object().cloned().unwrap_or_default()
}
pub fn normalize_reviewer_terminal_event(event: &Value) -> Value {
    if event["type"] != "task.completed" {
        return Value::Null;
    }
    let data = object(&event["data"]);
    let raw = data
        .get("verdict")
        .unwrap_or(&Value::Null)
        .as_str()
        .unwrap_or("");
    let ty = match raw {
        "approved" | "pass" => "review.approved",
        "changes-required" | "changes_required" => "review.changes_required",
        "blocked" => "task.failed",
        _ => return Value::Null,
    };
    let outcome = object(data.get("outcome").unwrap_or(&Value::Null));
    let review = object(data.get("review").unwrap_or(&Value::Null));
    let head = [
        outcome.get("head_sha"),
        outcome.get("headSha"),
        review.get("head_sha"),
        review.get("headSha"),
        data.get("head_sha"),
        data.get("headSha"),
    ]
    .into_iter()
    .flatten()
    .find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned));
    let Some(head) = head else { return Value::Null };
    let existing = outcome
        .get("blocking_findings")
        .or_else(|| outcome.get("blockingFindings"))
        .cloned();
    let findings = existing
        .clone()
        .or_else(|| data.get("findings").filter(|v| v.is_array()).cloned());
    let mut out = event.clone();
    let mut newdata = data;
    if ty == "task.failed" {
        out["message"] = json!(event["message"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("Reviewer validation unavailable"));
        newdata.insert("reason".into(), json!("review_evidence_unavailable"));
    } else {
        let mut newout = outcome;
        newout.insert("head_sha".into(), json!(head));
        if let Some(f) = findings {
            if existing.is_none() {
                newout.insert("blocking_findings".into(), f);
            }
        }
        newdata.insert("outcome".into(), Value::Object(newout));
    }
    out["type"] = json!(ty);
    out["data"] = Value::Object(newdata);
    out
}
pub fn normalize(event: &Value) -> Value {
    normalize_reviewer_terminal_event(event)
}
