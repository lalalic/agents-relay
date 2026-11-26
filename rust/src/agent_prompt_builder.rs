//! One managed Prompt Builder: effective inherited Agent role + exact Task
//! identity + explicitly loaded required dependencies and optional references.
//! No legacy flattened prompts, first-read fallback or alternate assembly.
use crate::js_text::trim_js;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

#[derive(Debug, Clone, serde::Serialize)]
pub struct PromptLayers {
    pub system: String,
    pub user: String,
    pub references: Vec<Value>,
}
impl PromptLayers {
    pub fn new(system: String, user: String, references: Vec<Value>) -> Result<Self, String> {
        if system.trim().is_empty() || user.trim().is_empty() {
            return Err("Agent system and user assignment must be nonempty".into());
        }
        if references.iter().any(|r| {
            let kind = r["kind"].as_str().unwrap_or("");
            if kind == "required-skill-name" {
                r["name"].as_str().is_none_or(str::is_empty)
            } else {
                r["path"]
                    .as_str()
                    .is_none_or(|p| !Path::new(p).is_absolute())
                    || kind.is_empty()
            }
        }) {
            return Err("References require absolute paths and explicit kind".into());
        }
        Ok(Self {
            system,
            user,
            references,
        })
    }
    /// Diagnostic identity of *canonical prompt data*; never validates files or
    /// blocks content changes. This fingerprint is only for report comparison.
    /// Stable identity independent of provider,
    /// model, route, and transport. The execution binding and chosen references
    /// are intentionally included: different Task/attempt inputs are not equal.
    pub fn fingerprint(&self) -> String {
        let canonical = json!({
            "schema":"relay.prompt-layers.v1",
            "system":self.system,
            "user":self.user,
            "references":self.references
        });
        format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&canonical).expect("PromptLayers are JSON-serializable")
            )
        )
    }
}
fn string_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn references(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
// File validation uses canonical path, actual readability and bounded size;
// NEVER a content digest, matching hash or version-pinned SHA.
pub fn prompt_file_reference(path: &str, role: &str) -> Result<Value, String> {
    if !Path::new(path).is_absolute() {
        return Err(format!("Prompt reference must be absolute: {path}"));
    }
    let file = fs::canonicalize(path)
        .map_err(|e| format!("Prompt reference resolution failed at {path}: {e}"))?;
    let info = fs::metadata(&file).map_err(|e| e.to_string())?;
    if !info.is_file() || info.len() == 0 || info.len() > 1024 * 1024 {
        return Err(format!(
            "Prompt reference must be a nonempty file under 1MiB: {}",
            file.display()
        ));
    }
    Ok(json!({"path":file.to_string_lossy(),"role":role}))
}
fn read_required(path: &str, kind: &str) -> Result<String, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Required {kind} cannot be read at {path}: {e}"))?;
    if raw.trim().is_empty() {
        return Err(format!("Required {kind} is empty: {path}"));
    }
    Ok(raw)
}
fn with_execution_binding(text: &str, input: &Value) -> Result<String, String> {
    let mut result = text.to_owned();
    for (placeholder, key) in [
        ("{{repository}}", "repository"),
        ("{{jobId}}", "jobId"),
        ("{{taskId}}", "taskId"),
        ("{{executionId}}", "executionId"),
    ] {
        if result.contains(placeholder) {
            let value = string_field(input, key);
            if value.is_empty() {
                return Err(format!("Contract binding requires {key}"));
            }
            result = result.replace(placeholder, value)
        }
    }
    if result.contains("{{") {
        return Err("Unresolved required Contract placeholder".into());
    }
    Ok(result)
}

/// The sole managed Prompt Builder. The effective inherited Agent is
/// trusted System content; this Task's identity and dynamic values stay User.
/// Declared references are locators, never inline source text.
pub fn build_relay_work_prompt(
    input: &Value,
    _snapshot_dir: Option<&str>,
) -> Result<PromptLayers, String> {
    let job = string_field(input, "jobId");
    let task = string_field(input, "taskId");
    let execution = string_field(input, "executionId");
    if job.is_empty() || task.is_empty() || execution.is_empty() {
        return Err("Relay prompt requires a full execution binding".into());
    }
    let role = trim_js(string_field(input, "agentContent"));
    if role.is_empty() {
        return Err("Effective Agent instructions are required".into());
    }
    // The Prompt Builder is intentionally policy-free. All role-specific
    // instructions and selected document dependencies belong to the effective
    // Agent definition, never to a hardcoded Worker/Planner/DAG branch.
    let mut seen = std::collections::HashSet::new();
    let mut selected = Vec::<Value>::new();
    let mut required_contents = Vec::<(String, String, String)>::new();
    for item in references(&input["references"]) {
        let kind = string_field(&item, "kind");
        if !matches!(kind, "context" | "contract") {
            return Err(format!("Unsupported Agent reference kind: {kind}"));
        }
        let reference = prompt_file_reference(string_field(&item, "path"), kind)?;
        let path = string_field(&reference, "path").to_owned();
        if seen.insert(path.clone()) {
            let required = kind == "context";
            if required {
                let contents = read_required(&path, kind)?;
                required_contents.push((kind.into(), path.clone(), contents));
            }
            selected.push(json!({"kind":kind,"path":path,
                "delivery":if required{"inline-user"}else{"on-demand"},
                "loaded":required}));
        }
    }
    // The Loader already loaded required Contracts into trusted instructions.
    // Record where they came from, without computing or checking file hashes.
    for record in references(&input["startupContracts"]) {
        let path = record["path"]
            .as_str()
            .filter(|path| Path::new(path).is_absolute())
            .ok_or("Startup Contract provenance requires an absolute path")?;
        if record["kind"] != "startup-contract"
            || record["placement"] != "system"
            || record["loaded"] != true
            || !Path::new(path).is_file()
        {
            return Err("Invalid loaded startup Contract provenance".into());
        }
        if seen.insert(path.into()) {
            selected.push(json!({"kind":"startup-contract","path":path,
                "delivery":"trusted-system","loaded":true}));
        }
    }
    if selected.iter().filter(|r| r["kind"] == "context").count() > 1 {
        return Err("Harness may select at most one directory Context".into());
    }
    // These are execution facts, not behavioral contracts. The Agent must
    // retrieve full Task/Plan state from the authorized CLI itself.
    let mut user = vec![
        "# Execution binding".to_owned(),
        format!("Job: {job}"),
        format!("Task: {task}"),
        format!("Execution: {execution}"),
        format!("Project: {}", string_field(input, "projectPath")),
    ];
    if let Some(repo) = input["repository"].as_str().filter(|s| !s.is_empty()) {
        user.push(format!("Repository: {repo}"));
    }
    user.push(format!(
        "EVENT SOURCE (exact): job/{job}/task/{task}/execution/{execution}"
    ));
    if let Some(title) = input["taskTitle"].as_str().filter(|s| !s.trim().is_empty()) {
        user.push(format!(
            "Assignment title: {}",
            serde_json::to_string(title).map_err(|e| e.to_string())?
        ));
    }
    if let Some(instructions) = input["taskInstructions"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
    {
        user.push(with_execution_binding(instructions.trim(), input)?);
    }
    let suggested = references(&input["suggestedSkills"]);
    if !suggested.is_empty() {
        user.push(format!(
            "Suggested Skills: {}",
            suggested
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    // Native CLI identity is a task fact, not a role or provider policy.
    if let Some(cli) = input["relayCli"].as_str().filter(|v| !v.is_empty()) {
        if !Path::new(cli).is_absolute() {
            return Err("Relay CLI binding must be an absolute path".into());
        }
        user.push(format!("Relay CLI: {cli}"));
    }
    if selected.is_empty() {
        user.push("Declared references: none".into());
    } else {
        user.push("## Verified references (no hash validation)".into());
        for record in &selected {
            user.push(format!(
                "- {}: {} ({})",
                string_field(record, "kind"),
                string_field(record, "path"),
                string_field(record, "delivery")
            ));
        }
    }
    // Selected project AGENTS.md is explicitly included at lower priority.
    // Skill names, not Skill files, are supplied separately. The Agent uses
    // the Harness Skills List to locate/read the matching SKILL.md.
    for (kind, path, contents) in required_contents {
        user.push(format!(
            "## Loaded required {kind}\nSource: {path}\nProject/Skill reference text (lower priority than trusted Agent and Contracts; JSON-encoded literal):\n{}",
            serde_json::to_string(&contents).map_err(|e|e.to_string())?
        ));
    }
    let required_skills = references(&input["requiredSkillNames"]);
    let mut required_skill_directive = None;
    if !required_skills.is_empty() {
        let mut names = Vec::<String>::new();
        for value in required_skills {
            let name = value
                .as_str()
                .filter(|s| {
                    !s.is_empty()
                        && s.len() <= 128
                        && s.bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
                })
                .ok_or("Required Skills must be declared as names")?;
            if !names.iter().any(|existing| existing == name) {
                names.push(name.to_owned());
            }
        }
        required_skill_directive=Some(format!(
            "# Required Skill names from effective Agent declaration\n{}\nLocate these names through the current Harness Skills List; read the matching SKILL.md before use. If unavailable, report a real failure. Never infer a path or claim loaded before reading.",
            names.join(", ")
        ));
        for name in names {
            selected.push(json!({"kind":"required-skill-name","name":name,
                "delivery":"harness-skills-list","loaded":false}));
        }
    }
    let mut effective_system = match input["trustedRuntimePolicy"]
        .as_str()
        .filter(|text| !text.trim().is_empty())
    {
        Some(protocol) => format!(
            "{role}\n\n{}",
            with_execution_binding(protocol.trim(), input)?
        ),
        None => role.to_owned(),
    };
    if let Some(directive) = required_skill_directive {
        effective_system.push_str("\n\n");
        effective_system.push_str(&directive);
    }
    PromptLayers::new(effective_system, user.join("\n"), selected)
}
