// Direct port of Node src/dependency-validity.ts: reject undeclared edges and unknown policies.
use serde_json::{Map, Value};

pub fn validate_dependency_validity(
    dependencies: &[String],
    value: &Value,
    field: &str,
) -> Result<Option<Map<String, Value>>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let Some(object) = value.as_object() else {
        return Err(format!("{field} must be an object"));
    };
    let mut result = Map::new();
    for (task_id, policy) in object {
        if !dependencies.contains(task_id) {
            return Err(format!(
                "{field} key {task_id} must identify a declared dependency"
            ));
        }
        if !matches!(policy.as_str(), Some("order-only" | "revalidate" | "rerun")) {
            return Err(format!(
                "{field}[{task_id}] must be order-only, revalidate, or rerun"
            ));
        }
        // Node writes to a plain object. Assigning a string to __proto__
        // invokes the inherited setter and leaves no own enumerable property.
        if task_id != "__proto__" {
            result.insert(task_id.clone(), policy.clone());
        }
    }
    Ok(Some(result))
}
