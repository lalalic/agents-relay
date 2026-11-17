// Direct port of src/planner-task-ids.ts: durable, idempotent Task IDs and alias rewriting.
use crate::job_task_id_sequence::allocate_entity_id;
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    path::Path,
};

pub fn assign_planner_task_ids(
    result: &Value,
    repository: &str,
    job_id: &str,
    plan_id: &str,
    directory: &Path,
) -> Result<Value, String> {
    let tasks = result
        .get("next_tasks")
        .and_then(Value::as_array)
        .ok_or("Planner result next_tasks must be an array")?;
    let mut aliases = HashMap::new();
    for spec in tasks {
        let id = spec
            .get("id")
            .and_then(Value::as_str)
            .ok_or("Planner Task id must be a string")?;
        let key = format!("plan:{job_id}:{plan_id}:{id}");
        let allocated =
            allocate_entity_id(directory, repository, "task", Some(&key), &HashSet::new())?;
        aliases.insert(id.to_owned(), allocated);
    }
    let mut output = result.clone();
    let array = output["next_tasks"].as_array_mut().expect("validated");
    for spec in array {
        let object = spec
            .as_object_mut()
            .ok_or("Planner Task must be an object")?;
        if let Some(Value::String(id)) = object.get_mut("id") {
            if let Some(alias) = aliases.get(id) {
                *id = alias.clone();
            }
        }
        if let Some(Value::String(id)) = object.get_mut("parentTaskId") {
            if !id.is_empty() {
                if let Some(alias) = aliases.get(id) {
                    *id = alias.clone();
                }
            }
        }
        if let Some(Value::Array(deps)) = object.get_mut("dependencies") {
            for dep in deps {
                if let Value::String(id) = dep {
                    if let Some(alias) = aliases.get(id) {
                        *id = alias.clone();
                    }
                }
            }
        }
        if let Some(Value::Object(validity)) = object.get_mut("dependencyValidity") {
            let old = std::mem::take(validity);
            for (dep, policy) in old {
                validity.insert(aliases.get(&dep).cloned().unwrap_or(dep), policy);
            }
        }
    }
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn idempotent_scoped_aliases_and_external_dependencies() {
        let dir = std::env::temp_dir()
            .join(format!("rust2-planner-task-ids-{}", std::process::id()))
            .join("stores");
        std::fs::create_dir_all(&dir).unwrap();
        let input = json!({"next_tasks":[
            {"id":"draft","dependencies":["outside"],"dependencyValidity":{"outside":"valid"}},
            {"id":"review","parentTaskId":"draft","dependencies":["draft","outside"],"dependencyValidity":{"draft":"strict","outside":"relaxed"}}
        ],"reason":"keep"});
        let first = assign_planner_task_ids(&input, "project", "job", "plan", &dir).unwrap();
        assert_eq!(
            first,
            assign_planner_task_ids(&input, "project", "job", "plan", &dir).unwrap()
        );
        let a = first["next_tasks"][0]["id"].as_str().unwrap();
        assert_eq!(first["next_tasks"][1]["parentTaskId"], a);
        assert_eq!(
            first["next_tasks"][1]["dependencies"],
            json!([a, "outside"])
        );
        assert_eq!(first["next_tasks"][1]["dependencyValidity"][a], "strict");
        assert_eq!(
            first["next_tasks"][1]["dependencyValidity"]["outside"],
            "relaxed"
        );
        assert_eq!(first["reason"], "keep");
        assert_ne!(
            first,
            assign_planner_task_ids(&input, "project", "job", "other", &dir).unwrap()
        );
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }
}
