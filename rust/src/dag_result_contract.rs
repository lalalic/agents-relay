// Direct port of src/dag-result-contract.ts: a malformed DAG output must never
// complete the Coordinator. The existing Rust stage contract is the only gate.
use crate::dag_stage_contract::{validate_dag_stage_gate, StageExecution};
use serde_json::Value;
use std::{
    fs,
    path::{Path, PathBuf},
};

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn dirname_twice(path: &Path) -> PathBuf {
    path.parent()
        .unwrap_or_else(|| Path::new("."))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .to_path_buf()
}
pub fn dag_completion_error<F>(
    task: &Value,
    project_path: Option<&Path>,
    interpreter: &str,
    mut execute: F,
) -> Option<String>
where
    F: FnMut(&[String], &Path) -> Result<StageExecution, String>,
{
    if !truthy(&task["dagNode"]) {
        return None;
    }
    if task["output"]["kind"] != "file" {
        return Some("DAG Agent Task has no file result target".into());
    }
    let path = Path::new(task["output"]["path"].as_str().unwrap_or(""));
    // Node readFile(..., 'utf8') decodes invalid UTF-8 lossily and reports
    // filesystem errors with the attempted path, not Rust's OS error suffix.
    let parsed: Value = match fs::read(path)
        .map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => format!(
                "ENOENT: no such file or directory, open '{}'",
                path.display()
            ),
            std::io::ErrorKind::PermissionDenied => {
                format!("EACCES: permission denied, open '{}'", path.display())
            }
            _ => error.to_string(),
        })
        .and_then(|bytes| {
            serde_json::from_str(&String::from_utf8_lossy(&bytes))
                .map_err(|error| error.to_string())
        }) {
        Ok(p) => p,
        Err(e) => return Some(format!("DAG Agent result unreadable: {e}")),
    };
    if !parsed.is_object() {
        return Some("DAG Agent result is not an object".into());
    }
    if parsed["status"] != "COMPLETED" || !parsed["output"].is_object() {
        return Some("DAG Agent result must contain status COMPLETED and an output object".into());
    }
    let artifacts = &parsed["artifacts"];
    if !(artifacts.is_object()
        || artifacts
            .as_array()
            .is_some_and(|a| a.iter().all(Value::is_string)))
    {
        return Some("DAG Agent result must contain a list or object of artifacts".into());
    }
    if let (Some(project), Some(agent)) = (
        project_path,
        task["agentName"].as_str().filter(|s| !s.is_empty()),
    ) {
        if let Err(error) = validate_dag_stage_gate(
            project,
            agent,
            &dirname_twice(path),
            interpreter,
            |args, cwd| execute(args, cwd),
        ) {
            return Some(format!(
                "DAG Stage contract rejected Task completion: {error}"
            ));
        }
    }
    None
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn missing_and_invalid_output() {
        let dir = std::env::temp_dir().join(format!("rust2-dag-result-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let target = dir.join("result.json");
        let task =
            json!({"dagNode":{"nodeId":"a"},"output":{"kind":"file","path":target.to_str()}});
        let noop = |_: &[String], _: &Path| -> Result<StageExecution, String> {
            panic!("validator not requested")
        };
        assert_eq!(dag_completion_error(&json!({}), None, "node", noop), None);
        assert!(dag_completion_error(&task, None, "node", noop)
            .unwrap()
            .contains("unreadable"));
        fs::write(&target, "{}").unwrap();
        assert!(dag_completion_error(&task, None, "node", noop)
            .unwrap()
            .contains("status COMPLETED"));
        fs::write(
            &target,
            r#"{"status":"COMPLETED","output":{},"artifacts":[{}]}"#,
        )
        .unwrap();
        assert!(dag_completion_error(&task, None, "node", noop)
            .unwrap()
            .contains("artifacts"));
        fs::write(
            &target,
            r#"{"status":"COMPLETED","output":{},"artifacts":[]}"#,
        )
        .unwrap();
        assert_eq!(dag_completion_error(&task, None, "node", noop), None);
        let _ = fs::remove_dir_all(dir);
    }
}
