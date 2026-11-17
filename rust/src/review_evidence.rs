// Port of src/review-evidence.ts: normalize durable reviewer event evidence.
use serde_json::{json, Value};

fn record(value: &Value) -> Value {
    if value.is_object() {
        value.clone()
    } else {
        json!({})
    }
}
fn first_string(values: &[&Value]) -> Option<String> {
    values
        .iter()
        .find_map(|v| v.as_str().filter(|s| !s.is_empty()).map(str::to_owned))
}
pub fn normalize_review_evidence(event: &Value, task: &Value) -> Value {
    let data = record(&event["data"]);
    let outcome = record(&data["outcome"]);
    let review = record(&data["review"]);
    let head = first_string(&[
        &outcome["head_sha"],
        &outcome["headSha"],
        &review["head_sha"],
        &review["headSha"],
        &data["head_sha"],
        &data["headSha"],
    ])
    .or_else(|| {
        (event["type"] == "review.approved")
            .then(|| {
                task["reviewHeadSha"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .flatten()
    });
    let Some(head) = head else {
        return Value::Null;
    };
    let raw = if data.get("findings").is_some() {
        data.get("findings")
    } else if outcome.get("blocking_findings").is_some() {
        outcome.get("blocking_findings")
    } else if outcome.get("blockingFindings").is_some() {
        outcome.get("blockingFindings")
    } else if outcome.get("findings").is_some() {
        outcome.get("findings")
    } else if review.get("findings").is_some() {
        review.get("findings")
    } else if review.get("issues").is_some() {
        review.get("issues")
    } else if data.get("blocking_findings").is_some() {
        data.get("blocking_findings")
    } else {
        data.get("issues")
    };
    let issues = if raw.is_none() {
        Vec::new()
    } else if let Some(a) = raw.and_then(Value::as_array) {
        a.iter()
            .map(|v| {
                if let Some(s) = v.as_str() {
                    let t = s.trim();
                    if t.is_empty() {
                        "[unparseable blocking finding]".into()
                    } else {
                        t.into()
                    }
                } else if v.is_object() {
                    first_string(&[
                        &v["summary"],
                        &v["message"],
                        &v["finding"],
                        &v["title"],
                        &v["id"],
                    ])
                    .map(|s| s.trim().to_owned())
                    .filter(|s| !s.is_empty())
                    .unwrap_or_else(|| "[unparseable blocking finding]".into())
                } else {
                    "[unparseable blocking finding]".into()
                }
            })
            .collect()
    } else {
        vec!["[unparseable blocking finding]".to_owned()]
    };
    json!({"headSha":head,"issues":issues})
}
