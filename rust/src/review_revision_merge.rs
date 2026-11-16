// Direct port of Node src/review-revision-merge.ts: preserve SQLite review revision history.
use serde_json::Value;

fn js_truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) | Value::Bool(true) => true,
    }
}

pub fn preserve_review_revision_history(local: &Value, merged: &mut Value) {
    let Some(merged_object) = merged.as_object_mut() else {
        return;
    };
    for key in ["reviewRevisionRequests", "reviewRevisionRounds"] {
        if let Some(value) = local.get(key).filter(|value| js_truthy(value)) {
            merged_object.insert(key.to_owned(), value.clone());
        } else {
            merged_object.remove(key);
        }
    }
}
