//! Canonical DAG structural facts, output parsing and child input materialization.
use super::DAGMaterialize;
use crate::agent_graph::{AgentGraph, AgentNode};
use crate::graph::Graph;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;

pub fn graph_hash(source: &str) -> String {
    format!("{:x}", Sha256::digest(source.as_bytes()))
}
pub(super) fn graph() -> Result<Graph, String> {
    Graph::parse(include_str!("../../../../workflow/task-lifecycle.mmd"))
}
pub(super) fn find_parent<'a>(job: &'a Value, id: &str) -> Result<&'a Value, String> {
    job.get("tasks")
        .and_then(Value::as_array)
        .and_then(|tasks| {
            tasks
                .iter()
                .find(|task| task.get("id").and_then(Value::as_str) == Some(id))
        })
        .ok_or_else(|| format!("DAG Coordinator Task {id} not found"))
}
pub(super) fn graph_for_parent(
    job: &Value,
    parent_task_id: &str,
) -> Result<(AgentGraph, String), String> {
    let parent = find_parent(job, parent_task_id)?;
    let source = parent
        .get("agentGraph")
        .and_then(Value::as_str)
        .ok_or("Coordinator has no agentGraph")?;
    let parsed = AgentGraph::parse(source)?;
    let hash = graph_hash(source);
    Ok((parsed, hash))
}
pub(super) fn checkpoint_matches(parent: &Value, hash: &str) -> bool {
    parent
        .get("result")
        .and_then(|result| result.get("data"))
        .and_then(|data| data.get("dag"))
        .is_some_and(|dag| {
            dag.get("version").and_then(Value::as_i64) == Some(1)
                && dag.get("graphHash").and_then(Value::as_str) == Some(hash)
        })
}
pub(super) fn existing_child<'a>(
    job: &'a Value,
    parent_id: &str,
    node: &str,
    hash: &str,
) -> Option<&'a Value> {
    job.get("tasks")?.as_array()?.iter().find(|task| {
        let dag = task.get("dagNode");
        dag.and_then(|v| v.get("parentTaskId"))
            .and_then(Value::as_str)
            == Some(parent_id)
            && dag.and_then(|v| v.get("nodeId")).and_then(Value::as_str) == Some(node)
            && dag.and_then(|v| v.get("graphHash")).and_then(Value::as_str) == Some(hash)
    })
}
pub(super) fn predecessor_output(task: &Value) -> Result<Value, String> {
    if task.get("state").and_then(Value::as_str) != Some("SUCCEEDED") {
        return Err("incomplete DAG predecessor".into());
    }
    let result = task.get("result").and_then(|r| r.get("data"));
    if let Some(data) = result {
        if data.get("status").and_then(Value::as_str) == Some("COMPLETED")
            && data.get("output").is_some_and(Value::is_object)
        {
            return Ok(data["output"].clone());
        }
    }
    // Match the TypeScript fallback for Script Agents that write the output
    // to their declared file. Bound reads (1 MB) prevent holding SQLite's
    // single-writer lock while loading unbounded untrusted media.
    let path = task
        .get("output")
        .filter(|v| v.get("kind").and_then(Value::as_str) == Some("file"))
        .and_then(|v| v.get("path"))
        .and_then(Value::as_str)
        .ok_or("missing DAG structured result")?;
    let absolute = Path::new(path);
    if !absolute.is_absolute() {
        return Err("DAG result path must be absolute".into());
    }
    let metadata = fs::metadata(absolute).map_err(|e| format!("DAG output not found: {e}"))?;
    if metadata.len() > 1_048_576 {
        return Err("DAG output exceeds 1 MB".into());
    }
    let bytes = fs::read(absolute).map_err(|e| e.to_string())?;
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
    if parsed.get("status").and_then(Value::as_str) != Some("COMPLETED")
        || !parsed.get("output").is_some_and(Value::is_object)
    {
        return Err("DAG predecessor has no structured COMPLETED output".into());
    }
    Ok(parsed["output"].clone())
}

pub(super) fn context_input(
    parent: &Value,
    req: &DAGMaterialize<'_>,
    child_id: &str,
    node: &AgentNode,
    output: &Path,
    predecessors: Map<String, Value>,
) -> Result<String, String> {
    let input = parent
        .get("input")
        .and_then(Value::as_str)
        .ok_or("DAG parent input must be string")?;
    let supplied = serde_json::from_str::<Value>(input)
        .ok()
        .filter(Value::is_object);
    let mut fields = supplied
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_else(|| {
            let mut map = Map::new();
            map.insert("taskInput".into(), json!(input));
            map
        });
    for forbidden in [
        "reviewDecision",
        "interactiveInvocation",
        "jobId",
        "taskId",
        "projectPath",
    ] {
        fields.shift_remove(forbidden);
    }
    fields.insert("source".into(), json!("relay-dag-task"));
    fields.insert("jobId".into(), json!(req.job_id));
    fields.insert("taskId".into(), json!(child_id));
    fields.insert("parentTaskId".into(), json!(req.parent_task_id));
    fields.insert("nodeId".into(), json!(node.id));
    fields.insert("agent".into(), json!(node.agent));
    fields.insert(
        "projectPath".into(),
        json!(req.project_path.to_string_lossy()),
    );
    fields.insert("predecessorOutputs".into(), Value::Object(predecessors));
    fields.insert("taskInput".into(), json!(input));
    fields.insert("outputPath".into(), json!(output.to_string_lossy()));
    fields.insert(
        "requiredResult".into(),
        json!({"status":"COMPLETED","output":{},"artifacts":[]}),
    );
    fields.insert("instruction".into(),json!("Execute this Agent DAG role using only declared predecessorOutputs and authorized project inputs. Write the structured result to outputPath. Do not invent source evidence, review decisions or publishing authorization."));
    serde_json::to_string(&fields).map_err(|e| e.to_string())
}
