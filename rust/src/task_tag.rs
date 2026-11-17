// Port of src/task-tag.ts: parse job tags and sanitize reported tag event data.
use serde_json::{json, Map, Value};
fn js_space(c: char) -> bool {
    matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}
fn js_keys(map: &Map<String, Value>) -> Vec<String> {
    let mut indices = Vec::new();
    let mut other = Vec::new();
    for key in map.keys() {
        let index = key
            .parse::<u32>()
            .ok()
            .filter(|n| *n < u32::MAX && n.to_string() == *key);
        if let Some(i) = index {
            indices.push((i, key.clone()))
        } else {
            other.push(key.clone())
        }
    }
    indices.sort_by_key(|x| x.0);
    indices.into_iter().map(|x| x.1).chain(other).collect()
}
pub fn parse_job_tag(raw: &str) -> Result<Value, String> {
    if raw.is_empty() {
        return Ok(Value::Null);
    }
    let v: Value = serde_json::from_str(raw).map_err(|_| "--tag must be valid JSON".to_string())?;
    if !v.is_object() {
        return Err("--tag must be a JSON object".into());
    }
    let d = v["description"]
        .as_str()
        .ok_or("--tag.description must be a non-empty string up to 500 characters")?;
    if js_trim(d).is_empty() || d.encode_utf16().count() > 500 {
        return Err("--tag.description must be a non-empty string up to 500 characters".into());
    }
    let vals = v["values"]
        .as_object()
        .ok_or("--tag.values must be a non-empty object")?;
    if vals.is_empty() {
        return Err("--tag.values must be a non-empty object".into());
    }
    let mut result = Map::new();
    for k in js_keys(vals) {
        let x = &vals[&k];
        if k.is_empty()
            || k.encode_utf16().count() > 64
            || !k
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
        {
            return Err(format!("--tag.values contains invalid value {k}"));
        }
        let s = x.as_str().ok_or_else(|| {
            format!("--tag.values.{k} must be a non-empty string up to 32 characters")
        })?;
        if s.is_empty() || s.encode_utf16().count() > 32 {
            return Err(format!(
                "--tag.values.{k} must be a non-empty string up to 32 characters"
            ));
        }
        result.insert(k.clone(), json!(s));
    }
    Ok(json!({"description":d,"values":result}))
}
pub fn parse_job_tag_json(raw: &str) -> Result<Value, String> {
    parse_job_tag(raw)
}
pub fn accepted_reported_tag(job: &Value, data: &Value) -> Value {
    let t = data["tag"].as_str();
    if let Some(s) = t {
        if job["tag"]["values"].get(s).is_some() {
            return json!(s);
        }
    }
    Value::Null
}
pub fn event_data_without_tag(data: &Value) -> Value {
    let Some(obj) = data.as_object() else {
        return data.clone();
    };
    if !obj.contains_key("tag") {
        return data.clone();
    }
    let mut out = obj.clone();
    out.remove("tag");
    if out.is_empty() {
        Value::Null
    } else {
        Value::Object(out)
    }
}
pub fn task_tag_worker_prompt(job: &Value) -> String {
    if job.get("tag").is_none() || job["tag"].is_null() {
        return String::new();
    }
    let description = job["tag"]["description"].as_str().unwrap_or("");
    let names = job["tag"]["values"]
        .as_object()
        .map(js_keys)
        .unwrap_or_default();
    format!("[Job-defined Task tag]\nMeaning/when to set it: {description}\nAllowed values: {}\nWhen applicable, report exactly one allowed value in the terminal event as data.tag. The tag is separate from Task lifecycle state.\n\n", serde_json::to_string(&names).unwrap_or_else(|_| "[]".into()))
}
