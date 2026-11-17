// Wave 2 isolated fixture adapter: pure data and disposable SQLite/Git/FS only.
// Never reaches configured provider, production store, or user Job state.
use crate::{
    dag_result_contract::dag_completion_error, dag_stage_contract::StageExecution,
    host_invocation_store as host, local_git_merge as merge,
    planner_task_ids::assign_planner_task_ids,
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;

pub fn delivery_wave2(request: &Value) -> Result<Value, String> {
    match request["case"].as_str().ok_or("case required")? {
        "servicePublicationScenario" => service_scenario(request),
        "zOAuthScenario" => z_oauth_scenario(request),
        "zOAuthEndpoint" => Ok(json!(crate::z_oauth::z_worker_mcp_endpoint(
            request["origin"].as_str()
        )?)),
        "migration" => {
            let (count, path) =
                crate::job_local_repository_migration::migrate_job_local_repositories(
                    Path::new(request["database"].as_str().ok_or("database required")?),
                    Path::new(request["mapping"].as_str().ok_or("mapping required")?),
                )?;
            Ok(json!({"migrated":count,"backupPath":path.to_string_lossy()}))
        }
        "migrationBackupPath" => Ok(json!(
            crate::job_local_repository_migration::migration_backup_path(Path::new(
                request["database"].as_str().ok_or("database required")?
            ))
            .to_string_lossy()
            .to_string()
        )),
        "classifyRoutingFailure" => Ok(json!(
            crate::route_outcome_recording::classify_routing_failure(
                request["message"].as_str().unwrap_or(""),
                request["fallback"].as_str().unwrap_or("task_failure")
            )
        )),
        "routeOutcome" => {
            let module = &request["kind"];
            let (kind, reason, evidence) = match module.as_str().unwrap_or("") {
                "terminal" => crate::route_outcome_recording::terminal_route_arguments(
                    &request["event"],
                    request["executionId"].as_str(),
                ),
                "launch" => crate::route_outcome_recording::launch_route_arguments(
                    &request["task"],
                    request["message"].as_str().unwrap_or(""),
                    request["phase"].as_str().unwrap_or("launch"),
                    request["executionId"].as_str(),
                    request["unknownOutcome"] == true,
                ),
                "watchdog" => {
                    crate::route_outcome_recording::watchdog_route_arguments(&request["watchdog"])
                }
                _ => (
                    request["recordKind"]
                        .as_str()
                        .unwrap_or("task_failure")
                        .to_owned(),
                    request["reason"].as_str().unwrap_or("").to_owned(),
                    request["evidence"].clone(),
                ),
            };
            Ok(crate::route_outcome_recording::record_route_outcome_at(
                &request["task"],
                &kind,
                &reason,
                &evidence,
                "2026-11-17T12:00:00.000Z",
                "00000000-0000-4000-8000-000000000000",
                |_| Ok(()),
            )
            .unwrap_or(Value::Null))
        }
        "githubAppConfig" => {
            let args = request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|s| s.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            let env = request["env"]
                .as_object()
                .ok_or("env required")?
                .iter()
                .filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string())))
                .collect::<std::collections::HashMap<_, _>>();
            let config = crate::github_auth::github_app_config(&args, &env)?;
            Ok(match config {
                None => Value::Null,
                Some(cfg) => json!({"appId":cfg.app_id,"installationId":cfg.installation_id,
                    "privateKeyFile":cfg.private_key_file}),
            })
        }
        "cleanupMergedJobWorktree" => {
            let resolver_present = request["resolverPresent"] != false;
            let cwd = request["cwd"].as_str().unwrap_or("/tmp/fixture").to_owned();
            let response = request["result"].clone();
            let outcome = if resolver_present {
                crate::job_worktree_cleanup::cleanup_merged_job_worktree(
                    &request["job"],
                    Some(|_: &Value| Ok(cwd.clone())),
                    |_, _| Ok(response.clone()),
                )
            } else {
                crate::job_worktree_cleanup::cleanup_merged_job_worktree(
                    &request["job"],
                    None::<fn(&Value) -> Result<String, String>>,
                    |_, _| Ok(response.clone()),
                )
            };
            Ok(match outcome {
                Ok(()) => json!({"ok":true}),
                Err(message) => json!({"ok":false,"error":message}),
            })
        }
        "managedWorkerInput" => {
            let context = request.get("context").filter(|v| !v.is_null());
            let selected = request["selected"].clone();
            let package_root = request["packageRoot"]
                .as_str()
                .ok_or("packageRoot required")?;
            let prompt = crate::managed_worker_input::managed_worker_input(
                &request["job"],
                &request["task"],
                context,
                request["mode"].as_str().unwrap_or("production"),
                Path::new(package_root),
                |_, _| Ok(selected.clone()),
                request["referenceDirectory"].as_str(),
            )?;
            Ok(Value::String(prompt))
        }
        "continuationScenario" => continuation_scenario(request),
        "projectionFailureScenario" => projection_failure_scenario(request),
        "planner" => assign_planner_task_ids(
            &request["result"],
            request["repository"].as_str().unwrap_or(""),
            request["jobId"].as_str().unwrap_or(""),
            request["planId"].as_str().unwrap_or(""),
            Path::new(request["directory"].as_str().ok_or("directory required")?),
        ),
        "localMerge" => {
            let repo = Path::new(request["repo"].as_str().ok_or("repo required")?);
            let result = merge::deliver_local_merge(repo, &request["receipt"])?;
            Ok(json!({"sourceSha":result.source_sha,"mergedCommitSha":result.merged_commit_sha}))
        }
        "localHead" => Ok(json!(merge::local_working_head(Path::new(
            request["repo"].as_str().ok_or("repo required")?
        ))?)),
        "localSourceHead" => Ok(json!(merge::local_source_head(
            Path::new(request["repo"].as_str().ok_or("repo required")?),
            request["sourceRef"].as_str().unwrap_or("")
        )?)),
        "localMergeMessage" => Ok(json!(merge::local_merge_commit_message(
            request["correlationJobId"].as_str(),
            request["displayPrNumber"].as_i64(),
            request["sourceSha"].as_str().unwrap_or("")
        ))),
        "requiresLocalGitMerge" => Ok(json!(merge::requires_local_git_merge(&request["job"]))),
        "localMergeFacts" => Ok(merge::local_merge_facts(
            &request["job"],
            request["headSha"].as_str(),
            request["nowMs"].as_i64().unwrap_or(0),
            request["implementationComplete"].as_bool().unwrap_or(false),
            request["completionGateSatisfied"]
                .as_bool()
                .unwrap_or(false),
        )),
        "dagResult" => {
            let output = dag_completion_error(
                &request["task"],
                request["projectPath"].as_str().map(Path::new),
                request["interpreter"].as_str().unwrap_or("node"),
                |_args, _cwd| {
                    let response = &request["response"];
                    Ok(StageExecution {
                        stdout: response["stdout"].as_str().unwrap_or("").into(),
                        stderr: response["stderr"].as_str().unwrap_or("").into(),
                        code: response["code"].as_i64().unwrap_or(0) as i32,
                    })
                },
            );
            Ok(json!(output))
        }
        "hostInvocationScenario" => host_scenario(request),
        other => Err(format!("unknown delivery scenario: {other}")),
    }
}
fn host_scenario(request: &Value) -> Result<Value, String> {
    let mut db = Connection::open_in_memory().map_err(|e| e.to_string())?;
    db.execute_batch(&format!(
        "CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);{}",
        host::HOST_INVOCATION_TABLES_SQL
    ))
    .map_err(|e| e.to_string())?;
    if let Some(job) = request.get("job") {
        db.execute(
            "INSERT INTO job_snapshot(job_id,json) VALUES(?,?)",
            params![job["id"].as_str().unwrap_or(""), job.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    let mut outcomes = Vec::new();
    for step in request["deliveries"]
        .as_array()
        .ok_or("deliveries required")?
    {
        let delivery = &step["delivery"];
        let fingerprint = step["fingerprint"].as_str().unwrap_or("");
        let fail = step["snapshotFail"] == true;
        let result = host::record_host_invocation_decision(
            &mut db,
            delivery,
            fingerprint,
            |tx, job, _at| {
                if fail {
                    return Err("fixture_snapshot_write_rejected".into());
                }
                tx.execute(
                    "UPDATE job_snapshot SET json=? WHERE job_id=?",
                    params![job.to_string(), job["id"].as_str().unwrap_or("")],
                )
                .map_err(|e| e.to_string())
                .map(|_| ())
            },
        );
        match result {
            Ok(receipt) => outcomes.push(receipt.value()),
            Err(error) => outcomes.push(json!({"error":error})),
        }
    }
    let events: i64 = db
        .query_row("SELECT COUNT(*) FROM host_invocation_event", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let decisions: i64 = db
        .query_row("SELECT COUNT(*) FROM host_invocation_decision", [], |row| {
            row.get(0)
        })
        .map_err(|e| e.to_string())?;
    let snapshot: Option<String> = db
        .query_row("SELECT json FROM job_snapshot LIMIT 1", [], |row| {
            row.get(0)
        })
        .ok();
    let snapshot = snapshot
        .map(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string()))
        .transpose()?;
    Ok(json!({"outcomes":outcomes,"events":events,"decisions":decisions,"snapshot":snapshot}))
}

fn service_scenario(request: &Value) -> Result<Value, String> {
    let mut db = Connection::open_in_memory().map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE publication_state(job_id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE publication_delivery(job_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(job_id,delivery_id));").map_err(|e|e.to_string())?;
    let mut events = Vec::new();
    for wake in request["wakes"].as_array().ok_or("wakes required")? {
        crate::service_publication::handle_service_publication(
            &request["job"],
            wake,
            &mut db,
            |event| {
                let mut event = event.clone();
                event.as_object_mut().expect("object").remove("timestamp");
                events.push(event);
                Ok(())
            },
        )?;
    }
    let job = request["job"]["id"].as_str().unwrap_or("");
    let state = crate::publication_store::load_publication_from_database(&db, job)?;
    let deliveries = crate::publication_store::list_publication_events_from_database(&db, job)?;
    Ok(json!({"events":events,"state":state,"deliveries":deliveries}))
}

fn z_oauth_scenario(request: &Value) -> Result<Value, String> {
    use crate::z_oauth::{issue_z_worker_credential, OAuthResponse, REDIRECT_URI};
    let scenario = request["stage"].as_str().unwrap_or("ok");
    let origin = request["origin"].as_str();
    let mut count = 0;
    let mut authorization_state = String::new();
    let response = issue_z_worker_credential(
        origin,
        request["operatorToken"].as_str(),
        None,
        |url, method, _body, _headers| {
            count += 1;
            let path = url.strip_prefix("https://oauth.example.test").unwrap_or("");
            let (status, body, location) = if path == "/register" {
                if scenario == "register-fail" {
                    (403, "{}".to_owned(), None)
                } else if scenario == "missing-client" {
                    (201, "{}".to_owned(), None)
                } else {
                    (201, r#"{"client_id":"fixture-client"}"#.to_owned(), None)
                }
            } else if path.starts_with("/authorize?") && method == "GET" {
                authorization_state = url::Url::parse(url)
                    .map_err(|e| e.to_string())?
                    .query_pairs()
                    .find(|(key, _)| key == "state")
                    .map(|(_, v)| v.into_owned())
                    .unwrap_or_default();
                if scenario == "page-fail" {
                    (500, String::new(), None)
                } else if scenario == "missing-rid" {
                    (200, "<html/>".to_owned(), None)
                } else {
                    (
                        200,
                        "<input name=\"rid\" value=\"fixture_rid\">".to_owned(),
                        None,
                    )
                }
            } else if path == "/authorize" && method == "POST" {
                if scenario == "consent-fail" {
                    (401, String::new(), None)
                } else if scenario == "missing-location" {
                    (302, String::new(), None)
                } else {
                    let state = if scenario == "callback-mismatch" {
                        format!("{}wrong", authorization_state)
                    } else {
                        authorization_state.clone()
                    };
                    let code = if scenario == "missing-code" {
                        ""
                    } else {
                        "code=fixture-code&"
                    };
                    let callback = format!(
                        "{REDIRECT_URI}?{code}state={state}&iss=https%3A%2F%2Foauth.example.test"
                    );
                    (302, String::new(), Some(callback))
                }
            } else if path == "/token" {
                if scenario == "token-fail" {
                    (503, String::new(), None)
                } else if scenario == "invalid-token" {
                    (
                        200,
                        r#"{"access_token":"x","expires_in":15}"#.to_owned(),
                        None,
                    )
                } else {
                    (200,r#"{"access_token":"fixture-access","expires_in":3600,"refresh_token":"fixture-refresh"}"#.to_owned(),None)
                }
            } else if path == "/revoke" {
                (
                    if scenario == "revoke-fail" { 403 } else { 200 },
                    String::new(),
                    None,
                )
            } else {
                return Err(format!("unexpected mock OAuth {method} {path}"));
            };
            Ok(OAuthResponse {
                status,
                body,
                location,
            })
        },
    );
    Ok(match response {
        Ok(token) => json!({"ok":true,"token":token,"calls":count}),
        Err(error) => json!({"ok":false,"error":error,"calls":count}),
    })
}

fn continuation_scenario(request: &Value) -> Result<Value, String> {
    use crate::continuation::{continue_with_adapters, Continuation, ContinuationAdapters};
    let kind = request["adapterKind"].as_str().unwrap_or("command");
    let actual = request["continuationKind"].as_str().unwrap_or("command");
    let target = request["target"].as_str().unwrap_or("fixture-target");
    let input = request["input"].as_str().unwrap_or("fixture-input");
    let status = request["status"].as_i64().unwrap_or(0) as i32;
    let http_status = request["httpStatus"].as_u64().unwrap_or(200) as u16;
    let mut calls = Vec::new();
    let mut run = |command: &str, args: &[&str], invocation: &str| {
        calls.push(json!({"command":command,"args":args,"invocation":invocation}));
        Ok(status)
    };
    let mut post = |url: &str, body: &str| {
        Ok::<_, String>({
            let _ = (url, body);
            http_status
        })
    };
    let continuation = match actual {
        "codex-thread" => Continuation::CodexThread { target },
        "webhook" => Continuation::Webhook { target },
        _ => Continuation::Command { target },
    };
    let mut adapters = ContinuationAdapters {
        run_owned: &mut run,
        post: &mut post,
    };
    let outcome = continue_with_adapters(
        kind,
        input,
        continuation,
        Some(
            request["commandOverride"]
                .as_str()
                .unwrap_or("/usr/bin/true"),
        ),
        &mut adapters,
    );
    Ok(match outcome {
        Ok(()) => json!({"ok":true,"calls":calls}),
        Err(message) => json!({"ok":false,"error":message,"calls":calls}),
    })
}

fn projection_failure_scenario(request: &Value) -> Result<Value, String> {
    let mut dedupe = crate::projection_failure_dedupe::ProjectionFailureDeduplicator::default();
    let mut events = Vec::new();
    let mut observations = Vec::new();
    let mut accepted = Vec::new();
    for failure in request["failures"].as_array().ok_or("failures required")? {
        let job = &failure["job"];
        let current = crate::projection_failure_recovery::handle_github_projection_failure(
            &failure["error"],
            failure["asError"] == true,
            job,
            &mut dedupe,
            |event| {
                let mut event = event.clone();
                if let Some(o) = event.as_object_mut() {
                    o.remove("timestamp");
                    o.remove("event_id");
                }
                events.push(event);
                Ok(())
            },
            |observation| observations.push(observation.clone()),
        );
        accepted.push(current);
    }
    Ok(json!({"events":events,"observations":observations,"accepted":accepted}))
}
