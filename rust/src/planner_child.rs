// Node src/planner-child.ts: compare Planner child definitions using JS JSON.stringify field projection semantics.
use serde_json::{Map, Value};

const FIELDS: &[&str] = &[
    "id",
    "parentTaskId",
    "input",
    "output",
    "review",
    "priority",
    "storySize",
    "projectName",
    "agentName",
    "agentGraph",
    "dependencies",
    "capabilities",
    "adapter",
    "routing",
    "continuation",
    "maxAttempts",
    "timeoutMs",
];

fn projected(task: &Value) -> Value {
    let mut out = Map::new();
    for &key in FIELDS {
        match key {
            "review" | "continuation" => {
                out.insert(key.into(), task.get(key).cloned().unwrap_or(Value::Null));
            }
            "storySize" => {
                out.insert(
                    key.into(),
                    task.get(key)
                        .filter(|v| !v.is_null())
                        .cloned()
                        .unwrap_or(Value::String("M".into())),
                );
            }
            _ => {
                if let Some(value) = task.get(key) {
                    out.insert(key.into(), value.clone());
                }
            }
        }
    }
    Value::Object(out)
}

pub fn same_planner_child_definition(left: &Value, right: &Value) -> bool {
    // preserve_order ensures the JSON serialization has the same field order as Node.
    // Equality is based on serialized values, including distinctions between absent and null.
    let left_json = projected(left).to_string();
    let right_json = projected(right).to_string();
    left_json == right_json
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn ignores_unrelated_fields_and_normalizes_optionals() {
        assert!(same_planner_child_definition(
            &json!({"id":1}),
            &json!({"id":1,"review":null,"storySize":"M","continuation":null,"state":"ACTIVE"})
        ));
        assert!(!same_planner_child_definition(
            &json!({"id":1}),
            &json!({"id":2})
        ));
        assert!(!same_planner_child_definition(
            &json!({"id":1}),
            &json!({"id":1,"review":{}})
        ));
    }
}
