//! Reconcile Graph-selected durable Troubleshooter work using trusted
//! execution routes from the native Agent manifest.
use super::adapter::{NativeAdapterKind, ScriptManifest};
use super::NativeTick;
use crate::authority::{RelayAuthority, TroubleshooterAgent};
use crate::supervised_script::after_time;

pub(crate) fn reconcile_native_troubleshooters(
    authority: &mut RelayAuthority,
    job_id: &str,
    agents: &ScriptManifest,
    report: &mut NativeTick,
) -> Result<usize, String> {
    let snapshot = authority
        .read_job(job_id)?
        .ok_or("Troubleshooter Job missing")?;
    if snapshot["state"] != "ACTIVE" || snapshot.get("pause").is_some_and(|value| !value.is_null())
    {
        return Ok(0);
    }
    let failed = snapshot["tasks"]
        .as_array()
        .ok_or("Job Tasks missing")?
        .iter()
        .filter(|task| {
            task["state"] == "FAILED"
                && task["kind"] != "planner"
                && task["agentName"] != "troubleshooter"
        })
        .filter_map(|task| task["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if failed.is_empty() {
        return Ok(0);
    }
    let Some(agent) = agents.agents.get("troubleshooter") else {
        report.blocked.push(format!(
            "{job_id}: failed work needs a trusted Troubleshooter Model executor"
        ));
        return Ok(0);
    };
    if agent.kind != NativeAdapterKind::Model
        || agent.prompt_cli.is_none()
        || agent.prompt_node.is_none()
    {
        report.blocked.push(format!(
            "{job_id}: Troubleshooter requires a trusted Model executor and shared prompt Action"
        ));
        return Ok(0);
    }
    let (Some(routing), Some(selection)) = (&agent.routing, &agent.worker_selection) else {
        report.blocked.push(format!(
            "{job_id}: Troubleshooter Model route or Worker selection missing"
        ));
        return Ok(0);
    };
    let trusted = TroubleshooterAgent {
        routing: routing.clone(),
        worker_selection: selection.clone(),
    };
    let mut created_count = 0;
    for original_task_id in failed {
        let current = authority
            .read_job(job_id)?
            .ok_or("Troubleshooter Job disappeared")?;
        let at = after_time(
            current["updatedAt"]
                .as_str()
                .ok_or("Job timestamp missing")?,
        )?;
        match authority.create_troubleshooter_for_failed_task(
            job_id,
            &original_task_id,
            &trusted,
            &at,
        ) {
            Ok(Some(_)) => created_count += 1,
            Ok(None) => {}
            Err(error)
                if error.contains("no longer selects") || error.contains("failed Task missing") => {
            }
            Err(error) => report.blocked.push(format!(
                "{job_id}/{original_task_id}: Troubleshooter creation failed: {error}"
            )),
        }
    }
    report.troubleshooters_created += created_count;
    Ok(created_count)
}
