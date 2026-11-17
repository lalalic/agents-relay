// Native Rust regression for Node src/github-pr-archive.ts: callback order, duplicate-comment suppression, fail-closed transport errors, no remote merges.
use agents_relay_rust2::github_pr_archive::{
    archive_display_pull_request, GitHubRequestCallback, GitHubRequestFuture,
};
use serde_json::{json, Value};
use std::{
    future::Future,
    pin::pin,
    sync::{Arc, Mutex},
    task::{Context, Poll, Waker},
};
fn drive<T>(work: impl Future<Output = T>) -> T {
    let mut work = pin!(work);
    let mut cx = Context::from_waker(Waker::noop());
    loop {
        if let Poll::Ready(value) = work.as_mut().poll(&mut cx) {
            return value;
        }
    }
}
type ArchiveTrace = Arc<Mutex<Vec<(String, Option<Value>)>>>;
type ClientWithTrace = (Box<GitHubRequestCallback>, ArchiveTrace);

fn client(comments: Value, fail: Option<&str>) -> ClientWithTrace {
    let trace = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&trace);
    let fail = fail.map(str::to_string);
    let request = move |path: String, options: Option<Value>| -> GitHubRequestFuture {
        let method = options
            .as_ref()
            .and_then(|opt| opt.get("method"))
            .and_then(Value::as_str)
            .unwrap_or("GET")
            .to_string();
        captured.lock().unwrap().push((path, options));
        let stage = match method.as_str() {
            "POST" => "post",
            "PATCH" => "patch",
            _ => "list",
        };
        let response = if fail.as_deref() == Some(stage) {
            Err(format!("injected {stage} error"))
        } else if method == "GET" {
            Ok(comments.clone())
        } else {
            Ok(json!({"ok":true}))
        };
        Box::pin(async move { response })
    };
    (Box::new(request), trace)
}
#[test]
fn closed_or_merged_pr_never_calls_remote_client() {
    for state in ["CLOSED", "MERGED", "failed", ""] {
        let (mut request, trace) = client(json!([]), None);
        let outcome = drive(archive_display_pull_request(
            request.as_mut(),
            "owner/repo",
            12,
            "job-1",
            "abc",
            state,
        ))
        .unwrap();
        assert_eq!(outcome, "already_closed");
        assert!(trace.lock().unwrap().is_empty());
    }
}
#[test]
fn open_pr_with_no_existing_marker_adds_comment_and_closes_without_merge() {
    let (mut request, trace) = client(json!([{ "body":"unrelated" }]), None);
    let outcome = drive(archive_display_pull_request(
        request.as_mut(),
        "owner/repo",
        17,
        "job-101",
        "commit-main-xyz",
        "OPEN",
    ))
    .unwrap();
    assert_eq!(outcome, "archived");
    let log = trace.lock().unwrap();
    assert_eq!(log.len(), 3);
    assert_eq!(log[0].0, "repos/owner/repo/issues/17/comments?per_page=100");
    assert_eq!(log[1].1.as_ref().unwrap()["method"], "POST");
    let posted: Value =
        serde_json::from_str(log[1].1.as_ref().unwrap()["body"].as_str().unwrap()).unwrap();
    assert!(posted["body"]
        .as_str()
        .unwrap()
        .contains("Agents Relay local completion: job-101"));
    assert!(posted["body"]
        .as_str()
        .unwrap()
        .contains("Published local main commit: commit-main-xyz."));
    assert_eq!(log[2].1.as_ref().unwrap()["method"], "PATCH");
    assert_eq!(log[2].0, "repos/owner/repo/pulls/17");
    let patched: Value =
        serde_json::from_str(log[2].1.as_ref().unwrap()["body"].as_str().unwrap()).unwrap();
    assert_eq!(patched["state"], "closed");
    assert!(!log.iter().any(|(path, _)| path.contains("/merge")));
}
#[test]
fn archived_marker_is_idempotent_but_still_closes_the_display_only_pr() {
    let (mut request, trace) = client(
        json!([{ "body":"Prefix Agents Relay local completion: job-101 suffix" }]),
        None,
    );
    let outcome = drive(archive_display_pull_request(
        request.as_mut(),
        "owner/repo",
        17,
        "job-101",
        "sha",
        "OPEN",
    ))
    .unwrap();
    assert_eq!(outcome, "archived");
    let log = trace.lock().unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[1].1.as_ref().unwrap()["method"], "PATCH");
}
#[test]
fn invalid_list_or_failing_transport_never_performs_unverified_pr_close() {
    let (mut request, trace) = client(json!({"not":"an array"}), None);
    let error = drive(archive_display_pull_request(
        request.as_mut(),
        "owner/repo",
        17,
        "job-1",
        "sha",
        "OPEN",
    ))
    .unwrap_err();
    assert_eq!(error, "Cannot verify PR archive comment idempotency");
    assert_eq!(trace.lock().unwrap().len(), 1);
    for stage in ["list", "post"] {
        let (mut request, trace) = client(json!([]), Some(stage));
        let result = drive(archive_display_pull_request(
            request.as_mut(),
            "owner/repo",
            17,
            "job-1",
            "sha",
            "OPEN",
        ));
        assert_eq!(result.unwrap_err(), format!("injected {stage} error"));
        assert!(!trace.lock().unwrap().iter().any(|(_, options)| options
            .as_ref()
            .is_some_and(|options| options["method"] == "PATCH")));
    }
}
