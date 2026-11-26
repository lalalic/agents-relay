//! Platform-independent Prompt Parts, produced read-only for Neo or another
//! Harness client. The caller is solely responsible for platform assembly.
//! This path has no durable Relay Job, daemon or model-provider dependency.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashSet, fs, io::Read, path::Path};
pub const REQUEST_SCHEMA: &str = "relay.prompt-parts.request.v1";
pub const RESPONSE_SCHEMA: &str = "relay.prompt-parts.v1";

fn source(value: &Value, kind: &str) -> Result<Value, String> {
    let name = value
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("{kind} source path is required"))?;
    let path = Path::new(name);
    if !path.is_absolute() {
        return Err(format!("{kind} source path must be absolute"));
    }
    let real = path
        .canonicalize()
        .map_err(|e| format!("{kind} source unavailable: {e}"))?;
    let metadata = fs::metadata(&real).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > 1024 * 1024 {
        return Err(format!("{kind} must be a nonempty file under 1 MiB"));
    }
    let text =
        fs::read_to_string(&real).map_err(|e| format!("{kind} source cannot be read: {e}"))?;
    if text.trim().is_empty() {
        return Err(format!("{kind} source contains no instructions"));
    }
    let sha256 = format!("{:x}", Sha256::digest(text.trim().as_bytes()));
    Ok(json!({"content":text.trim(),"source":real.to_string_lossy(),"sha256":sha256}))
}
pub fn build(input: &Value) -> Result<Value, String> {
    if input["schema"] != REQUEST_SCHEMA {
        return Err("Unrecognized Prompt Parts request schema".into());
    }
    let global = source(&input["globalPath"], "Global")?;
    let harness = source(&input["harnessRulesPath"], "Harness")?;
    let skills = input["skills"]
        .as_array()
        .ok_or("Expected Skill catalog array")?;
    if skills.len() > 2048 {
        return Err("Skill catalog exceeds safe bound".into());
    }
    let mut seen = HashSet::new();
    for skill in skills {
        let name = skill["name"]
            .as_str()
            .filter(|v| !v.trim().is_empty())
            .ok_or("Skill has no name")?;
        if !seen.insert(name) {
            return Err(format!("Duplicate Skill name: {name}"));
        }
        let path = skill["absolutePath"]
            .as_str()
            .ok_or("Skill has no absolutePath")?;
        if !Path::new(path).is_absolute() {
            return Err("Skill absolutePath must be absolute".into());
        }
        if skill["path"] != path {
            return Err("Skill path and absolutePath differ".into());
        }
        if !skill["available"].is_boolean() {
            return Err("Skill availability must be explicit".into());
        }
    }
    // The fingerprint describes the exact normalized baseline content, not
    // a model's hidden platform instructions or any provider transport.
    let canonical = json!({"schema":RESPONSE_SCHEMA,"global":global,"harness":harness,
        "skills":skills});
    let fingerprint = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&canonical).map_err(|e| e.to_string())?)
    );
    let mut result = canonical;
    result["fingerprint"] = json!(fingerprint);
    Ok(result)
}
pub fn read_stdin() -> Result<Value, String> {
    let mut data = Vec::new();
    std::io::stdin()
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut data)
        .map_err(|e| format!("Cannot read Prompt Parts request: {e}"))?;
    if data.len() > 4 * 1024 * 1024 {
        return Err("Prompt Parts request exceeds 4 MiB".into());
    }
    let value: Value =
        serde_json::from_slice(&data).map_err(|e| format!("Invalid Prompt Parts JSON: {e}"))?;
    build(&value)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_parts_for_any_provider() {
        let root = std::env::temp_dir().join(format!("relay-prompt-parts-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("AGENTS.md"), "global").unwrap();
        fs::write(root.join("harness.md"), "harness").unwrap();
        let mut input = json!({"schema":REQUEST_SCHEMA,
            "globalPath":root.join("AGENTS.md"),"harnessRulesPath":root.join("harness.md"),
            "skills":[]});
        let mut fingerprints = Vec::new();
        for provider in ["z.ai", "openai", "deepseek", "webchat"] {
            input["provider"] = json!(provider);
            let result = build(&input).unwrap();
            fingerprints.push(result["fingerprint"].as_str().unwrap().to_owned());
        }
        assert!(fingerprints.iter().all(|v| v == &fingerprints[0]));
        assert!(build(&json!({})).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}
