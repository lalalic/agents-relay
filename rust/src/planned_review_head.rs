// Direct port of Node src/planned-review-head.ts: bind a review Task to the immutable current local head.
use serde_json::Value;

pub const REVIEW_HEAD_RULE: &str = "Review the current immutable local source head as a PRE-MERGE approval gate. Distinguish code added by this implementation from pre-existing local baseline/seed files present before the Task started. Preserved baseline files are not automatically extra changes merely because they differ from main; still review them for real risks. Do not require a remote PR MERGED, Job COMPLETED, or post-merge validation before review approval: those events must follow approval and require their own verified durable receipts.";

pub fn bind_planned_review_head(
    task: &mut Value,
    local_head_sha: Option<&str>,
) -> Result<(), String> {
    let head = local_head_sha
        .filter(|head| !head.is_empty())
        .ok_or_else(|| {
            format!(
                "Review {} requires current local Git head SHA",
                task["id"].as_str().unwrap_or("undefined")
            )
        })?;
    task["reviewHeadSha"] = Value::String(head.to_owned());
    let input = task["input"].as_str().unwrap_or("").to_owned();
    if !input.contains(REVIEW_HEAD_RULE) {
        task["input"] = Value::String(format!("{input}\n\n{REVIEW_HEAD_RULE}"));
    }
    Ok(())
}
