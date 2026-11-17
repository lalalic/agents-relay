// Port of src/dag-stage-contract.ts: validate a declared DAG stage gate and invoke its isolated verifier.
use serde_json::Value;
use std::{fs, path::Path};

#[derive(Clone, Debug)]
pub struct StageExecution {
    pub stdout: String,
    pub stderr: String,
    pub code: i32,
}
fn within(root: &Path, target: &Path) -> bool {
    target.strip_prefix(root).is_ok()
}
fn stage_id(value: &str) -> bool {
    !value.is_empty() && value.bytes().all(|b| b.is_ascii_lowercase() || b == b'-')
}
fn script_path(value: &str) -> bool {
    value.strip_prefix("scripts/").is_some_and(|rest| {
        !rest.is_empty()
            && rest.ends_with(".mjs")
            && !rest[..rest.len() - 4].is_empty()
            && rest[..rest.len() - 4]
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    })
}
pub fn validate_dag_stage_gate<F>(
    project_path: &Path,
    agent: &str,
    run_path: &Path,
    interpreter: &str,
    mut execute: F,
) -> Result<(), String>
where
    F: FnMut(&[String], &Path) -> Result<StageExecution, String>,
{
    let root = fs::canonicalize(project_path).map_err(|e| e.to_string())?;
    let manifest_path = root.join("project.run.json");
    let text = match fs::read_to_string(&manifest_path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.to_string()),
    };
    let manifest: Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let config = &manifest["stageValidation"];
    if !config.is_object() {
        return Ok(());
    }
    let declaration = config;
    let agents = &declaration["agents"];
    if !agents.is_object() {
        return Err("Invalid Stage validator agent mapping".into());
    }
    let Some(stage) = agents.get(agent) else {
        return Ok(());
    };
    if !stage.is_string() {
        return Err("Invalid declared Stage ID".into());
    }
    let stage = stage.as_str().unwrap_or("");
    if !stage_id(stage) {
        return Err("Invalid declared Stage ID".into());
    }
    let script = &declaration["script"];
    if !script.is_string() {
        return Err("Invalid Stage validator script".into());
    }
    let script = script.as_str().unwrap_or("");
    if !script_path(script) {
        return Err("Invalid Stage validator script".into());
    }
    let file = fs::canonicalize(root.join(script)).map_err(|e| e.to_string())?;
    if !within(&root, &file) {
        return Err("Stage validator escaped project root".into());
    }
    let run = fs::canonicalize(run_path).map_err(|e| e.to_string())?;
    let runs = fs::canonicalize(root.join("runs")).map_err(|e| e.to_string())?;
    if !within(&runs, &run) || run == root {
        return Err("Stage validator run escaped project runs".into());
    }
    let args = vec![
        interpreter.to_owned(),
        file.to_string_lossy().into_owned(),
        stage.to_owned(),
        run.to_string_lossy().into_owned(),
    ];
    let response = execute(&args, &root)?;
    let report: Value = serde_json::from_str(&response.stdout)
        .map_err(|_| "Stage validator did not return a structured contract result".to_string())?;
    if response.code != 0
        || report["stage"] != stage
        || report["status"] != "PASS"
        || (report["errors"].is_array() && !report["errors"].as_array().is_some_and(Vec::is_empty))
    {
        let detail: String = if let Some(errors) = report["errors"].as_array() {
            serde_json::to_string(errors)
                .unwrap_or_default()
                .chars()
                .take(1200)
                .collect()
        } else {
            response.stderr.chars().take(1200).collect()
        };
        return Err(format!("STAGE_CONTRACT_FAILED {stage}: {detail}"));
    }
    Ok(())
}
