//! Coordinator creation is reserved for a declared, file-backed Project Run.
//! This is input-shape validation at the CLI boundary, not an authentication
//! mechanism or a dependency on the caller's harness implementation.
use crate::cli_core_support::arg;
use serde_json::Value;
use std::{fs, path::{Path, PathBuf}};

fn canonical_file(path: &Path, label: &str) -> Result<PathBuf, String> {
    let resolved = fs::canonicalize(path)
        .map_err(|error| format!("{label} is unavailable: {error}"))?;
    if !resolved.is_file() { return Err(format!("{label} must be a regular file")); }
    Ok(resolved)
}

/// A Project Runner supplies its own declared manifest, selected .mmd Graph,
/// and private Run-local input/output. Arbitrary Relay Jobs cannot invent a
/// Coordinator with inline or free-standing graph input.
pub fn validate_project_run(args: &[String]) -> Result<(), String> {
    let get = |flag| arg(args, flag, "");
    let manifest_arg = get("--project-run-manifest");
    if manifest_arg.is_empty() {
        return Err("Coordinator is only supported by neo project run with a declared .mmd graph (--project-run-manifest)".into());
    }
    let project = fs::canonicalize(get("--coordinator-project-root"))
        .map_err(|e| format!("Coordinator project root is unavailable: {e}"))?;
    let workspace = fs::canonicalize(get("--coordinator-workspace-root"))
        .map_err(|e| format!("Project workspace root is unavailable: {e}"))?;
    if project.parent() != Some(workspace.as_path()) {
        return Err("Coordinator project must be an independent direct child of its workspace root".into());
    }
    let manifest = canonical_file(Path::new(manifest_arg), "Project Run declaration")?;
    if !manifest.starts_with(&project) ||
        manifest != canonical_file(&project.join("project.run.json"), "Project Run declaration")? {
        return Err("Project Run declaration does not belong to the selected project".into());
    }
    for name in ["AGENTS.md", "README.md", "graph.mmd"] {
        let file = canonical_file(&project.join(name), name)?;
        if !file.starts_with(&project) {
            return Err(format!("{name} escapes the project root"));
        }
    }
    let declaration: Value = serde_json::from_slice(&fs::read(&manifest)
        .map_err(|e| format!("Cannot read Project Run declaration: {e}"))?)
        .map_err(|e| format!("Invalid Project Run declaration: {e}"))?;
    if declaration["schemaVersion"] != 1 ||
        !matches!(declaration["input"]["type"].as_str(), Some("path" | "url")) {
        return Err("Project Run declaration must have schemaVersion 1 and a supported input type".into());
    }
    let graph = canonical_file(Path::new(get("--coordinator-graph-file")), "Project DAG graph")?;
    if graph.extension().and_then(|s| s.to_str()) != Some("mmd") || !graph.starts_with(&project) {
        return Err("Coordinator graph must be a project-contained .mmd file".into());
    }
    let mut declared = vec![canonical_file(&project.join("graph.mmd"), "Project default graph")?];
    if let Some(graphs) = declaration.get("graphs").and_then(Value::as_object) {
        for named in graphs.values() {
            if let Some(name) = named.as_str() {
                if !name.contains('/') && !name.contains('\\') && name.ends_with(".mmd") && name != ".." {
                    if let Ok(file) = canonical_file(&project.join(name), "Named Project graph") {
                        if file.starts_with(&project) { declared.push(file); }
                    }
                }
            }
        }
    }
    if !declared.contains(&graph) {
        return Err("Coordinator graph must be graph.mmd or a named graph declared in project.run.json".into());
    }
    let run_root = fs::canonicalize(project.join("runs"))
        .map_err(|e| format!("Project runs directory is unavailable: {e}"))?;
    if !run_root.starts_with(&project) {
        return Err("Project runs directory escapes the project root".into());
    }
    let input = canonical_file(Path::new(get("--coordinator-input-file")), "Run input")?;
    let output_dir = fs::canonicalize(Path::new(get("--coordinator-output-path"))
        .parent().ok_or("Coordinator output requires a Run directory")?)
        .map_err(|e| format!("Run output directory is unavailable: {e}"))?;
    if !input.starts_with(&run_root) || !output_dir.starts_with(&run_root) ||
        input.parent() != Some(output_dir.as_path()) || output_dir == run_root {
        return Err("Coordinator input and output must belong to the same private Project Run directory".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};
    #[test]
    fn project_run_only_accepts_declared_mmd_and_private_run() {
        let id = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let base = std::env::temp_dir().join(format!("relay-project-mode-{}-{id}", std::process::id()));
        let project = base.join("vlog");
        let run = project.join("runs").join("2026-11-22");
        fs::create_dir_all(&run).unwrap();
        for (path, body) in [
            (project.join("README.md"), "readme"),
            (project.join("AGENTS.md"), "agents"),
            (project.join("graph.mmd"), "flowchart TD\na[agent:a]"),
            (project.join("graph-other.mmd"), "flowchart TD\nb[agent:b]"),
            (project.join("project.run.json"), r#"{"schemaVersion":1,"input":{"type":"path"},"graphs":{"other":"graph-other.mmd"}}"#),
            (run.join("neo-project-run.input.md"), "input"),
        ] { fs::write(path,body).unwrap(); }
        let mut args = vec![
            "--project-run-manifest".into(), project.join("project.run.json").to_string_lossy().into(),
            "--coordinator-project-root".into(), project.to_string_lossy().into(),
            "--coordinator-workspace-root".into(), base.to_string_lossy().into(),
            "--coordinator-graph-file".into(), project.join("graph.mmd").to_string_lossy().into(),
            "--coordinator-input-file".into(), run.join("neo-project-run.input.md").to_string_lossy().into(),
            "--coordinator-output-path".into(), run.join("neo-project-run.result.json").to_string_lossy().into(),
        ];
        let mut without_mode = args.clone();
        without_mode.drain(0..2);
        assert!(validate_project_run(&without_mode).unwrap_err().contains("neo project run"));
        assert!(validate_project_run(&args).is_ok());
        args[7] = project.join("graph-other.mmd").to_string_lossy().into();
        assert!(validate_project_run(&args).is_ok(), "named project graph must work");
        fs::write(project.join("project.run.json"), r#"{"schemaVersion":1,"input":{"type":"path"}}"#).unwrap();
        assert!(validate_project_run(&args).unwrap_err().contains("named graph"));
        args[7] = project.join("graph.mmd").to_string_lossy().into();
        args[1] = project.join("graph.mmd").to_string_lossy().into();
        assert!(validate_project_run(&args).unwrap_err().contains("declaration"));
        args[1] = project.join("project.run.json").to_string_lossy().into();
        args[11] = base.join("outside.json").to_string_lossy().into();
        assert!(validate_project_run(&args).is_err());
        fs::remove_dir_all(base).unwrap();
    }
}
