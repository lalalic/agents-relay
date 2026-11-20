// rust/src/bin/relay-rust2-parity/workspace_local_public.rs
// Direct differential for src/workspace.ts local/identity helpers over real
// temporary Git repositories: validateProjectRoot, resolveWorkspaceRoot,
// discoverWorkspaceRepositories/resolveWorkspaceRepositoryPath,
// githubRepositoryFromRemote, run-path predicates, worktree path builders,
// ensureLocalJobSourceBranch, prepareLocalJobExecutionWorktree and
// assertCleanWorktreeAtHead. No network; disposable directories only.
use agents_relay_rust2::workspace as ws;
use serde_json::{json, Value};
use std::path::Path;

fn outcome(result: Result<Value, String>) -> String {
    json!({"outcome": match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(error) => json!({"ok": false, "error": error}),
    }}).to_string()
}

fn path_result(result: Result<std::path::PathBuf, String>) -> String {
    outcome(result.map(|p| json!(p.to_string_lossy().to_string())))
}

pub fn invoke(request: &Value) -> Result<Option<String>, String> {
    if request["op"] != "workspaceLocalParity" {
        return Ok(None);
    }
    let method = request["method"].as_str().unwrap_or("");
    Ok(Some(match method {
        "validateProjectRoot" => path_result(ws::validate_project_root(
            Path::new(request["projectRoot"].as_str().unwrap_or("")),
            request["repository"].as_str().unwrap_or(""),
        )),
        "resolveWorkspaceRoot" => path_result(ws::resolve_workspace_root(
            request["explicit"].as_str(),
        )),
        "discoverWorkspaceRepositories" => outcome(
            ws::discover_workspace_repositories(Path::new(
                request["root"].as_str().unwrap_or(""),
            )).map(|entries| json!(entries)),
        ),
        "resolveWorkspaceRepositoryPath" => path_result(
            ws::resolve_workspace_repository_path(
                request["repository"].as_str().unwrap_or(""),
                Path::new(request["root"].as_str().unwrap_or("")),
            ),
        ),
        "resolveManagedProjectPath" => path_result(
            ws::resolve_managed_project_path(
                request["repository"].as_str(),
                request["explicitProjectPath"].as_str(),
                Path::new(request["root"].as_str().unwrap_or("")),
                Path::new(request["cwd"].as_str().unwrap_or("")),
            ),
        ),
        "githubRepositoryFromRemote" => outcome(Ok(json!(
            ws::github_repository_from_remote(
                request["remote"].as_str().unwrap_or(""))))),
        "isProjectRunPath" => outcome(Ok(json!(ws::is_project_run_path(
            request["path"].as_str())))),
        "taskUsesCanonicalProjectRun" => outcome(Ok(json!(
            ws::task_uses_canonical_project_run(
                &request["task"],
                request["tasks"].as_array().map(Vec::as_slice)
                    .unwrap_or(&[]))))),
        "managedJobWorktreePath" => path_result(ws::managed_job_worktree_path(
            request["repository"].as_str().unwrap_or(""),
            request["prNumber"].as_u64().unwrap_or(0),
            Path::new(request["workspaceRoot"].as_str().unwrap_or("")),
        )),
        "managedLocalJobWorktreePath" => path_result(
            ws::managed_local_job_worktree_path(
                request["repository"].as_str().unwrap_or(""),
                request["jobId"].as_str().unwrap_or(""),
                Path::new(request["workspaceRoot"].as_str().unwrap_or("")),
            ),
        ),
        "jobRequiresManagedWorktree" => outcome(Ok(json!(
            ws::job_requires_managed_worktree(&request["job"])))),
        "taskRequiresManagedWorktree" => outcome(Ok(json!(
            ws::task_requires_managed_worktree(
                &request["job"],
                request.get("task").filter(|v| !v.is_null()))))),
        "ensureLocalJobSourceBranch" => outcome(
            ws::ensure_local_job_source_branch(
                Path::new(request["projectPath"].as_str().unwrap_or("")),
                &request["job"],
            ).map(|r| json!(r))),
        "prepareLocalJobExecutionWorktree" => path_result(
            ws::prepare_local_job_execution_worktree(
                Path::new(request["projectPath"].as_str().unwrap_or("")),
                &request["job"],
                Path::new(request["workspaceRoot"].as_str().unwrap_or("")),
            )),
        "assertCleanWorktreeAtHead" => outcome(
            ws::assert_clean_worktree_at_head(
                Path::new(request["projectPath"].as_str().unwrap_or("")),
                request["headSha"].as_str().unwrap_or(""),
            ).map(|_| Value::Null)),
        _ => return Err("unknown workspace local method".into()),
    }))
}
