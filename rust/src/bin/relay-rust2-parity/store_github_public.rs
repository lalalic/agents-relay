// Original store-github.ts public API differential: GitHubStore over an
// injected fixture GitHub client (graphql + request), covering marker
// parsing, trusted-author filtering, load/save round-trips, overlays,
// validation and PR state transitions. No network access.
use agents_relay_rust2::store_github::{GitHubApi, GitHubStore};
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::HashSet;

#[derive(Clone, Default)]
struct FixtureClient {
    pr_node: Value,
    comments: RefCell<Vec<Value>>,
    requests: RefCell<Vec<Value>>,
    graphql_calls: RefCell<Vec<String>>,
}
impl GitHubApi for FixtureClient {
    fn graphql(&mut self, _query: &str, _variables: &Value)
        -> Result<Value, String> {
        self.graphql_calls.borrow_mut().push(_query.chars()
            .take(40).collect());
        Ok(self.pr_node.clone())
    }
    fn request(&mut self, path: &str, method: &str, body: Option<&Value>)
        -> Result<Value, String> {
        self.requests.borrow_mut().push(json!({
            "path":path,"method":method,
            "body":body.cloned().unwrap_or(Value::Null)}));
        // Comment creation returns the posted comment echoed back.
        if method == "POST" && path.starts_with("/repos/") {
            let body = body.cloned().unwrap_or(Value::Null);
            let id = 1000 + self.comments.borrow().len();
            let comment = json!({
                "id":id,"nodeId":format!("NODE-{id}"),
                "authorLogin":"trusted-author",
                "body":body.get("body").cloned().unwrap_or(Value::Null),
                "updatedAt":"2026-01-01T00:00:00.000Z",
                "url":format!("https://example.test/c/{id}"),
            });
            self.comments.borrow_mut().push(comment.clone());
            return Ok(comment);
        }
        Ok(Value::Null)
    }
}

fn comment(id: i64, author: &str, body: &str) -> Value {
    json!({"id":id,"nodeId":format!("NODE-{id}"),
        "authorLogin":author,"body":body,
        "updatedAt":"2026-01-01T00:00:00.000Z",
        "url":format!("https://example.test/c/{id}")})
}
fn pr_node(state: &str, body: &str) -> Value {
    json!({"data":{"repository":{"pullRequest":{
        "state":state,"body":body,
        "headRef":{"name":"feature"},"headRefOid":{"oid":"a".repeat(40)},
        "number":7}}}})
}

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certStoreGithub" {
        return None;
    }
    Some((|| {
        let trusted: HashSet<String> = ["trusted-author"]
            .iter().map(|s| s.to_string()).collect();
        let client = FixtureClient {
            pr_node: pr_node("OPEN",
                request["body"].as_str().unwrap_or("")),
            comments: RefCell::new(
                request["comments"].as_array().cloned()
                    .unwrap_or_default()),
            ..Default::default()
        };
        let mut store = GitHubStore::new(
            client, "owner/repo", 7, trusted, None);
        match request["method"].as_str().unwrap_or("") {
            "load" => match store.load(request["jobId"].as_str()
                .unwrap_or("j1")) {
                Ok(job) => Ok(json!({"ok":true,"job":job}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            "saveJob" => match store.save_job(&request["job"]) {
                Ok(()) => {
                    let requests = store.client.requests.borrow().clone();
                    let comments = store.client.comments.borrow().clone();
                    Ok(json!({"ok":true,"requests":requests
                        .iter().map(|r|json!({
                            "method":r["method"],
                            "body":r["body"]})).collect::<Vec<_>>(),
                        "comments":comments.iter().map(|c|c["body"].clone())
                            .collect::<Vec<_>>()}).to_string())
                }
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            "appendTask" => match store.append_task(&request["task"]) {
                Ok(()) => {
                    let comments = store.client.comments.borrow().clone();
                    Ok(json!({"ok":true,
                        "bodies":comments.iter().map(|c|c["body"].clone())
                            .collect::<Vec<_>>()}).to_string())
                }
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            "listAgents" => match store.list_agents() {
                Ok(agents) => Ok(json!({"ok":true,
                    "agents":agents}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            "validateJobBinding" => {
                match store.validate_job_binding(request["jobId"]
                    .as_str().unwrap_or("j1")) {
                    Ok(()) => Ok(json!({"ok":true}).to_string()),
                    Err(error) => {
                        Ok(json!({"ok":false,"error":error}).to_string())
                    }
                }
            }
            "pullRequestState" => match store.pull_request_state() {
                Ok(state) => Ok(json!({"ok":true,"state":state}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            "headSha" => match store.head_sha() {
                Ok(sha) => Ok(json!({"ok":true,
                    "sha":sha}).to_string()),
                Err(error) => Ok(json!({"ok":false,"error":error}).to_string()),
            },
            value => Err(format!("Unknown store github method {value}")),
        }
    })())
}
