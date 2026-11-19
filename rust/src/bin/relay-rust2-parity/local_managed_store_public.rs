// Original local-managed-store.ts public API differential: admission
// validation, scope resolution and store construction over real SQLite
// files. The recursive LocalAuthorityDurableStore wiring is verified through
// behavior of the returned authority (saveTask/load round-trip) without any
// GitHub access (noGitHub fixtures).
use agents_relay_rust2::local_managed_store::open_local_managed_store;
use serde_json::{json, Value};

pub fn invoke(request: &Value) -> Option<Result<String, String>> {
    if request["op"] != "certLocalManagedStore" {
        return None;
    }
    Some((|| {
        match request["method"].as_str().unwrap_or("") {
            "open" => {
                let result = open_local_managed_store(
                    request["repository"].as_str().unwrap_or(""),
                    request["prNumber"].as_i64().unwrap_or(-1),
                    std::path::Path::new(
                        request["directory"].as_str().unwrap_or(""),
                    ),
                    request["jobId"].as_str(),
                    request["noGitHub"].as_bool().unwrap_or(false),
                );
                match result {
                    Ok(mut store) => {
                        // Prove the authority is usable over real SQLite:
                        // create a Job, save a Task, load it back.
                        let job_id=request["jobId"].as_str()
                            .unwrap_or("scope-check").to_string();
                        let created = store.create_job_if_absent(&json!({
                            "id":&job_id,"repository":"owner/repo",
                            "state":"QUEUED","tasks":[],"plans":[]}));
                        let task = json!({"id":"t1","jobId":&job_id,
                            "state":"QUEUED","title":"probe","agentName":"worker"});
                        let saved = store.save_task(&task);
                        let loaded = store.load(&job_id);
                        Ok(json!({"ok":true,
                            "createJob":created.is_ok(),
                            "saveTask":saved.is_ok(),
                            "taskVisible":loaded.ok()
                                .and_then(|job|job.get("tasks").cloned())
                                .and_then(|tasks|tasks.as_array().map(|items| {
                                    items.iter().any(|t|t.get("id")
                                        ==Some(&json!("t1")))
                                }))
                                .unwrap_or(false)}).to_string())
                    }
                    Err(error) => {
                        Ok(json!({"ok":false,"error":error}).to_string())
                    }
                }
            }
            value => Err(format!("Unknown local managed store method {value}")),
        }
    })())
}
