// rust/src/bin/relay-rust2-parity/store_public.rs
// Direct differential for src/store.ts public pure functions and the
// InMemoryStore fixture: loadManagedGitHubPullRequestSnapshotGraphql parsing
// (given the raw GraphQL response), dashboardManagedJobs ordering,
// listManagedGitHubJobs pagination over a fixture GraphQL client and the full
// InMemoryStore mutation surface. No network; responses come from the test.
use agents_relay_rust2::store::{
    dashboard_managed_jobs, list_managed_github_jobs,
    load_managed_github_pull_request_snapshot_graphql, InMemoryStore,
};
use serde_json::{json, Value};
use std::collections::HashSet;

fn outcome(result: Result<Value, String>) -> String {
    json!({"outcome": match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => json!({"ok": false, "error": error}),
    }}).to_string()
}

/// A strictly offline GraphQL effect interpreter replaying queued responses.
struct FixtureClient {
    responses: Vec<Value>,
    calls: Vec<Value>,
}

impl FixtureClient {
    fn next(&mut self) -> Result<Value, String> {
        if self.responses.is_empty() {
            return Err("Fixture GitHub effect exhausted".into());
        }
        let row = self.responses.remove(0);
        if let Some(error) = row.get("fixtureError").and_then(Value::as_str) {
            return Err(error.to_owned());
        }
        Ok(row)
    }
}

impl agents_relay_rust2::store_github::GitHubApi for FixtureClient {
    fn graphql(&mut self, query: &str, variables: &Value) -> Result<Value, String> {
        self.calls.push(json!({"kind": "graphql",
            "query": query, "variables": variables}));
        self.next()
    }
    fn request(&mut self, path: &str, method: &str, body: Option<&Value>)
        -> Result<Value, String> {
        self.calls.push(json!({"kind": "request",
            "path": path, "method": method, "body": body}));
        self.next()
    }
}

pub fn invoke(request: &Value) -> Result<Option<String>, String> {
    if request["op"] != "storePublicParity" {
        return Ok(None);
    }
    let method = request["method"].as_str().unwrap_or("");
    Ok(Some(match method {
        // Node loadManagedGitHubPullRequestSnapshotGraphql minus the client
        // hop: the adapter consumes the raw GraphQL `data` document.
        "snapshotParse" => {
            let trusted: HashSet<String> = request["trustedAuthors"]
                .as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect();
            json!(load_managed_github_pull_request_snapshot_graphql(
                request["repository"].as_str().unwrap_or(""),
                request["prNumber"].as_u64().unwrap_or(0),
                &trusted,
                &request["response"],
            )).to_string()
        }
        "dashboardManagedJobs" => {
            json!(dashboard_managed_jobs(
                request["items"].as_array().map(Vec::as_slice).unwrap_or(&[])))
                .to_string()
        }
        "listManagedGitHubJobs" => {
            let trusted: HashSet<String> = request["trustedAuthors"]
                .as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect();
            let mut client = FixtureClient {
                responses: request["responses"].as_array()
                    .cloned().unwrap_or_default(),
                calls: Vec::new(),
            };
            let result = list_managed_github_jobs(
                &mut client, request["repository"].as_str().unwrap_or(""),
                &trusted);
            json!({"outcome": match result {
                Ok(value) => json!({"ok": true, "value": value}),
                Err(error) => json!({"ok": false, "error": error}),
            }, "calls": client.calls}).to_string()
        }
        // End-to-end InMemoryStore script: each action mutates the same
        // fixture store, mirroring the Node sequential await chain.
        "inMemoryStore" => {
            let seed = request["job"].is_null().then(Vec::new)
                .unwrap_or_else(|| vec![request["job"].clone()]);
            let mut store = InMemoryStore::new(seed.first());
            let mut outcomes = Vec::<Value>::new();
            for action in request["actions"].as_array()
                .ok_or("actions required")? {
                let method = action["m"].as_str().unwrap_or("");
                let result: Result<Value, String> = match method {
                    "saveJob" => {
                        store.save_job(&action["job"]);
                        Ok(Value::Null)
                    }
                    "load" => store.load(action["id"].as_str().unwrap_or("")),
                    "mutateJob" => {
                        // The fixture mutation is a declarative patch:
                        // {"state": "COMPLETED"} merges over the loaded job.
                        let patch = action["patch"].clone();
                        store.mutate_job(
                            action["id"].as_str().unwrap_or(""),
                            |mut job| {
                                if let Some(object) = job.as_object_mut() {
                                    if let Some(fields) = patch.as_object() {
                                        for (key, value) in fields {
                                            object.insert(key.clone(), value.clone());
                                        }
                                    }
                                }
                                Ok(job)
                            })
                    }
                    "appendPlan" => store.append_plan(&action["plan"])
                        .map(|_| Value::Null),
                    "savePlan" => {
                        store.save_plan(&action["plan"]);
                        Ok(Value::Null)
                    }
                    "appendTask" => store.append_task(&action["task"])
                        .map(|_| Value::Null),
                    "saveTask" => {
                        store.save_task(&action["task"]);
                        Ok(Value::Null)
                    }
                    "listAgents" => Ok(json!(store.list_agents())),
                    "saveAgent" => {
                        store.save_agent(&action["agent"]);
                        Ok(Value::Null)
                    }
                    "comments" => Ok(json!(store.comments())),
                    "headSha" => Ok(json!(store.head_sha())),
                    "closePullRequest" => {
                        store.close_pull_request();
                        Ok(Value::Null)
                    }
                    "updatePullRequestBody" => {
                        store.update_pull_request_body(
                            action["body"].as_str().unwrap_or(""));
                        Ok(Value::Null)
                    }
                    _ => Err(format!("Unknown inMemoryStore action {method}")),
                };
                outcomes.push(match result {
                    Ok(value) => json!({"ok": true, "value": value}),
                    Err(error) => json!({"ok": false, "error": error}),
                });
            }
            // Node comments() stamps fresh ISO timestamps; normalize away.
            // The comments action returns a bare array (not {comments:[...]}),
            // so scan each outcome value for rows shaped like comments.
            let mut outcomes_value = Value::Array(outcomes);
            if let Some(rows) = outcomes_value.as_array_mut() {
                for row in rows {
                    if row["ok"] == true {
                        if let Some(items) = row.get_mut("value")
                            .and_then(Value::as_array_mut) {
                            for item in items {
                                if let Some(object) = item.as_object_mut() {
                                    if object.contains_key("updatedAt")
                                        && object.contains_key("authorLogin") {
                                        object.insert("updatedAt".into(),
                                            json!("NORMALIZED"));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Adapters must return the raw JSON value; the parity main()
            // already wraps it as {"ok":true,"value":...}.
            outcomes_value.to_string()
        }
        _ => return Err(format!("Unknown storePublicParity method {method}")),
    }))
}
