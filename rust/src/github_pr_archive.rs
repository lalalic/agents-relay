// Direct port of Node src/github-pr-archive.ts: GitHub PR remains a display-only collaboration record after canonical local completion.
use serde_json::{json, Value};
use std::{future::Future, pin::Pin};

pub type GitHubRequestFuture = Pin<Box<dyn Future<Output = Result<Value, String>> + Send>>;
pub type GitHubRequestCallback = dyn FnMut(String, Option<Value>) -> GitHubRequestFuture;

/// Never asks GitHub to merge. Adds at most one authoritative local-completion
/// comment and closes the remote PR only after it is safe to archive.
pub async fn archive_display_pull_request(
    client: &mut GitHubRequestCallback,
    repository: &str,
    number: i64,
    job_id: &str,
    published_sha: &str,
    state: &str,
) -> Result<&'static str, String> {
    if state != "OPEN" {
        return Ok("already_closed");
    }
    let marker = format!("Agents Relay local completion: {job_id}");
    let path = format!("repos/{repository}/issues/{number}/comments?per_page=100");
    let comments = client(path, None).await?;
    let Some(comments) = comments.as_array() else {
        return Err("Cannot verify PR archive comment idempotency".into());
    };
    let already_commented = comments.iter().any(|item| {
        item.get("body")
            .and_then(Value::as_str)
            .is_some_and(|body| body.contains(&marker))
    });
    if !already_commented {
        let body=format!("{marker}\nPublished local main commit: {published_sha}.\nThis PR is closed as a review record; GitHub did not perform a merge.");
        client(
            format!("repos/{repository}/issues/{number}/comments"),
            Some(json!({"method":"POST","body":json!({"body":body}).to_string()})),
        )
        .await?;
    }
    client(
        format!("repos/{repository}/pulls/{number}"),
        Some(json!({"method":"PATCH","body":json!({"state":"closed"}).to_string()})),
    )
    .await?;
    Ok("archived")
}
