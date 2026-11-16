//! Bind Planner-authored child Tasks to a trusted, local Model Router entry.
//! The Planner may describe a semantic Agent role but must not grant itself
//! provider credentials, executable paths, or an approved Worker identity.
//! This step is idempotent and fenced to the immutable committed Plan and
//! exact globally allocated Task ID before the normal Task claim can run.
use super::adapter::{NativeAdapterKind, ScriptManifest};
use super::NativeTick;
use crate::authority::RelayAuthority;
use crate::supervised_script::after_time;
use serde_json::{json, Value};

pub(super) fn reconcile_planner_routes(
    authority: &mut RelayAuthority,
    job_id: &str,
    agents: &ScriptManifest,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Planner Job missing")?;
    let candidates = snapshot["tasks"]
        .as_array()
        .ok_or("Planner Task list missing")?
        .iter()
        .filter(|task| {
            task["state"] == "QUEUED"
                && task["adapter"] == "codex"
                && task["planningDecisionId"].is_string()
                && task.get("routing").is_none_or(Value::is_null)
                && task.get("workerSelection").is_none_or(Value::is_null)
                && task.get("executionId").is_none_or(Value::is_null)
        })
        .filter_map(|task| {
            Some((
                task["id"].as_str()?.to_owned(),
                task["agentName"].as_str()?.to_owned(),
            ))
        })
        .collect::<Vec<_>>();
    for (task_id, role) in candidates {
        let Some(adapter) = agents.agents.get(&role) else {
            report.blocked.push(format!(
                "{job_id}/{task_id}: Planner role {role} has no trusted Worker route"
            ));
            continue;
        };
        let (Some(routing), Some(selection)) = (&adapter.routing, &adapter.worker_selection) else {
            report.blocked.push(format!(
                "{job_id}/{task_id}: trusted Model Router decision missing for {role}"
            ));
            continue;
        };
        if adapter.kind != NativeAdapterKind::Model
            || adapter.prompt_cli.is_none()
            || adapter.prompt_node.is_none()
            || routing["provider"].as_str().is_none_or(str::is_empty)
            || routing["model"].as_str().is_none_or(str::is_empty)
            || selection["adapter"] != "codex"
            || selection["workerId"].as_str().is_none_or(str::is_empty)
        {
            report.blocked.push(format!(
                "{job_id}/{task_id}: incomplete trusted Model Worker routing for {role}"
            ));
            continue;
        }
        let current = authority
            .read_job(job_id)?
            .ok_or("Planner Job disappeared")?;
        let at = after_time(
            current["updatedAt"]
                .as_str()
                .ok_or("Planner Job timestamp missing")?,
        )?;
        let route = routing.clone();
        let worker = selection.clone();
        let mut bound = false;
        authority.commit_job(job_id, &at, |job| {
            if job["state"] != "ACTIVE" || job.get("pause").is_some_and(|v| !v.is_null()) {
                return Err("cannot bind Planner route on inactive Job".into());
            }
            let task = job["tasks"]
                .as_array()
                .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
                .ok_or("Planner Task disappeared")?;
            if task["state"] != "QUEUED"
                || task["adapter"] != "codex"
                || task["agentName"] != role
                || task.get("routing").is_some_and(|v| !v.is_null())
                || task.get("workerSelection").is_some_and(|v| !v.is_null())
                || task.get("executionId").is_some_and(|v| !v.is_null())
            {
                return Err("Planner Task changed during Model route binding".into());
            }
            let plan_id = task["planningDecisionId"]
                .as_str()
                .ok_or("Planner provenance missing")?;
            let plan = job["plans"]
                .as_array()
                .and_then(|plans| plans.iter().find(|p| p["id"] == plan_id))
                .ok_or("committed Planner round missing")?;
            if plan["status"] != "SUCCEEDED"
                || plan["objectiveStatus"] != "in_progress"
                || plan["round"] != task["planningRound"]
                || plan["source"] != task["planningSource"]
                || !plan["generatedTaskIds"]
                    .as_array()
                    .is_some_and(|ids| ids.iter().any(|id| *id == task_id))
            {
                return Err(
                    "Planner Task is not bound to a committed, valid Plan generation".into(),
                );
            }
            let mut next = job.clone();
            let task = next["tasks"]
                .as_array_mut()
                .and_then(|tasks| tasks.iter_mut().find(|t| t["id"] == task_id))
                .ok_or("Planner Task disappeared during commit")?;
            task["routing"] = route.clone();
            task["workerSelection"] = worker.clone();
            task["updatedAt"] = json!(at);
            next["updatedAt"] = json!(at);
            bound = true;
            Ok((next, vec![]))
        })?;
        if bound {
            report.planner_routes_bound += 1;
        }
    }
    Ok(())
}
