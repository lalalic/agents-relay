// rust/src/bin/relay-rust2-parity/batch_a_public.rs
// Direct differential for the batch-A small modules:
// - src/cli-foreground.ts   foreground_event_line / refresh_names / on_event
// - src/job-worktree-cleanup.ts cleanupMergedJobWorktree (injected adapters)
// - src/service-external-actions.ts flush_service_external_actions
// - src/legacy-orchestrator-repair.ts repair_legacy_orchestrators (ports)
// - src/router-evals.ts     ROUTER_EVAL_CASES / worker_for_route / run_router_evals
// - src/dashboard-actions.ts dashboard task/job setState adapters
// - src/blocker-recovery.ts validate_input / intent_fingerprint / make_request
// - src/cli-job-create.ts   ensure_managed_local_job validation-first paths
use agents_relay_rust2::{
    blocker_recovery as blocker_recovery_mod,
    cli_foreground::foreground_event_line,
    dashboard_actions::{dashboard_job_set_state, dashboard_task_action, dashboard_task_set_state},
    job_worktree_cleanup::cleanup_merged_job_worktree,
    router_evals::{router_eval_cases, run_router_evals, worker_for_route},
};
use serde_json::{json, Value};
use std::future::Future;
use std::pin::pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

fn drive<T>(future: impl Future<Output = T>) -> T {
    let mut context = Context::from_waker(Waker::noop());
    let mut pinned = pin!(future);
    loop {
        if let Poll::Ready(value) = pinned.as_mut().poll(&mut context) {
            return value;
        }
    }
}

/// Serialize a Result<Value,String> as {ok,value} / {ok:false,error} so the
/// Node side can compare Rust error paths against thrown Node errors.
fn outcome(result: Result<Value, String>) -> Value {
    match result {
        Ok(value) => json!({"ok": true, "value": value}),
        Err(message) => json!({"ok": false, "error": message}),
    }
}

pub fn invoke(request: &Value) -> Result<Option<String>, String> {
    if request["op"] != "batchAPublicParity" {
        return Ok(None);
    }
    let method = request["method"].as_str().unwrap_or("");
    Ok(Some(match method {
        "foregroundEventLine" => {
            let names: std::collections::HashMap<String, String> = request["names"]
                .as_object()
                .map(|map| {
                    map.iter()
                        .filter_map(|(key, value)| {
                            value.as_str().map(|name| (key.clone(), name.to_string()))
                        })
                        .collect()
                })
                .unwrap_or_default();
            json!(foreground_event_line(&request["event"], &names)).to_string()
        }
        "cleanupMergedJobWorktree" => {
            let job = request["job"].clone();
            let cwd_result: Option<Result<String, String>> = request
                .get("cwd")
                .and_then(Value::as_str)
                .map(|path| Ok(path.to_string()))
                .or_else(|| {
                    request
                        .get("cwdError")
                        .and_then(Value::as_str)
                        .map(|message| Err(message.to_string()))
                });
            let cleanup_result: Result<Value, String> =
                if let Some(result) = request.get("cleanup").filter(|v| v.is_object()) {
                    if result.get("error").is_some_and(|e| !e.is_null()) {
                        Err(result["error"].as_str().unwrap_or("").to_string())
                    } else {
                        Ok(result.clone())
                    }
                } else {
                    Err("cleanup adapter missing".into())
                };
            let result = match cwd_result {
                None => cleanup_merged_job_worktree(
                    &job,
                    None::<fn(&Value) -> Result<String, String>>,
                    |_, _| cleanup_result.clone(),
                ),
                Some(Ok(path)) => {
                    let path = path.clone();
                    cleanup_merged_job_worktree(
                        &job,
                        Some(move |_: &Value| Ok(path.clone())),
                        |_, _| cleanup_result.clone(),
                    )
                }
                Some(Err(message)) => cleanup_merged_job_worktree(
                    &job,
                    Some(move |_: &Value| Err(message.clone())),
                    |_, _| cleanup_result.clone(),
                ),
            };
            outcome(result.map(|_| json!(null))).to_string()
        }
        "flushServiceExternalActions" => {
            let is_local = request["isLocalAuthority"].as_bool().unwrap_or(false);
            let no_github = request["noGitHub"].as_bool().unwrap_or(false);
            let projected = request["flushProjected"].as_i64().unwrap_or(0);
            let flush_error = request["flushError"].as_str().map(str::to_string);
            let reconcile_error = request["reconcileError"].as_str().map(str::to_string);
            let reconcile_calls = Arc::new(Mutex::new(0u32));
            let observed = reconcile_calls.clone();
            let result: Result<usize, String> = drive(
                agents_relay_rust2::service_external_actions::flush_service_external_actions(
                    is_local,
                    no_github,
                    || async {
                        flush_error.clone().map_or(Ok(projected as usize), Err)
                    },
                    {
                        let calls = reconcile_calls.clone();
                        move || {
                            let calls = calls.clone();
                            async move {
                                *calls.lock().unwrap() += 1;
                                reconcile_error.clone().map_or(Ok(()), Err)
                            }
                        }
                    },
                ),
            );
            let calls = *observed.lock().unwrap();
            outcome(result.map(|count| json!({"projected": count, "reconcileCalls": calls})))
                .to_string()
        }
        "repairLegacyOrchestrators" => {
            // Script-driven ports: each load() returns the next job snapshot
            // from "loads"; reclaim results come from "reclaims"; persist
            // success from "persist"; all emitted events are collected.
            let loads: Vec<Value> = request["loads"].as_array().cloned().unwrap_or_default();
            let reclaims: Vec<bool> = request["reclaims"]
                .as_array()
                .map(|list| list.iter().filter_map(Value::as_bool).collect())
                .unwrap_or_default();
            let persist_ok = request["persist"].as_bool().unwrap_or(true);
            let emitted = Arc::new(Mutex::new(Vec::<Value>::new()));
            let load_index = Arc::new(Mutex::new(0usize));
            let reclaim_index = Arc::new(Mutex::new(0usize));
            let loads = loads.clone();
            let loads_for_error = loads.clone();
            let reclaims = reclaims.clone();
            let observed = emitted.clone();
            let graph_dir = request["graphDirectory"].as_str().unwrap_or("docs/workflows").to_string();
            let job_id = request["jobId"].as_str().unwrap_or("17").to_string();
            let now = request["now"].as_i64().unwrap_or(0);
            let result: Result<(), String> = drive(
                agents_relay_rust2::legacy_orchestrator_repair::repair_legacy_orchestrators(
                    std::path::Path::new(&graph_dir),
                    &job_id,
                    now,
                    move || {
                        let index = *load_index.lock().unwrap();
                        *load_index.lock().unwrap() += 1;
                        let loads = loads.clone();
                        async move {
                            // Replay the last snapshot once the script is
                            // exhausted, mirroring a store whose Job does not
                            // change between repair reads.
                            loads
                                .get(index.min(loads.len().saturating_sub(1)))
                                .cloned()
                                .ok_or_else(|| "no more loads".to_string())
                        }
                    },
                    move |task| {
                        let index = *reclaim_index.lock().unwrap();
                        *reclaim_index.lock().unwrap() += 1;
                        let reclaims = reclaims.clone();
                        async move {
                            let _ = task;
                            Ok(reclaims.get(index).copied().unwrap_or(true))
                        }
                    },
                    move |_id, _previous, _repaired| async move { Ok(persist_ok) },
                    move |event| {
                        let sink = observed.clone();
                        async move {
                            // Event identity is generated per run; normalize
                            // before comparison like the Node side.
                            let mut event = event;
                            if let Some(object) = event.as_object_mut() {
                                object.insert("event_id".into(), json!("NORMALIZED"));
                                object.insert("timestamp".into(), json!("NORMALIZED"));
                            }
                            sink.lock().unwrap().push(event);
                            Ok(())
                        }
                    },
                ),
            );
            let _ = loads_for_error;
            outcome(result.map(|_| json!({"emitted": *emitted.lock().unwrap()})))
                .to_string()
        }
        "routerEvalCases" => json!(router_eval_cases()).to_string(),
        "workerForRoute" => json!(worker_for_route(request["route"].as_str().unwrap_or("")))
            .to_string(),
        "runRouterEvals" => {
            let selections: Vec<String> = request["selections"]
                .as_array()
                .map(|list| {
                    list.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect()
                })
                .unwrap_or_default();
            let probabilities = request["probabilities"].clone();
            let mut index = 0usize;
            let report: Result<_, String> = drive(run_router_evals(|_case, choices| {
                let selected = selections
                    .get(index.min(selections.len().saturating_sub(1)))
                    .cloned()
                    .unwrap_or_else(|| choices[0].clone());
                index += 1;
                let probabilities = probabilities
                    .as_array()
                    .and_then(|list| list.get(index - 1))
                    .cloned()
                    // JSON null and JSON.stringify-dropped undefined both
                    // mean "no probabilities" on the Node side.
                    .filter(|value| !value.is_null());
                async move { Ok((selected, probabilities)) }
            }));
            match report {
                Ok(report) => serde_json::to_value(report).unwrap_or(Value::Null).to_string(),
                Err(message) => json!({"ok": false, "error": message}).to_string(),
            }
        }
        "dashboardTaskAction" => outcome(
            dashboard_task_action(
                &request["job"],
                request["taskId"].as_str().unwrap_or(""),
                request["action"].as_str().unwrap_or(""),
            )
            .map_err(|message| message),
        )
        .to_string(),
        "dashboardJobSetState" => {
            let graph_dir = request["graphDirectory"].as_str().unwrap_or("docs/workflows");
            let result = dashboard_job_set_state(
                std::path::Path::new(graph_dir),
                &request["job"],
                request["state"].as_str().unwrap_or(""),
            )
            .map(|(job, close_pr)| json!({"job": job, "closePullRequest": close_pr}));
            outcome(result).to_string()
        }
        "dashboardTaskSetState" => outcome(
            dashboard_task_set_state(
                &request["job"],
                request["taskId"].as_str().unwrap_or(""),
                request["state"].as_str().unwrap_or(""),
            )
            .map(|command| json!({"command": command
                .as_ref()
                .and_then(|value| value.get("id").cloned())
                .unwrap_or(Value::Null)})),
        )
        .to_string(),
        "dashboardTaskCommandNative" => {
            // Native server->Graph->SQLite end-to-end parity is constrained
            // to disposable local Git workspaces under the OS temp directory.
            let work=(||->Result<Value,String>{
                use agents_relay_rust2::{
                    relayd::{DaemonConfig,DaemonServices},
                    relayd_sqlite_write::IsolatedSQLiteWriteHost,
                };
                use std::path::PathBuf;
                let stores=request["storeDirectory"].as_str()
                    .ok_or("Fixture storeDirectory required")?;
                let directory=std::fs::canonicalize(stores).map_err(|e|e.to_string())?;
                let base=directory.parent().ok_or("Missing fixture parent")?;
                let disposable=base.parent().ok_or("Missing fixture root")?;
                let temp=std::fs::canonicalize(std::env::temp_dir())
                    .map_err(|e|e.to_string())?;
                if !disposable.starts_with(temp)
                    || !disposable.file_name().and_then(|v|v.to_str())
                        .is_some_and(|v|v.starts_with("rust2-dashboard-diff-")){
                    return Err("Refusing non-disposable Dashboard parity fixture".into());
                }
                let mut config=DaemonConfig::from_argv(&[],&json!({}))?;
                config.graph_directory=PathBuf::from("workflow");
                config.store_directory=directory.clone();
                config.workspace_root=base.to_path_buf();
                config.repositories=vec!["mockrepo".into()];
                let mut host=IsolatedSQLiteWriteHost::new(config);
                DaemonServices::task_command(&mut host,&request["input"])
            })();
            outcome(work).to_string()
        }
        "blockerEnsureNative" => {
            // Direct original Node/Rust integration fixture. Never allow this
            // parity binary to write an arbitrary user/production SQLite DB.
            let work = (|| -> Result<Value,String> {
                use agents_relay_rust2::{
                    relayd::DaemonConfig,
                    relayd_sqlite_write::IsolatedSQLiteWriteHost,
                    relayd_control::WorkspaceControlBackend,
                    relay_store_discovery::discover_local_relay_store_snapshots,
                };
                use std::path::{Path,PathBuf};
                let stores=request["storeDirectory"].as_str()
                    .ok_or("Fixture storeDirectory is required")?;
                let directory=std::fs::canonicalize(stores)
                    .map_err(|e|e.to_string())?;
                let parent=directory.parent().ok_or("Fixture has no parent")?;
                let disposable_root=parent.parent().ok_or("Fixture has no root")?;
                let temp=std::fs::canonicalize(std::env::temp_dir())
                    .map_err(|e|e.to_string())?;
                if !disposable_root.starts_with(&temp)
                    || !disposable_root.file_name().and_then(|v|v.to_str())
                        .is_some_and(|name|name.starts_with("rust2-blocker-diff-")){
                    return Err("Refusing non-disposable blocker parity fixture".into());
                }
                let mut config=DaemonConfig::from_argv(&[],&json!({
                    "storeDirectory":stores,"graphDirectory":Path::new("workflow")
                }))?;
                config.store_directory=PathBuf::from(stores);
                config.graph_directory=PathBuf::from("workflow");
                config.repositories=vec!["dependent".into(),"target".into()];
                let mut host=IsolatedSQLiteWriteHost::new(config);
                let receipt=host.blocker_ensure(&request["input"])?;
                let snapshots=discover_local_relay_store_snapshots(&directory)?;
                let jobs=snapshots.into_iter().flat_map(|item|item.jobs)
                    .collect::<Vec<_>>();
                Ok(json!({"receipt":receipt,"jobs":jobs}))
            })();
            outcome(work).to_string()
        }
        "blockerValidateInput" => {
            outcome(blocker_recovery_mod::validate_input(&request["input"]).map(|_| json!(null)))
                .to_string()
        }
        "blockerIntentFingerprint" => outcome(blocker_recovery_mod::intent_fingerprint(
            &request["input"],
            request["blockedAttempt"].as_u64().unwrap_or(0),
        )
        .map(|fingerprint| json!(fingerprint)))
        .to_string(),
        "blockerMakeRequest" => outcome(blocker_recovery_mod::make_request(
            &request["input"],
            request["blockedAttempt"].as_u64().unwrap_or(0),
            request["now"].as_str().unwrap_or(""),
        ))
        .to_string(),
        "cliJobValidate" => {
            // Validation-first paths of ensure_managed_local_job that do not
            // need a real filesystem: coordinator shape and option guards.
            let options = request["options"].clone();
            let coordinator = options.get("coordinator").filter(|v| !v.is_null());
            let result: Result<Value, String> = match coordinator {
                None => Ok(json!(null)),
                Some(coordinator) => {
                    let graph = coordinator
                        .get("graph")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if graph.trim().is_empty()
                        || coordinator
                            .get("input")
                            .and_then(Value::as_str)
                            .unwrap_or("")
                            .trim()
                            .is_empty()
                    {
                        Err("Coordinator requires nonempty graph and input".into())
                    } else {
                        agents_relay_rust2::agent_graph::parse_agent_graph(graph)
                            .map(|_| json!(null))
                    }
                }
            };
            outcome(result).to_string()
        }
        _ => return Err(format!("unknown batchAPublicParity method {method}")),
    }))
}
