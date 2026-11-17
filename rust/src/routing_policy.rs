// Direct port of src/routing-policy.ts: routing-policy sanitization, SHA-256 snapshots, file persistence and route eligibility/ranking.
use crate::router_rules::parse_router_rules;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

fn sha256(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn string_array(value: Option<&Value>) -> Option<Value> {
    let value = value?.as_array()?;
    value
        .iter()
        .all(Value::is_string)
        .then(|| Value::Array(value.clone()))
}

pub fn safe_policy(value: &Value) -> Value {
    let Some(source) = value.as_object() else {
        return json!({});
    };
    let mut result = Map::new();
    for field in [
        "disabledProfiles",
        "disabledProviders",
        "preferredProviders",
        "preferredProfiles",
    ] {
        if let Some(values) = string_array(source.get(field)) {
            result.insert(field.to_string(), values);
        }
    }
    if let Some(quality) = source.get("qualityByTaskKind").and_then(Value::as_object) {
        let mut filtered = Map::new();
        for (key, value) in quality {
            if key == "__proto__" {
                continue;
            } // Node's ordinary `{}` prototype setter is not an own JSON field.
            if let Some(strings) = string_array(Some(value)) {
                filtered.insert(key.clone(), strings);
            }
        }
        result.insert("qualityByTaskKind".into(), Value::Object(filtered));
    }
    if let Some(recovery) = source.get("recovery").and_then(Value::as_object) {
        if let Some(penalize) = recovery.get("penalizePriorRoute").and_then(Value::as_bool) {
            result.insert("recovery".into(), json!({"penalizePriorRoute":penalize}));
        }
    }
    Value::Object(result)
}

pub fn policy_path(explicit: Option<&str>, env_value: Option<&str>, cwd: &Path) -> String {
    explicit
        .or(env_value)
        .map(str::to_string)
        .unwrap_or_else(|| {
            cwd.join(".agents-relay-routing-policy.json")
                .to_string_lossy()
                .into_owned()
        })
}

pub fn execution_router_rules_path(
    explicit: Option<&str>,
    env_value: Option<&str>,
    home: &Path,
) -> String {
    explicit
        .or(env_value)
        .map(str::to_string)
        .unwrap_or_else(|| {
            home.join(".agents-relay/execution-router-rules.md")
                .to_string_lossy()
                .into_owned()
        })
}

fn rules_with_text(path: &str, text: &str, hash: &str) -> Value {
    json!({"path":path,"hash":hash,"text":text,"parsed":parse_router_rules(text)})
}

pub fn load_execution_router_rules(path: &str) -> Value {
    let Ok(bytes) = fs::read(path) else {
        return rules_with_text(path, "", "none");
    };
    let text = String::from_utf8_lossy(&bytes);
    rules_with_text(path, &text, &sha256(&text))
}

pub fn save_execution_router_rules(text: &str, path: &str) -> Result<Value, String> {
    let parent = Path::new(path)
        .parent()
        .ok_or_else(|| "No directory for router rules path".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())?;
    Ok(rules_with_text(path, text, &sha256(text)))
}

pub fn load_routing_policy(path: &str, rules_path: &str) -> Value {
    let rules = load_execution_router_rules(rules_path);
    let Ok(bytes) = fs::read(path) else {
        return json!({"path":null,"hash":"none","policy":{},"snapshot":{},"rules":rules});
    };
    let text = String::from_utf8_lossy(&bytes);
    let Ok(parsed) = serde_json::from_str::<Value>(&text) else {
        return json!({"path":null,"hash":"none","policy":{},"snapshot":{},"rules":rules});
    };
    let policy = safe_policy(&parsed);
    json!({"path":path,"hash":sha256(&text),"snapshot":policy,"policy":policy,"rules":rules})
}

pub fn policy_allows(candidate: &Value, policy: &Value) -> bool {
    let provider = candidate["provider"].as_str().unwrap_or("");
    if policy["disabledProviders"]
        .as_array()
        .is_some_and(|values| values.iter().any(|v| v.as_str() == Some(provider)))
    {
        return false;
    }
    if let Some(profile) = candidate["profile"]
        .as_str()
        .filter(|profile| !profile.is_empty())
    {
        if policy["disabledProfiles"]
            .as_array()
            .is_some_and(|values| values.iter().any(|v| v.as_str() == Some(profile)))
        {
            return false;
        }
    }
    true
}

pub fn policy_rank(candidate: &Value, task_kind: Option<&str>, policy: &Value) -> i32 {
    let provider = candidate["provider"].as_str().unwrap_or("");
    let profile = candidate["profile"]
        .as_str()
        .filter(|value| !value.is_empty());
    let mut preferred = policy["preferredProviders"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(policy["preferredProfiles"].as_array().into_iter().flatten());
    let preferred = preferred.any(|item| {
        item.as_str() == Some(provider) || profile.is_some_and(|value| item.as_str() == Some(value))
    });
    let quality = task_kind
        .filter(|value| !value.is_empty())
        .and_then(|task| policy["qualityByTaskKind"].get(task))
        .and_then(Value::as_array)
        .is_some_and(|values| values.iter().any(|item| item == &candidate["id"]));
    (if preferred { 2 } else { 0 }) + (if quality { 1 } else { 0 })
}
