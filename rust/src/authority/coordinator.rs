//! AgentGraph Coordinator durable primitives. These operate ONLY on the
//! ordinary Job Snapshot and Task Graph, not a second DAG store or worker
//! scheduler. Execution-context resolution and Script-agent discovery stay
//! adapter responsibilities; the resolved executor is an explicit input.
mod support;
use super::ids::{allocate_entity_id_in_tx, EntityKind};
use super::{check_snapshot, RelayAuthority};
use crate::graph::{Decision, GraphInput};
use crate::lifecycle::apply_pure_task_actions;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
pub use support::graph_hash;
use support::{
    checkpoint_matches, context_input, existing_child, find_parent, graph, graph_for_parent,
    predecessor_output,
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DAGExecutor {
    Script,
    Model,
}
impl DAGExecutor {
    fn adapter(self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::Model => "codex",
        }
    }
    fn capability(self) -> &'static str {
        match self {
            Self::Script => "script",
            Self::Model => "model",
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChildMaterialization {
    pub child_id: String,
    pub node_id: String,
    pub created: bool,
    pub state: String,
    pub dependencies: Vec<String>,
}

pub struct DAGMaterialize<'a> {
    pub job_id: &'a str,
    pub parent_task_id: &'a str,
    pub node_id: &'a str,
    pub executor: DAGExecutor,
    pub project_path: &'a Path,
    pub timeout_ms: i64,
    pub at: &'a str,
}

impl RelayAuthority {
    /// Coordinator activation is a normal Task Graph transition. Checkpoint
    /// metadata and state are committed atomically, never in two writes.
    pub fn begin_dag_coordinator(
        &mut self,
        job_id: &str,
        parent_id: &str,
        at: &str,
    ) -> Result<bool, String> {
        let mut started = false;
        self.commit_job_with_tx(job_id, at, |_, prior| {
            let (agent_graph, hash) = graph_for_parent(prior, parent_id)?;
            if agent_graph.nodes.is_empty() {
                return Err("empty DAG".into());
            }
            if prior.get("state").and_then(Value::as_str) != Some("ACTIVE")
                || prior.get("pause").is_some_and(|v| !v.is_null())
            {
                return Err("Coordinator Job must be active and unpaused".into());
            }
            let parent = find_parent(prior, parent_id)?;
            // Never hijack an already claimed Worker generation.
            if parent.get("executionId").is_some_and(|v| !v.is_null())
                || parent.get("leaseOwner").is_some_and(|v| !v.is_null())
            {
                return Err("Coordinator has an existing Worker lease".into());
            }
            if parent.get("state").and_then(Value::as_str) != Some("QUEUED") {
                return Err("Coordinator must start QUEUED".into());
            }
            let decision = graph()?.decide(
                "QUEUED",
                GraphInput {
                    transport: "event".into(),
                    id: "task.started".into(),
                    payload: json!({}),
                },
                &HashMap::new(),
            )?;
            let Decision::Accepted {
                target, actions, ..
            } = decision
            else {
                return Err("Task Graph denied Coordinator start".into());
            };
            if target != "RUNNING" {
                return Err("Task Graph failed to start Coordinator".into());
            }
            let mut job = prior.clone();
            let entry = job["tasks"]
                .as_array_mut()
                .ok_or("Job tasks missing")?
                .iter_mut()
                .find(|task| task["id"] == parent_id)
                .ok_or("Coordinator missing")?;
            apply_pure_task_actions(entry, &actions)?;
            entry["state"] = json!(target);
            entry["title"] = json!("Coordinator");
            entry["result"] =
                json!({"summary":"DAG coordinator","data":{"dag":{"version":1,"graphHash":hash}}});
            entry["updatedAt"] = json!(at);
            job["updatedAt"] = json!(at);
            started = true;
            Ok((job, vec![]))
        })?;
        Ok(started)
    }

    /// Atomic idempotent DAG child creation. Graph eligibility, predecessor
    /// outputs, ID allocation and Snapshot append all happen under the SAME
    /// SQLite IMMEDIATE write transaction. Concurrent callers get the same ID.
    pub fn materialize_dag_child(
        &mut self,
        req: DAGMaterialize<'_>,
    ) -> Result<Option<ChildMaterialization>, String> {
        if req.timeout_ms <= 0 || !req.project_path.is_absolute() || req.at.is_empty() {
            return Err("invalid DAG execution context".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let row: (String, String) = tx
            .query_row(
                "SELECT json,updated_at FROM job_snapshot WHERE job_id=?1",
                [req.job_id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?
            .ok_or("Job snapshot missing")?;
        let prior: Value = serde_json::from_str(&row.0).map_err(|e| e.to_string())?;
        if prior.get("state").and_then(Value::as_str) != Some("ACTIVE")
            || prior.get("pause").is_some_and(|v| !v.is_null())
        {
            return Err("DAG Job is not active".into());
        }
        let (agent_graph, hash) = graph_for_parent(&prior, req.parent_task_id)?;
        let parent = find_parent(&prior, req.parent_task_id)?;
        if parent.get("state").and_then(Value::as_str) != Some("RUNNING")
            || !checkpoint_matches(parent, &hash)
        {
            return Err("Coordinator is not RUNNING with its original DAG".into());
        }
        let node = agent_graph
            .nodes
            .iter()
            .find(|node| node.id == req.node_id)
            .ok_or("unknown DAG node")?;
        if let Some(child) = existing_child(&prior, req.parent_task_id, req.node_id, &hash) {
            let result = ChildMaterialization {
                child_id: child["id"].as_str().ok_or("child ID missing")?.into(),
                node_id: req.node_id.into(),
                created: false,
                state: child["state"].as_str().ok_or("child state missing")?.into(),
                dependencies: child["dependencies"]
                    .as_array()
                    .ok_or("child dependencies missing")?
                    .iter()
                    .map(|v| v.as_str().unwrap_or("").to_owned())
                    .collect(),
            };
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(Some(result));
        }
        let parent_nodes = agent_graph
            .edges
            .iter()
            .filter(|edge| edge.to == req.node_id)
            .map(|edge| edge.from.as_str())
            .collect::<Vec<_>>();
        let mut dependencies = Vec::new();
        let mut predecessors = Map::new();
        for predecessor in parent_nodes {
            let Some(child) = existing_child(&prior, req.parent_task_id, predecessor, &hash) else {
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(None);
            };
            if child.get("state").and_then(Value::as_str) != Some("SUCCEEDED") {
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(None);
            }
            let output = predecessor_output(child)?;
            dependencies.push(
                child["id"]
                    .as_str()
                    .ok_or("predecessor ID missing")?
                    .to_owned(),
            );
            predecessors.insert(predecessor.into(), output);
        }
        let repository = prior["repository"]
            .as_str()
            .ok_or("Job repository missing")?;
        let occupied = prior["tasks"]
            .as_array()
            .ok_or("Job tasks missing")?
            .iter()
            .filter_map(|task| task.get("id").and_then(Value::as_str).map(str::to_owned))
            .collect::<HashSet<_>>();
        let key = format!(
            "dag:{}:{}:{}:{}",
            req.job_id, req.parent_task_id, hash, req.node_id
        );
        let child_id =
            allocate_entity_id_in_tx(&tx, repository, EntityKind::Task, Some(&key), &occupied)?;
        if occupied.contains(&child_id) {
            return Err("DAG Task identity collides with another node".into());
        }
        let result_root = parent
            .get("output")
            .filter(|v| v["kind"] == "file")
            .and_then(|v| v.get("path"))
            .and_then(Value::as_str)
            .filter(|v| Path::new(v).is_absolute())
            .and_then(|v| Path::new(v).parent().map(Path::to_path_buf))
            .unwrap_or_else(|| {
                req.project_path
                    .join(".relay-dag-results")
                    .join(req.job_id)
                    .join(req.parent_task_id)
            });
        let output = result_root
            .join(".dag-node-results")
            .join(format!("{child_id}.json"));
        let input = context_input(parent, &req, &child_id, node, &output, predecessors)?;
        // The authoritative creation boundary is the canonical Task Graph.
        let decision = graph()?.decide(
            "DRAFT",
            GraphInput {
                transport: "event".into(),
                id: "reconcile".into(),
                payload: json!({}),
            },
            &HashMap::from([("dependenciesSatisfied".to_string(), true)]),
        )?;
        let Decision::Accepted {
            target, actions, ..
        } = decision
        else {
            return Err("Graph denied new DAG Task creation".into());
        };
        if target != "QUEUED" {
            return Err("Graph did not queue ready DAG child".into());
        }
        let requirements = match req.executor {
            DAGExecutor::Script => Value::Null,
            DAGExecutor::Model => json!({"capabilities":["model"]}),
        };
        let mut child = json!({
            "jobId":req.job_id,"id":child_id,"parentTaskId":req.parent_task_id,
            "dagNode":{"parentTaskId":req.parent_task_id,"nodeId":req.node_id,
                       "graphHash":hash,"executor":req.executor},
            "title":node.agent,"kind":"work","agentName":node.agent,
            "dependencies":dependencies,"capabilities":[req.executor.capability()],
            "adapter":req.executor.adapter(),"input":input,
            "output":{"kind":"file","path":output.to_string_lossy()},
            "attempt":0,"maxAttempts":3,"leaseOwner":null,"leaseExpiresAt":null,
            "executionId":null,"threadId":null,"result":null,"error":null,
            "timeoutMs":req.timeout_ms,"createdAt":req.at,"updatedAt":req.at,
            "state":"DRAFT",
        });
        if !requirements.is_null() {
            child["workerRequirements"] = requirements;
        }
        apply_pure_task_actions(&mut child, &actions)?;
        child["state"] = json!(target);
        let mut job = prior.clone();
        job["tasks"]
            .as_array_mut()
            .ok_or("Job tasks missing")?
            .push(child);
        job["updatedAt"] = json!(req.at);
        check_snapshot(req.job_id, &prior, &job, &row.1, req.at)?;
        // Directory creation is safe outside the SQL authority but may leave
        // an empty private directory on rollback; never a durable phantom Task.
        let parent_dir = output.parent().ok_or("DAG output path missing parent")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent_dir)
                .map_err(|e| format!("cannot create private DAG output dir: {e}"))?;
        }
        #[cfg(not(unix))]
        {
            fs::create_dir_all(parent_dir)
                .map_err(|e| format!("cannot create DAG output dir: {e}"))?;
        }
        tx.execute(
            "UPDATE job_snapshot SET json=?1,updated_at=?2 WHERE job_id=?3",
            params![
                serde_json::to_string(&job).map_err(|e| e.to_string())?,
                req.at,
                req.job_id
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(Some(ChildMaterialization {
            child_id,
            node_id: req.node_id.into(),
            created: true,
            state: target,
            dependencies,
        }))
    }

    pub fn complete_dag_coordinator(
        &mut self,
        job_id: &str,
        parent_id: &str,
        at: &str,
    ) -> Result<bool, String> {
        // Periodic incomplete ticks are normal. Recheck every predicate under
        // BEGIN IMMEDIATE before the eventual successful commit.
        let snapshot = self.read_job(job_id)?.ok_or("Coordinator Job not found")?;
        let (parsed, hash) = graph_for_parent(&snapshot, parent_id)?;
        let parent = find_parent(&snapshot, parent_id)?;
        if parent.get("state").and_then(Value::as_str) == Some("SUCCEEDED")
            && checkpoint_matches(parent, &hash)
        {
            return Ok(false);
        }
        if parent.get("state").and_then(Value::as_str) != Some("RUNNING")
            || !checkpoint_matches(parent, &hash)
        {
            return Err("Coordinator is not RUNNING".into());
        }
        if parsed.nodes.iter().any(|node| {
            existing_child(&snapshot, parent_id, &node.id, &hash)
                .is_none_or(|child| child["state"] != "SUCCEEDED")
        }) {
            return Ok(false);
        }
        let mut completed = false;
        self.commit_job_with_tx(job_id, at, |_, prior| {
            let (parsed, hash) = graph_for_parent(prior, parent_id)?;
            let parent = find_parent(prior, parent_id)?;
            if parent.get("state").and_then(Value::as_str) != Some("RUNNING")
                || !checkpoint_matches(parent, &hash)
            {
                return Err("Coordinator is not RUNNING".into());
            }
            let mut nodes = Map::new();
            for node in &parsed.nodes {
                let Some(child) = existing_child(prior, parent_id, &node.id, &hash) else {
                    return Err("DAG has incomplete nodes".into());
                };
                if child["state"] != "SUCCEEDED" {
                    return Err("DAG has unfinished nodes".into());
                }
                nodes.insert(node.id.clone(), child["id"].clone());
            }
            let decision = graph()?.decide(
                "RUNNING",
                GraphInput {
                    transport: "event".into(),
                    id: "task.completed".into(),
                    payload: json!({}),
                },
                &HashMap::new(),
            )?;
            let Decision::Accepted {
                target, actions, ..
            } = decision
            else {
                return Err("Graph denied Coordinator completion".into());
            };
            if target != "SUCCEEDED" {
                return Err("Graph did not complete Coordinator".into());
            }
            let mut job = prior.clone();
            let parent = job["tasks"]
                .as_array_mut()
                .ok_or("Job tasks missing")?
                .iter_mut()
                .find(|t| t["id"] == parent_id)
                .ok_or("Coordinator missing")?;
            apply_pure_task_actions(parent, &actions)?;
            parent["state"] = json!(target);
            parent["result"] = json!({"summary":"DAG completed","data":{
                "dag":{"version":1,"graphHash":hash},"nodes":nodes}});
            parent["updatedAt"] = json!(at);
            job["updatedAt"] = json!(at);
            completed = true;
            Ok((job, vec![]))
        })?;
        Ok(completed)
    }
}

#[cfg(test)]
mod tests;
