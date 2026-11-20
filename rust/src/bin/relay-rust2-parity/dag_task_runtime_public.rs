// Original dag-task-runtime.ts public API differential: unifiedDAG /
// dagCoordinator predicates, reconcileDAGTasks over real Graph fixtures with
// an in-memory job snapshot (wave materialization, dependency gating,
// predecessor output propagation, coordinator start/completion), and
// selectDAGReviewExecutors routing. Both stacks use the real graph parser
// and task entity factory; the store mutation is a candidate snapshot on
// both sides (Node mutates a clone under mutateJob, Rust mutates the job
// value).
use agents_relay_rust2::dag_task_runtime::{
    dag_coordinator, reconcile_dag_tasks, select_dag_review_executors,
    unified_dag,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn scratch(label: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "rust2-dag-{}-{}",
        label,
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("scratch dir");
    dir
}

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certDagTaskRuntime" {
        return None;
    }
    Some((|| {
        match request["method"].as_str().unwrap_or("") {
            "predicates" => {
                let task = &request["task"];
                Ok(json!({"ok":true,
                    "unifiedDag":unified_dag(&json!({}),task),
                    "dagCoordinator":dag_coordinator(task)}).to_string())
            }
            "reconcile" => {
                // Deterministic entity ids need a stable store dir per case.
                let store_dir = scratch("store");
                let graph_dir = scratch("graph");
                let project = scratch("project");
                let job = request["job"].clone();
                let roots = json!({});
                // Mirror Node discoverScriptAgent over a REAL project
                // agents directory: the fixture creates the same marker
                // files the Node side creates, so both stacks resolve the
                // same executor kind from the filesystem.
                let agents_dir = project.join("agents");
                std::fs::create_dir_all(&agents_dir).map_err(|e| e.to_string())?;
                for name in request["scriptAgents"].as_array()
                    .map(Vec::as_slice).unwrap_or(&[]) {
                    if let Some(name) = name.as_str() {
                        std::fs::write(
                            agents_dir.join(format!("{name}.agent.md")),
                            "# agent",
                        ).map_err(|e| e.to_string())?;
                    }
                }
                let agents_dir = agents_dir.to_string_lossy().to_string();
                let is_script = move |agent: &str,
                                      _project: &Path,
                                      _roots: &Value| {
                    Ok(std::path::Path::new(&agents_dir)
                        .join(format!("{agent}.agent.md")).exists())
                };
                match reconcile_dag_tasks(&graph_dir, &store_dir, &job,
                    &project, &roots, is_script) {
                    Ok(updated) => {
                        let _ = std::fs::remove_dir_all(&store_dir);
                        let _ = std::fs::remove_dir_all(&graph_dir);
                        Ok(json!({"ok":true,"job":normalize(&updated),
                            "dagNodeResults":dag_node_results(&updated)}).to_string())
                    }
                    Err(error) => {
                        let _ = std::fs::remove_dir_all(&store_dir);
                        let _ = std::fs::remove_dir_all(&graph_dir);
                        Ok(json!({"ok":false,"error":error}).to_string())
                    }
                }
            }
            "selectReview" => {
                match select_dag_review_executors(&request["job"]) {
                    Ok(updated) => Ok(json!({"ok":true,"job":normalize(&updated)}).to_string()),
                    Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
                }
            }
            value => Err(format!("Unknown dag task runtime method {value}")),
        }
    })())
}

fn normalize(job: &Value) -> Value {
    let mut out = job.clone();
    if let Some(tasks) = out.get_mut("tasks").and_then(Value::as_array_mut) {
        for task in tasks.iter_mut() {
            // Generated ids/timestamps normalize to stable tokens.
            let is_generated = task.get("id").and_then(Value::as_str)
                .is_some_and(|id| id.starts_with("dag:") || id.len() >= 32);
            if is_generated {
                let parent = task.pointer("/dagNode/parentTaskId").cloned();
                let node = task.pointer("/dagNode/nodeId").cloned();
                let agent = task.get("agentName").cloned()
                    .unwrap_or(json!("?"));
                if let (Some(parent), Some(node), Some(slot)) =
                    (parent, node, task.get_mut("id"))
                {
                    *slot = json!(format!(
                        "<dag-id:{}/{}/{}>", parent, node, agent));
                }
            }
            for key in ["createdAt", "updatedAt"] {
                if let Some(slot) = task.get_mut(key) {
                    if slot.as_str().is_some() {
                        *slot = json!("<now>");
                    }
                }
            }
            // Output paths embed scratch dirs; read first, then write.
            let path = task.pointer("/output/path")
                .and_then(Value::as_str).map(str::to_owned);
            if let Some(path) = path {
                if let Some(slot) = task.pointer_mut("/output/path") {
                    *slot = json!(path
                        .split(".dag-node-results").last().unwrap_or(&path)
                        .to_string());
                }
            }
        }
    }
    out
}

fn dag_node_results(job: &Value) -> Value {
    // The input JSON embeds the outputPath; keep only the suffix so both
    // stacks compare the same shape.
    let mut out = Vec::<Value>::new();
    if let Some(tasks) = job.get("tasks").and_then(Value::as_array) {
        for task in tasks {
            let Some(input) = task.get("input").and_then(Value::as_str) else {
                continue;
            };
            if !input.contains("relay-dag-task") {
                continue;
            }
            if let Ok(mut parsed) =
                serde_json::from_str::<Value>(input)
            {
                if let Some(path) = parsed.get("outputPath")
                    .and_then(Value::as_str).map(str::to_owned) {
                    parsed["outputPath"] = json!(path
                        .split(".dag-node-results").last().unwrap_or(&path));
                }
                parsed["taskId"] = json!("<dag-id>");
                parsed["jobId"] = json!(job.get("id"));
                parsed["predecessorOutputs"] = parsed
                    .get("predecessorOutputs").cloned()
                    .unwrap_or(json!({}));
                out.push(parsed);
            }
        }
    }
    Value::Array(out)
}
