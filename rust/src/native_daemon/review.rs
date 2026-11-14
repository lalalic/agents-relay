//! Only verified, durable host decisions may resume native Agent Tasks.
use super::NativeTick;
use crate::authority::RelayAuthority;
use crate::supervised_script::after_time;

/// A host Review receipt is not an approval until it is durably accepted
/// by the interactive Graph and the host-invocation ledger. This staged
/// daemon resumes only approved work; changes_requested requires a separate
/// semantic revision plus another Preview and is never auto-completed.
pub(super) fn resume_approved_native_reviews(
    authority: &mut RelayAuthority,
    job_id: &str,
    report: &mut NativeTick,
) -> Result<(), String> {
    let snapshot = authority.read_job(job_id)?.ok_or("Review Job missing")?;
    let pending: Vec<(String, String)> = snapshot["tasks"]
        .as_array()
        .ok_or("Review Tasks missing")?
        .iter()
        .filter(|task| task["state"] == "AWAITING_DECISION")
        .filter_map(|task| {
            Some((
                task["id"].as_str()?.to_owned(),
                task.get("interactiveInvocation")?
                    .get("status")?
                    .as_str()?
                    .to_owned(),
            ))
        })
        .collect();
    for (task_id, status) in pending {
        if status == "changes_requested" {
            report.blocked.push(format!("{job_id}/{task_id}: human changes_requested must receive semantic revision and a new Preview"));
            continue;
        }
        if status != "approved" {
            continue;
        }
        let job = authority
            .read_job(job_id)?
            .ok_or("Review Job missing before resume")?;
        let at = after_time(
            job["updatedAt"]
                .as_str()
                .ok_or("Review Job timestamp missing")?,
        )?;
        match authority.resume_review_task(job_id, &task_id, &at) {
            Ok(_) => report.reviews_resumed += 1,
            Err(error) => report.blocked.push(format!(
                "{job_id}/{task_id}: Review ledger not accepted: {error}"
            )),
        }
    }
    Ok(())
}
