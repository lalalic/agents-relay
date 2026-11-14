//! Isolated native DAG activation, materialization and completion.
//! Actual eligibility and durable decisions remain in canonical Graph actions.
use super::adapter::{NativeAdapterKind, ScriptManifest};
use super::NativeTick;
use crate::agent_graph::AgentGraph;
use crate::authority::{DAGExecutor, DAGMaterialize, RelayAuthority};
use crate::supervised_script::after_time;
use std::path::Path;

/// Adapt a trusted, caller-supplied DAG to the same Graph-owned atomic Task
/// primitives used by the ordinary Relay entry points. This is *not* a second
/// dependency scheduler: materialize_dag_child decides readiness inside SQLite.
pub(super) fn reconcile_native_dag(
    authority: &mut RelayAuthority,
    job_id: &str,
    root: &Path,
    agents: &ScriptManifest,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority.read_job(job_id)?.ok_or("DAG Job missing")?;
    let coordinators: Vec<String> = snapshot["tasks"]
        .as_array()
        .ok_or("DAG Task list missing")?
        .iter()
        .filter(|task| {
            task["agentGraph"].is_string()
                && matches!(task["state"].as_str(), Some("QUEUED" | "RUNNING"))
        })
        .filter_map(|task| task["id"].as_str().map(str::to_owned))
        .collect();
    for parent_id in coordinators {
        let mut job = authority.read_job(job_id)?.ok_or("DAG Job missing")?;
        let parent = job["tasks"]
            .as_array()
            .ok_or("DAG tasks missing")?
            .iter()
            .find(|task| task["id"] == parent_id)
            .ok_or("DAG parent disappeared")?;
        if parent["state"] == "QUEUED" {
            let at = after_time(
                job["updatedAt"]
                    .as_str()
                    .ok_or("DAG Job timestamp missing")?,
            )?;
            if let Err(error) = authority.begin_dag_coordinator(job_id, &parent_id, &at) {
                report
                    .blocked
                    .push(format!("{job_id}/{parent_id}: Coordinator start: {error}"));
                continue;
            }
            job = authority
                .read_job(job_id)?
                .ok_or("DAG Job missing after start")?;
        }
        let Some(parent) = job["tasks"]
            .as_array()
            .ok_or("DAG tasks missing")?
            .iter()
            .find(|task| task["id"] == parent_id)
        else {
            continue;
        };
        if parent["state"] != "RUNNING" {
            continue;
        }
        let Some(source) = parent["agentGraph"].as_str() else {
            continue;
        };
        let graph = match AgentGraph::parse(source) {
            Ok(graph) => graph,
            Err(error) => {
                report.blocked.push(format!(
                    "{job_id}/{parent_id}: invalid Agent Graph: {error}"
                ));
                continue;
            }
        };
        // The pilot daemon is fenced to its disposable DB root; its project
        // may not reference another workspace or the canonical user tree.
        let Some(project) = job["projectRoot"]
            .as_str()
            .and_then(|path| Path::new(path).canonicalize().ok())
            .filter(|path| path.starts_with(root))
        else {
            report.blocked.push(format!(
                "{job_id}/{parent_id}: DAG project outside isolated root"
            ));
            continue;
        };
        // A caller-supplied Coordinator result path must not escape the
        // disposable authority root before materialization creates dirs.
        if let Some(output) = parent
            .get("output")
            .filter(|value| value["kind"] == "file")
            .and_then(|value| value["path"].as_str())
        {
            let bounded = Path::new(output)
                .parent()
                .and_then(|directory| directory.canonicalize().ok())
                .is_some_and(|directory| directory.starts_with(root));
            if !bounded {
                report.blocked.push(format!(
                    "{job_id}/{parent_id}: DAG output path outside isolated root"
                ));
                continue;
            }
        }
        let timeout_ms = parent["timeoutMs"]
            .as_i64()
            .filter(|t| (10..=3_600_000).contains(t))
            .unwrap_or(600_000);
        for node in graph.nodes {
            let Some(agent) = agents.agents.get(&node.agent) else {
                report.blocked.push(format!(
                    "{job_id}/{parent_id}/{}: trusted agent missing: {}",
                    node.id, node.agent
                ));
                continue;
            };
            let executor = match agent.kind {
                NativeAdapterKind::Script => DAGExecutor::Script,
                NativeAdapterKind::Model => DAGExecutor::Model,
            };
            if executor == DAGExecutor::Model
                && (agent.routing.is_none() || agent.worker_selection.is_none())
            {
                report.blocked.push(format!("{job_id}/{parent_id}/{}: Model DAG node needs explicit trusted Router decision", node.id));
                continue;
            }
            let job = authority
                .read_job(job_id)?
                .ok_or("DAG Job missing during materialization")?;
            let at = after_time(
                job["updatedAt"]
                    .as_str()
                    .ok_or("DAG Job timestamp missing")?,
            )?;
            match authority.materialize_dag_child(DAGMaterialize {
                job_id,
                parent_task_id: &parent_id,
                node_id: &node.id,
                executor,
                project_path: &project,
                timeout_ms,
                model_routing: agent.routing.clone(),
                model_worker_selection: agent.worker_selection.clone(),
                at: &at,
            }) {
                Ok(Some(created)) if created.created => report.tasks_queued += 1,
                Ok(_) => {}
                Err(error) => report.blocked.push(format!(
                    "{job_id}/{parent_id}/{}: DAG materialization: {error}",
                    node.id
                )),
            }
        }
    }
    Ok(())
}

pub(super) fn complete_native_dag(
    authority: &mut RelayAuthority,
    job_id: &str,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority.read_job(job_id)?.ok_or("DAG Job missing")?;
    let coordinators: Vec<String> = snapshot["tasks"]
        .as_array()
        .ok_or("DAG tasks missing")?
        .iter()
        .filter(|task| task["agentGraph"].is_string() && task["state"] == "RUNNING")
        .filter_map(|task| task["id"].as_str().map(str::to_owned))
        .collect();
    for id in coordinators {
        let job = authority.read_job(job_id)?.ok_or("DAG Job missing")?;
        let at = after_time(
            job["updatedAt"]
                .as_str()
                .ok_or("DAG Job timestamp missing")?,
        )?;
        if let Err(error) = authority.complete_dag_coordinator(job_id, &id, &at) {
            report
                .blocked
                .push(format!("{job_id}/{id}: DAG completion: {error}"));
        }
    }
    Ok(())
}
