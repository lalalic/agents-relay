// New differential CLI: exposes verified Node source-module ports to isolated Rust/Node fixture comparisons.
use agents_relay_rust2::{
    audit_tail::read_jsonl_newest_first,
    cli_local_merge_config::configure_local_git_merge,
    cli_shutdown::final_exit_code,
    cli_workflow_action::workflow_operation,
    dependency_validity::validate_dependency_validity,
    final_review_role::is_final_review_agent,
    github_binding_order::order_github_binding_candidates,
    github_branch_projection::authoritative_branch_push_args,
    job_execution_slot::{job_has_active_execution, job_has_conflicting_execution},
    local_job_path::relay_store_directory,
    planned_review_head::bind_planned_review_head,
    planner_agent_roles::validate_planner_agent_roles,
    planner_history_cleanup::parse_planner_history_cleanup,
    planner_task_title::required_planner_task_title,
    projection_failure_dedupe::ProjectionFailureDeduplicator,
    review_revision_merge::preserve_review_revision_history,
    router_rules::{append_agent_model_preference, append_routing_instruction, parse_router_rules},
    task_title::{derive_task_title, json_string_from_utf16},
    terminal_event_recovery::{
        terminal_recovery_eligible, terminal_recovery_prompt, TerminalRecoveryFacts,
    },
};
use serde_json::{json, Value};
use std::io::{self, BufRead};

// Integration fixture adapter: expose Rust Graph parser and runtime for Node-vs-Rust
// differential testing without creating or changing durable Relay jobs.
fn workflow_engine_scenario(request: &Value) -> Result<Value, String> {
    use agents_relay_rust2::workflow::mermaid::{WorkflowAction, WorkflowEngine, WorkflowGuard};
    use std::collections::HashMap;
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
            std::thread::yield_now();
        }
    }
    let source = request["source"].as_str().unwrap_or("");
    let graph = agents_relay_rust2::workflow::mermaid::parse_executable_mermaid(source)?;
    let mut guards = HashMap::new();
    if let Some(bindings) = request["guards"].as_object() {
        for (name, descriptor) in bindings {
            let descriptor = descriptor.clone();
            let is_async = descriptor["async"] == true;
            let decide = move |ctx: &Value| -> Result<bool, String> {
                if let Some(error) = descriptor.get("error").and_then(Value::as_str) {
                    return Err(error.to_string());
                }
                Ok(
                    if let Some(field) = descriptor.get("field").and_then(Value::as_str) {
                        ctx[field].as_bool().unwrap_or(false)
                    } else if descriptor.is_boolean() {
                        descriptor.as_bool().unwrap_or(false)
                    } else {
                        descriptor["result"].as_bool().unwrap_or(false)
                    },
                )
            };
            if is_async {
                guards.insert(
                    name.clone(),
                    WorkflowGuard::Async(Arc::new(move |ctx| {
                        let outcome = decide(ctx);
                        Box::pin(async move { outcome })
                    })),
                );
            } else {
                guards.insert(name.clone(), WorkflowGuard::Sync(Arc::new(decide)));
            }
        }
    }
    let log = Arc::new(Mutex::new(Vec::<String>::new()));
    let mut actions = HashMap::new();
    if let Some(bindings) = request["actions"].as_object() {
        for (name, descriptor) in bindings {
            if descriptor["declarative"] == true {
                actions.insert(name.clone(), WorkflowAction::Declarative);
            } else if descriptor["async"] == true {
                let name = name.clone();
                let log = Arc::clone(&log);
                let descriptor_error = descriptor
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                actions.insert(
                    name.clone(),
                    WorkflowAction::Async(Arc::new(move |_, _| {
                        let log = Arc::clone(&log);
                        let name = name.clone();
                        let error = descriptor_error.as_ref().cloned();
                        Box::pin(async move {
                            log.lock().expect("fixture mutex").push(name);
                            if let Some(error) = error {
                                return Err(error);
                            }
                            Ok(())
                        })
                    })),
                );
            } else {
                let name = name.clone();
                let log = Arc::clone(&log);
                let descriptor_error = descriptor
                    .get("error")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                actions.insert(
                    name.clone(),
                    WorkflowAction::Sync(Arc::new(move |_, _| {
                        log.lock().expect("fixture mutex").push(name.clone());
                        if let Some(error) = &descriptor_error {
                            return Err(error.clone());
                        }
                        Ok(())
                    })),
                );
            }
        }
    }
    let engine = WorkflowEngine::new(graph, guards, actions)?;
    let from = request["from"].as_str().unwrap_or("");
    let to = request["to"].as_str().unwrap_or("");
    let event = request["event"].as_str().unwrap_or("");
    let ctx = &request["context"];
    let result = match request["method"].as_str().unwrap_or("transitionSync") {
        "transitionsFrom" => json!(engine
            .transitions_from(from)?
            .iter()
            .map(|t| t.json())
            .collect::<Vec<_>>()),
        "assertStateTransition" => {
            engine.assert_state_transition(
                from,
                to,
                request["kind"].as_str().unwrap_or("workflow"),
            )?;
            Value::Null
        }
        "enabledSync" => json!(engine
            .enabled_sync(from, event, ctx)?
            .iter()
            .map(|t| t.json())
            .collect::<Vec<_>>()),
        "transitionSync" => json!(engine.transition_sync(from, event, ctx)?),
        "enabled" => json!(drive(engine.enabled(from, event, ctx))?
            .iter()
            .map(|t| t.json())
            .collect::<Vec<_>>()),
        "transition" => json!(drive(engine.transition(from, event, ctx))?),
        other => return Err(format!("Unsupported Graph operation {other}")),
    };
    let trace = log.lock().expect("fixture mutex").clone();
    Ok(json!({"result":result,"trace":trace}))
}

// Adapter-only fixture: drive the actual native Workflow Effect executor with
// disposable in-memory receipts and callbacks, never against a live Job.
fn workflow_effects_scenario(request: &Value) -> Result<Value, String> {
    use agents_relay_rust2::observability::{
        collect_observations, set_observability, RelayObservability,
    };
    use agents_relay_rust2::workflow::effects::{
        EffectCallback, KeyCallback, MemoryWorkflowEffectReceiptStore, OutcomeCallback,
        ReceiptFuture, WorkflowEffectError, WorkflowEffectExecutor, WorkflowEffectHandler,
        WorkflowEffectReceiptStore,
    };
    use std::{
        collections::HashSet,
        future::Future,
        pin::pin,
        sync::{Arc, Mutex},
        task::{Context, Poll, Waker},
    };
    fn drive<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        let mut context = Context::from_waker(Waker::noop());
        loop {
            if let Poll::Ready(result) = future.as_mut().poll(&mut context) {
                return result;
            }
            std::thread::yield_now();
        }
    }
    fn fixture_error(value: &Value) -> WorkflowEffectError {
        if value.is_null() {
            return WorkflowEffectError::new("fixture rejected");
        }
        WorkflowEffectError {
            value: value.clone(),
            is_error: value.is_object(),
        }
    }
    struct FixtureReceipts {
        inner: Arc<MemoryWorkflowEffectReceiptStore>,
        has_fail: HashSet<String>,
        mark_fail: HashSet<String>,
    }
    impl WorkflowEffectReceiptStore for FixtureReceipts {
        fn has<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, bool> {
            Box::pin(async move {
                if self.has_fail.contains(key) {
                    return Err(WorkflowEffectError::new("has receipt failed"));
                }
                self.inner.has(key).await
            })
        }
        fn mark_completed<'a>(&'a self, key: &'a str) -> ReceiptFuture<'a, ()> {
            Box::pin(async move {
                if self.mark_fail.contains(key) {
                    return Err(WorkflowEffectError::new("mark receipt failed"));
                }
                self.inner.mark_completed(key).await
            })
        }
    }
    let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
    let records = Arc::new(Mutex::new(Vec::<Value>::new()));
    set_observability(RelayObservability::new(
        collect_observations(Arc::clone(&records)),
        "debug",
    ));
    let mut handlers = Vec::new();
    for value in request["handlers"].as_array().into_iter().flatten() {
        let name = value["name"].as_str().unwrap_or("").to_string();
        let descriptor = value.clone();
        let call_name = name.clone();
        let call_trace = Arc::clone(&trace);
        let counter = Arc::new(Mutex::new(0u64));
        let callback: EffectCallback = Arc::new(move |context| {
            let mut count = counter.lock().expect("fixture attempts mutex");
            *count += 1;
            let nth = *count;
            let behavior = descriptor["behavior"].as_str().unwrap_or("ok");
            let should_fail = behavior == "fail" || (behavior == "failOnce" && nth == 1);
            let mut error = fixture_error(&descriptor["error"]);
            if descriptor["errorIsError"] == false && !descriptor["error"].is_null() {
                error.is_error = false;
            }
            call_trace
                .lock()
                .expect("effect trace mutex")
                .push(json!({"execute":call_name,"jobId":context["jobId"],"attempt":nth}));
            Box::pin(async move {
                if should_fail {
                    Err(error)
                } else {
                    Ok(())
                }
            })
        });
        let key: Option<KeyCallback> = match value["keyMode"].as_str() {
            Some("fixed") => {
                let result = value["key"].as_str().map(str::to_string);
                Some(Arc::new(move |_| result.clone()))
            }
            Some("job") => Some(Arc::new(|context| {
                context["jobId"]
                    .as_str()
                    .map(|value| format!("job:{value}"))
            })),
            Some("empty") => Some(Arc::new(|_| Some(String::new()))),
            _ => None,
        };
        handlers.push(if let Some(key) = key {
            WorkflowEffectHandler::with_key(&name, callback, key)
        } else {
            WorkflowEffectHandler::new(&name, callback)
        });
    }
    let receipts = Arc::new(MemoryWorkflowEffectReceiptStore::new());
    for item in request["initialReceipts"].as_array().into_iter().flatten() {
        if let Some(key) = item.as_str() {
            receipts.mark_preexisting(key);
        }
    }
    let has_fail = request["hasFailKeys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let mark_fail = request["markFailKeys"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_string)
        .collect::<HashSet<_>>();
    let store = Arc::new(FixtureReceipts {
        inner: Arc::clone(&receipts),
        has_fail,
        mark_fail,
    });
    let executor = WorkflowEffectExecutor::new(handlers, store)?;
    let on_mode = request["onOutcomeFail"].as_str().map(str::to_string);
    let on_once = request["onOutcomeFailOnce"] == true;
    let on_attempts = Arc::new(Mutex::new(0u64));
    let out_trace = Arc::clone(&trace);
    let on_outcome: OutcomeCallback = Arc::new(move |outcome| {
        out_trace
            .lock()
            .expect("outcome trace mutex")
            .push(json!({"onOutcome":outcome["status"],"effect":outcome["effect"]}));
        let fail = on_mode
            .as_ref()
            .is_some_and(|mode| mode == outcome["status"].as_str().unwrap_or(""));
        let mut attempts = on_attempts.lock().expect("outcome attempts mutex");
        if fail {
            *attempts += 1;
        }
        let failure = fail && (!on_once || *attempts == 1);
        Box::pin(async move {
            if failure {
                Err(WorkflowEffectError::new("onOutcome rejected"))
            } else {
                Ok(())
            }
        })
    });
    let mut rounds = Vec::new();
    for turn in request["steps"].as_array().into_iter().flatten() {
        let effects = turn
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect::<Vec<_>>();
        let result = drive(executor.execute(&effects, &request["context"], Some(&on_outcome)));
        match result {
            Ok(value) => rounds.push(json!({"ok":true,"value":value})),
            Err(error) => rounds.push(json!({"ok":false,"error":error.display()})),
        }
    }
    set_observability(RelayObservability::silent());
    let mut records = records.lock().expect("observability capture mutex").clone();
    for record in &mut records {
        record["ts"] = json!("NORMALIZED");
    }
    let trace = trace.lock().expect("effect fixture trace mutex").clone();
    Ok(
        json!({"rounds":rounds,"trace":trace,"records":records,"receipts":receipts.completed_keys()}),
    )
}

fn invoke(request: &Value) -> Result<String, String> {
    let op = request["op"].as_str().ok_or("missing op")?;
    match op {
        "appendTaskComment" => {
            let mut job = request["job"].clone();
            let result = agents_relay_rust2::task_comments::append_task_comment(
                &mut job,
                request["taskId"].as_str().unwrap_or(""),
                request["message"].as_str().unwrap_or(""),
                request.get("options").unwrap_or(&json!("cli")),
            )?;
            Ok(agents_relay_rust2::observability::json_wire(
                &json!({"comment":result,"job":job}),
            ))
        }
        "taskCommentContext" => Ok(
            json!(agents_relay_rust2::task_comments::task_comment_context(
                &request["task"]
            ))
            .to_string(),
        ),
        "preserveTaskComments" => {
            let previous = request["previous"].as_array().cloned().unwrap_or_default();
            let incoming = request["incoming"].as_array().cloned().unwrap_or_default();
            Ok(agents_relay_rust2::observability::json_wire(&json!(
                agents_relay_rust2::task_comments::preserve_task_comments(&previous, &incoming)
            )))
        }
        "projectionHelp" => Ok(json!(agents_relay_rust2::cli_projection::projection_help(
            request["action"].as_str()
        ))
        .to_string()),
        "projectionControlCommand" => {
            let args = request["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok(
                agents_relay_rust2::cli_projection::projection_control_command(
                    request["action"].as_str().unwrap_or(""),
                    &args,
                )?
                .to_string(),
            )
        }
        "runProjectionCommand" => {
            let args = request["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok(
                json!(agents_relay_rust2::cli_projection::run_projection_command(
                    request["action"].as_str().unwrap_or(""),
                    &args
                )?)
                .to_string(),
            )
        }

        "currentJobMetadata" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::relay_job_snapshot_reads::current_job_metadata(&request["job"]),
        )),
        "normalizeRelayJob" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::relay_job_snapshot_reads::normalize_relay_job(
                request["raw"].as_str().unwrap_or(""),
            )?,
        )),
        "relayJobSnapshotScenario" => {
            use rusqlite::{params, Connection};
            let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)")
                .map_err(|error|error.to_string())?;
            for entry in request["records"].as_array().into_iter().flatten() {
                let id = entry["id"].as_str().ok_or("job id required")?;
                let raw = entry["json"].as_str().ok_or("job json required")?;
                db.execute(
                    "INSERT INTO job_snapshot VALUES(?,?,?)",
                    params![id, raw, "2026-11-16T00:00:00Z"],
                )
                .map_err(|error| error.to_string())?;
            }
            let mut results = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                let result = if op["action"] == "load" {
                    agents_relay_rust2::relay_job_snapshot_reads::load_relay_job(
                        &db,
                        op["jobId"].as_str().unwrap_or(""),
                    )
                    .map(|item| item.unwrap_or(Value::Null))
                } else {
                    agents_relay_rust2::relay_job_snapshot_reads::list_relay_jobs(
                        &db,
                        op["jobId"].as_str(),
                    )
                    .map(|items| json!(items))
                };
                results.push(match result {
                    Ok(item) => json!({"ok":true,"value":item}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            Ok(agents_relay_rust2::observability::json_wire(&json!(
                results
            )))
        }
        "noGitHubMode" => {
            let args = request["args"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            let process_args = request["processArgs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect::<Vec<_>>();
            Ok(json!(agents_relay_rust2::no_github::no_github_mode(
                &args,
                &process_args,
                request["envValue"].as_str()
            ))
            .to_string())
        }
        "disabledGitHubMethod" => {
            let client = agents_relay_rust2::no_github::DisabledGitHubClient::new();
            let execute = async {
                match request["method"].as_str().unwrap_or("") {
                    "request" => client.request().await,
                    "graphql" => client.graphql().await,
                    "rateLimitSnapshot" => client.rate_limit_snapshot().await,
                    "currentLogin" => client.current_login().await,
                    _ => Err("Unsupported disabled GitHub method".into()),
                }
            };
            use std::{
                future::Future,
                pin::pin,
                task::{Context, Poll, Waker},
            };
            let mut future = pin!(execute);
            let mut context = Context::from_waker(Waker::noop());
            let result = loop {
                if let Poll::Ready(value) = future.as_mut().poll(&mut context) {
                    break value;
                }
            };
            Ok(json!(match result {
                Ok(()) => json!({"ok":true}),
                Err(error) => json!({"ok":false,"error":error}),
            })
            .to_string())
        }

        "unifiedRelaySchemaScenario" => {
            use rusqlite::Connection;
            let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            // node:sqlite enables FK constraints by default, unlike rusqlite.
            db.execute_batch("PRAGMA foreign_keys=ON")
                .map_err(|error| error.to_string())?;
            let mut outcomes = Vec::new();
            let count = request["migrateCount"].as_u64().unwrap_or(1).min(3);
            for _ in 0..count {
                outcomes.push(
                    match agents_relay_rust2::unified_relay_schema::migrate_unified_relay_schema(
                        &db,
                    ) {
                        Ok(()) => json!({"ok":true}),
                        Err(error) => json!({"ok":false,"error":error}),
                    },
                );
            }
            for sql in request["statements"].as_array().into_iter().flatten() {
                let result = db.execute_batch(sql.as_str().unwrap_or(""));
                outcomes.push(match result {
                    Ok(()) => json!({"ok":true}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                });
            }
            let mut stmt = db
                .prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
                .map_err(|error| error.to_string())?;
            let objects = stmt
                .query_map([], |row| {
                    Ok(
                        json!({"type":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,
                "tbl_name":row.get::<_,String>(2)?,"sql":row.get::<_,Option<String>>(3)?}),
                    )
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let mut query = db
                .prepare("SELECT key,value FROM migration_metadata ORDER BY key")
                .map_err(|error| error.to_string())?;
            let metadata = query
                .query_map([], |row| {
                    Ok(json!({"key":row.get::<_,String>(0)?,"value":row.get::<_,String>(1)?}))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(json!({"outcomes":outcomes,"objects":objects,"metadata":metadata}).to_string())
        }

        "normalizeLegacyTaskLifecycle" => Ok(
            agents_relay_rust2::legacy_blocked_task_migration::normalize_legacy_task_lifecycle(
                &request["task"],
            )
            .to_string(),
        ),
        "normalizeLegacyJobPrNumber" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::job_pr_number_migration::normalize_legacy_job_pr_number(
                &request["job"],
            ),
        )),
        "legacyMigrationsScenario" => {
            use rusqlite::{params, Connection};
            let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL); CREATE TABLE changed_rows(job_id TEXT); CREATE TRIGGER job_updates AFTER UPDATE ON job_snapshot BEGIN INSERT INTO changed_rows VALUES(new.job_id); END;")
                .map_err(|error|error.to_string())?;
            for job in request["jobs"].as_array().into_iter().flatten() {
                let Some(id) = job["id"].as_str() else {
                    continue;
                };
                db.execute(
                    "INSERT INTO job_snapshot VALUES(?,?,?)",
                    params![id, job.to_string(), "ORIGINAL"],
                )
                .map_err(|error| error.to_string())?;
            }
            let migration = request["migration"].as_str().unwrap_or("blocked");
            let status = if migration == "blocked" {
                agents_relay_rust2::legacy_blocked_task_migration::migrate_legacy_blocked_tasks(&db)
            } else {
                agents_relay_rust2::job_pr_number_migration::migrate_legacy_job_pr_numbers(&db)
            };
            let mut query = db
                .prepare("SELECT job_id,json,updated_at FROM job_snapshot ORDER BY job_id")
                .map_err(|error| error.to_string())?;
            let rows=query.query_map([],|row|Ok(json!({"job_id":row.get::<_,String>(0)?,
                "json":agents_relay_rust2::job_pr_number_migration::parse_js_json(&row.get::<_,String>(1)?).unwrap_or(Value::Null),
                "updated_at":row.get::<_,String>(2)?})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            let mut query = db
                .prepare("SELECT job_id FROM changed_rows ORDER BY job_id")
                .map_err(|error| error.to_string())?;
            let changed = query
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(agents_relay_rust2::observability::json_wire(
                &json!({"status":match status{Ok(())=>json!({"ok":true}),Err(error)=>json!({"ok":false,"error":error})},"rows":rows,"changed":changed}),
            ))
        }

        "unifiedJobRegistryScenario" => {
            use rusqlite::{params, Connection};
            let mut db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE source_registry(job_id TEXT PRIMARY KEY,source_file TEXT NOT NULL UNIQUE,repository TEXT NOT NULL,pr_number INTEGER NOT NULL); CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);")
                .map_err(|error|error.to_string())?;
            for job in request["preexisting"].as_array().into_iter().flatten() {
                let id = job["id"].as_str().ok_or("preexisting id required")?;
                db.execute(
                    "INSERT INTO job_snapshot VALUES(?,?,?)",
                    params![id, job.to_string(), "PREEXISTING"],
                )
                .map_err(|error| error.to_string())?;
            }
            let mut results = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                let job = &op["job"];
                let operation = op["action"].as_str().unwrap_or("ensure");
                let result = if operation == "ensure" {
                    agents_relay_rust2::unified_job_registry::ensure_unified_job_registry(
                        &db,
                        job,
                        op["expectedJobId"].as_str().unwrap_or(""),
                    )
                    .map(|_| Value::Null)
                } else {
                    let fail = op["failWrite"] == true;
                    agents_relay_rust2::unified_job_registry::create_unified_job_if_absent(
                        &mut db,
                        job,
                        |tx, now| {
                            if fail {
                                return Err("injected snapshot write failed".into());
                            }
                            tx.execute(
                                "INSERT INTO job_snapshot VALUES(?,?,?)",
                                params![job["id"].as_str(), job.to_string(), now],
                            )
                            .map_err(|error| error.to_string())?;
                            Ok(())
                        },
                    )
                };
                results.push(match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            let mut source=db.prepare("SELECT job_id,source_file,repository,pr_number FROM source_registry ORDER BY job_id")
                .map_err(|error|error.to_string())?;
            let bindings=source.query_map([],|row|Ok(json!({"job_id":row.get::<_,String>(0)?,"source_file":row.get::<_,String>(1)?,"repository":row.get::<_,String>(2)?,"pr_number":row.get::<_,i64>(3)?})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            let mut query = db
                .prepare("SELECT job_id,json FROM job_snapshot ORDER BY job_id")
                .map_err(|error| error.to_string())?;
            let snapshots=query.query_map([],|row|Ok(json!({"job_id":row.get::<_,String>(0)?,"json":serde_json::from_str::<Value>(&row.get::<_,String>(1)?).unwrap_or(Value::Null)})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            Ok(json!({"operations":results,"bindings":bindings,"snapshots":snapshots}).to_string())
        }

        "isGeneratedEntityId" => Ok(json!(
            agents_relay_rust2::job_task_id_sequence::is_generated_entity_id(
                request["id"].as_str().unwrap_or(""),
                request["repository"].as_str().unwrap_or(""),
                request["kind"].as_str().unwrap_or("task")
            )
        )
        .to_string()),
        "jobTaskIdSequenceScenario" => {
            let directory = request["directory"].as_str().ok_or("directory required")?;
            let mut outputs = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                let occupied = op["occupied"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_string)
                    .collect::<std::collections::HashSet<_>>();
                let value = agents_relay_rust2::job_task_id_sequence::allocate_entity_id(
                    std::path::Path::new(directory),
                    op["repository"].as_str().unwrap_or(""),
                    op["kind"].as_str().unwrap_or("task"),
                    op["requestKey"].as_str(),
                    &occupied,
                );
                outputs.push(match value {
                    Ok(id) => json!({"ok":true,"id":id}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            Ok(json!(outputs).to_string())
        }

        "reviewGenerationMatches" => Ok(json!(
            agents_relay_rust2::review_generation_fence::review_generation_matches(
                &request["current"],
                &request["original"],
                &request["task"],
                request["headSha"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "unifiedPullRequestFactsScenario" => {
            use rusqlite::Connection;
            let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch("PRAGMA foreign_keys=ON; CREATE TABLE source_registry(job_id TEXT PRIMARY KEY);                 CREATE TABLE pull_request_facts(scope_job_id TEXT NOT NULL REFERENCES source_registry(job_id),                 id INTEGER NOT NULL CHECK(id=1), state TEXT NOT NULL CHECK(state IN ('OPEN','MERGED','CLOSED')),                 head_ref TEXT,head_sha TEXT,observed_at TEXT NOT NULL,PRIMARY KEY(scope_job_id,id));")
                .map_err(|error|error.to_string())?;
            for job in request["jobs"].as_array().into_iter().flatten() {
                if let Some(job) = job.as_str() {
                    db.execute("INSERT INTO source_registry VALUES(?)", [job])
                        .map_err(|error| error.to_string())?;
                }
            }
            let mut operations = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                let job_id = op["jobId"].as_str().unwrap_or("");
                let result = agents_relay_rust2::unified_pr_facts::save_unified_pull_request_facts(
                    &db,
                    job_id,
                    &op["facts"],
                );
                operations.push(match result {
                    Ok(()) => json!({"ok":true}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            let mut stmt=db.prepare("SELECT scope_job_id,id,state,head_ref,head_sha,observed_at FROM pull_request_facts ORDER BY scope_job_id,id")
                .map_err(|error|error.to_string())?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(
                        json!({"scope_job_id":row.get::<_,String>(0)?,"id":row.get::<_,i64>(1)?,
                "state":row.get::<_,String>(2)?,"head_ref":row.get::<_,Option<String>>(3)?,
                "head_sha":row.get::<_,Option<String>>(4)?,"observed_at":row.get::<_,String>(5)?}),
                    )
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(json!({"operations":operations,"rows":rows}).to_string())
        }

        "eventsBusConfigPath" => Ok(json!(
            agents_relay_rust2::events_bus_runtime::events_bus_config_path(&request["env"])
        )
        .to_string()),
        "resolveEventsBusRuntime" => Ok(
            agents_relay_rust2::events_bus_runtime::resolve_events_bus_runtime(&request["env"])?
                .to_string(),
        ),
        "eventsBusHistoryPage" => Ok(
            agents_relay_rust2::events_bus_runtime::events_bus_history_page(
                request["jobId"].as_str().unwrap_or(""),
                request["taskId"].as_str(),
                &request["limit"],
                &request["options"],
                &request["env"],
            )?
            .to_string(),
        ),
        "eventsBusHistory" => Ok(agents_relay_rust2::events_bus_runtime::events_bus_history(
            request["jobId"].as_str().unwrap_or(""),
            request["taskId"].as_str(),
            &request["limit"],
            &request["env"],
        )?
        .to_string()),

        "executionEventSource" => Ok(json!(
            agents_relay_rust2::execution_event_identity::execution_event_source(
                request["jobId"].as_str().unwrap_or(""),
                request["taskId"].as_str().unwrap_or(""),
                request["executionId"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "eventSourceId" => Ok(json!(
            agents_relay_rust2::execution_event_identity::event_source_id(&request["event"])
        )
        .to_string()),
        "executionIdFromSource" => Ok(json!(
            agents_relay_rust2::execution_event_identity::execution_id_from_source(
                request["sourceId"].as_str(),
                request["jobId"].as_str().unwrap_or(""),
                request["taskId"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "terminalClaimScenario" => {
            use agents_relay_rust2::execution_event_identity::{
                claim_terminal_execution, terminal_execution_claimed,
            };
            let mut results = Vec::new();
            for item in request["claims"].as_array().into_iter().flatten() {
                if let Some(source) = item.as_str() {
                    claim_terminal_execution(source);
                }
            }
            for candidate in request["checks"].as_array().into_iter().flatten() {
                results.push(json!(terminal_execution_claimed(
                    candidate["jobId"].as_str().unwrap_or(""),
                    candidate["taskId"].as_str().unwrap_or(""),
                    candidate["executionId"].as_str().unwrap_or("")
                )));
            }
            Ok(json!(results).to_string())
        }
        "localCommitScenario" => {
            use agents_relay_rust2::local_commit_events::{LocalCommitBus, LocalCommitListener};
            let bus = std::sync::Arc::new(LocalCommitBus::new());
            let trace = std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
            let mut ids = Vec::new();
            for item in request["subscribers"].as_array().into_iter().flatten() {
                let name = item.as_str().unwrap_or("").to_string();
                let output = std::sync::Arc::clone(&trace);
                let listener: LocalCommitListener = std::sync::Arc::new(move |job| {
                    output
                        .lock()
                        .expect("fixture callback log")
                        .push(json!({"subscriber":name,"job":job}));
                });
                ids.push(bus.subscribe(listener));
            }
            for (index, job) in request["jobs"].as_array().into_iter().flatten().enumerate() {
                if let Some(remove) = request["unsubscribeBefore"]
                    .as_object()
                    .and_then(|data| data.get(&index.to_string()))
                    .and_then(Value::as_array)
                {
                    for item in remove {
                        if let Some(id) = item.as_u64().and_then(|n| ids.get(n as usize)) {
                            bus.unsubscribe(*id);
                        }
                    }
                }
                bus.publish(job);
            }
            let logged = trace.lock().expect("fixture callback log").clone();
            Ok(json!(logged).to_string())
        }

        "emptyGitHubRuntimeRateUsage" => Ok(
            agents_relay_rust2::github_runtime_usage::empty_github_runtime_rate_usage().to_string(),
        ),
        "observeRuntimeRateLimit" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::github_runtime_usage::observe_runtime_rate_limit(
                request["channel"].as_str().unwrap_or("rest"),
                &request["response"],
                request["observedAt"].as_str().unwrap_or(""),
            )?,
        )),
        "runtimeRejection" => Ok(agents_relay_rust2::github_runtime_usage::runtime_rejection(
            &request["observation"],
        )?
        .to_string()),
        "parseGitHubCliHeaders" => Ok(
            agents_relay_rust2::github_runtime_usage::parse_github_cli_headers(
                request["output"].as_str().unwrap_or(""),
                request["hadHeaders"] == true,
            )
            .to_string(),
        ),

        "cancelPausedGenerations" => {
            let calls = std::cell::RefCell::new(Vec::<Value>::new());
            agents_relay_rust2::reconciler_pause::cancel_paused_generations(
                &request["job"],
                |task_id, execution_id| {
                    calls
                        .borrow_mut()
                        .push(json!({"kind":"task","taskId":task_id,"executionId":execution_id}))
                },
                |plan_id| {
                    calls
                        .borrow_mut()
                        .push(json!({"kind":"plan","planId":plan_id}))
                },
            )?;
            Ok(json!(calls.into_inner()).to_string())
        }
        "workflowEffectsScenario" => Ok(workflow_effects_scenario(request)?.to_string()),

        "samePlannerChildDefinition" => Ok(json!(
            agents_relay_rust2::planner_child::same_planner_child_definition(
                &request["left"],
                &request["right"]
            )
        )
        .to_string()),
        "errorMessage" => Ok(json!(agents_relay_rust2::observability::error_message(
            &request["error"],
            request["asError"] == true
        ))
        .to_string()),
        "classifyFailure" => Ok(agents_relay_rust2::observability::classify_failure(
            &request["error"],
            request["asError"] == true,
        )
        .to_string()),
        "sanitizeObservationValue" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::observability::sanitize_observation_value(
                &request["value"],
                request["depth"].as_u64().unwrap_or(0) as usize,
            ),
        )),
        "sanitizeObservationData" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::observability::sanitize_observation_data(request.get("data"))
                .unwrap_or(Value::Null),
        )),
        "observabilityEnvironment" => {
            let observer = agents_relay_rust2::observability::RelayObservability::from_environment(
                &request["env"],
            );
            let enabled = ["debug", "info", "warn", "error", "unknown"]
                .iter()
                .map(|name| json!({"level":name,"enabled":observer.is_enabled(name)}))
                .collect::<Vec<_>>();
            Ok(json!({"minimumLevel":observer.minimum_level,"enabled":enabled}).to_string())
        }
        "observabilityScenario" => {
            use agents_relay_rust2::observability::{
                collect_observations, current_observability_correlation,
                with_observability_correlation, RelayObservability,
            };
            let output = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
            let sink = collect_observations(std::sync::Arc::clone(&output));
            let observer =
                RelayObservability::new(sink, request["minimumLevel"].as_str().unwrap_or("info"));
            let time = request["timestamp"]
                .as_str()
                .unwrap_or("2026-11-16T15:00:00.000Z");
            let previous = current_observability_correlation();
            let nested = with_observability_correlation(&request["outer"], || {
                let before = current_observability_correlation();
                for item in request["before"].as_array().into_iter().flatten() {
                    observer.record_at(item, time);
                }
                let inside = with_observability_correlation(&request["inner"], || {
                    let inside = current_observability_correlation();
                    for item in request["during"].as_array().into_iter().flatten() {
                        observer.record_at(item, time);
                    }
                    inside
                });
                for item in request["after"].as_array().into_iter().flatten() {
                    observer.record_at(item, time);
                }
                json!({"before":before,"inside":inside,"after":current_observability_correlation()})
            });
            let values = output.lock().expect("fixture sink mutex").clone();
            Ok(agents_relay_rust2::observability::json_wire(
                &json!({"records":values,"nested":nested,"previous":previous,"final":current_observability_correlation()}),
            ))
        }

        "migrateTaskIds" => Ok(agents_relay_rust2::task_id_migration::migrate_task_ids(
            request["databasePath"]
                .as_str()
                .ok_or("databasePath required")?,
            request["backupPath"]
                .as_str()
                .ok_or("backupPath required")?,
        )?
        .to_string()),

        "agentSourceLayers" => Ok(
            agents_relay_rust2::agent_content_resolver::agent_source_layers(
                request["projectPath"].as_str().unwrap_or(""),
                &request["options"],
            )
            .to_string(),
        ),
        "resolveAgentMarkdown" => Ok(
            agents_relay_rust2::agent_content_resolver::resolve_agent_markdown(
                request["name"].as_str().unwrap_or(""),
                request["builtinsRoot"].as_str().unwrap_or(""),
                request["contextRoot"].as_str().unwrap_or(""),
                request["sharedRoot"].as_str(),
                request.get("layers"),
            )?
            .to_string(),
        ),

        "buildAgentPrompt" => Ok(
            agents_relay_rust2::agent_prompt_builder::build_agent_prompt(&request["input"])?
                .to_string(),
        ),
        "renderAgentPrompt" => Ok(json!(
            agents_relay_rust2::agent_prompt_builder::render_agent_prompt(
                &request["bundle"],
                request["adapter"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "isPromptReferenceAccessible" => Ok(json!(
            agents_relay_rust2::agent_prompt_builder::is_prompt_reference_accessible(
                std::path::Path::new(request["path"].as_str().unwrap_or(""))
            )
        )
        .to_string()),
        "promptFileReference" => Ok(
            agents_relay_rust2::agent_prompt_builder::prompt_file_reference(
                request["path"].as_str().unwrap_or(""),
                request["role"].as_str().unwrap_or("context"),
            )?
            .to_string(),
        ),
        "snapshotAgentInstructions" => Ok(
            agents_relay_rust2::agent_prompt_builder::snapshot_agent_instructions(
                request["content"].as_str().unwrap_or(""),
                request["directory"].as_str().unwrap_or(""),
            )?
            .to_string(),
        ),
        "buildReferenceFirstPrompt" => Ok(
            agents_relay_rust2::agent_prompt_builder::build_reference_first_prompt(
                &request["input"],
                request["envDirectory"].as_str(),
            )?
            .to_string(),
        ),
        "buildRelayWorkPrompt" => Ok(json!(
            agents_relay_rust2::agent_prompt_builder::build_relay_work_prompt(
                &request["input"],
                request["envDirectory"].as_str()
            )?
        )
        .to_string()),

        "jobJelDiagram" => Ok(
            agents_relay_rust2::dashboard_jel::job_jel_diagram_json_wire_at(
                &request["job"],
                request["nowMs"].as_i64().unwrap_or(0),
            ),
        ),
        "dashboardStyles" => {
            Ok(json!(agents_relay_rust2::dashboard_style::dashboard_styles).to_string())
        }
        "observeProcess" => Ok(agents_relay_rust2::process_identity::observe_process(
            request["pid"].as_i64().unwrap_or(0),
        )
        .unwrap_or(Value::Null)
        .to_string()),
        "captureProcessRecord" => Ok(
            agents_relay_rust2::process_identity::capture_process_record(
                request["jobId"].as_str().unwrap_or(""),
                request["taskId"].as_str().unwrap_or(""),
                request["executionId"].as_str().unwrap_or(""),
                request["leaseOwner"].as_str().unwrap_or(""),
                request["pid"].as_i64().unwrap_or(0),
            )
            .unwrap_or(Value::Null)
            .to_string(),
        ),
        "probeProcessRecord" => Ok(json!(
            agents_relay_rust2::process_identity::probe_process_record(&request["record"])
        )
        .to_string()),
        "activeRelayLeaseOwner" => Ok(json!(
            agents_relay_rust2::process_identity::active_relay_lease_owner(
                request["owner"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "stopOrphanedProcessGroup" => Ok(json!(
            agents_relay_rust2::process_identity::stop_orphaned_process_group(
                &request["record"],
                std::time::Duration::from_millis(request["graceMs"].as_u64().unwrap_or(750))
            )
        )
        .to_string()),
        "withLocalMergeLock" => {
            let dir =
                std::path::Path::new(request["commonDir"].as_str().ok_or("commonDir required")?);
            let target = request["targetRef"].as_str().ok_or("targetRef required")?;
            let timeout =
                std::time::Duration::from_millis(request["timeoutMs"].as_u64().unwrap_or(15000));
            let result = agents_relay_rust2::local_merge_lock::with_local_merge_lock(
                dir,
                target,
                || {
                    let path = agents_relay_rust2::local_merge_lock::lock_directory(dir, target);
                    let owner =
                        std::fs::read(path.join("owner.json")).map_err(|err| err.to_string())?;
                    let owner =
                        serde_json::from_slice::<Value>(&owner).map_err(|err| err.to_string())?;
                    let evidence = json!({"ownerValid":owner["pid"].as_u64().is_some(),
                    "ownerTarget":owner["targetRef"],"locked":path.is_dir(),"ownerHostValid":owner["host"].as_str().is_some()});
                    if let Some(delay) = request["holdMs"].as_u64() {
                        std::thread::sleep(std::time::Duration::from_millis(delay));
                    }
                    if request["mutateOwner"] == true {
                        std::fs::write(path.join("owner.json"), "{\"pid\":1}")
                            .map_err(|err| err.to_string())?;
                    }
                    if let Some(message) = request["failure"].as_str() {
                        return Err(message.to_string());
                    }
                    Ok(evidence)
                },
                timeout,
            );
            Ok(result?.to_string())
        }
        "routingPolicyPath" => Ok(json!(agents_relay_rust2::routing_policy::policy_path(
            request["explicit"].as_str(),
            request["env"].as_str(),
            std::path::Path::new(request["cwd"].as_str().unwrap_or("."))
        ))
        .to_string()),
        "executionRouterRulesPath" => Ok(json!(
            agents_relay_rust2::routing_policy::execution_router_rules_path(
                request["explicit"].as_str(),
                request["env"].as_str(),
                std::path::Path::new(request["home"].as_str().unwrap_or("."))
            )
        )
        .to_string()),
        "safeRoutingPolicy" => {
            Ok(agents_relay_rust2::routing_policy::safe_policy(&request["value"]).to_string())
        }
        "loadRoutingPolicy" => Ok(agents_relay_rust2::routing_policy::load_routing_policy(
            request["path"].as_str().unwrap_or(""),
            request["rulesPath"].as_str().unwrap_or(""),
        )
        .to_string()),
        "loadExecutionRouterRules" => Ok(
            agents_relay_rust2::routing_policy::load_execution_router_rules(
                request["path"].as_str().unwrap_or(""),
            )
            .to_string(),
        ),
        "saveExecutionRouterRules" => Ok(
            agents_relay_rust2::routing_policy::save_execution_router_rules(
                request["text"].as_str().unwrap_or(""),
                request["path"].as_str().unwrap_or(""),
            )?
            .to_string(),
        ),
        "policyAllows" => Ok(json!(agents_relay_rust2::routing_policy::policy_allows(
            &request["candidate"],
            &request["policy"]
        ))
        .to_string()),
        "policyRank" => Ok(json!(agents_relay_rust2::routing_policy::policy_rank(
            &request["candidate"],
            request["taskKind"].as_str(),
            &request["policy"]
        ))
        .to_string()),
        "workflowEngineScenario" => Ok(workflow_engine_scenario(request)?.to_string()),
        "parseExecutableMermaid" => Ok(
            agents_relay_rust2::workflow::mermaid::parse_executable_mermaid(
                request["source"].as_str().unwrap_or(""),
            )?
            .json()
            .to_string(),
        ),
        "parseRouterRules" => {
            Ok(parse_router_rules(request["text"].as_str().unwrap_or("")).to_string())
        }
        "appendRoutingInstruction" => Ok(json!(append_routing_instruction(
            request["question"].as_str().unwrap_or(""),
            request["instruction"].as_str().unwrap_or("")
        ))
        .to_string()),
        "appendAgentModelPreference" => Ok(json!(append_agent_model_preference(
            request["question"].as_str().unwrap_or(""),
            request.get("preference")
        ))
        .to_string()),
        "workflowEffectPolicies" => {
            Ok(agents_relay_rust2::workflow::contracts::workflow_effect_policies().to_string())
        }
        "workflowContractsInventories" => Ok(json!({
            "events":agents_relay_rust2::workflow::contracts::WORKFLOW_EVENT_NAMES,
            "facts":agents_relay_rust2::workflow::contracts::WORKFLOW_FACT_NAMES,
            "mutations":agents_relay_rust2::workflow::contracts::WORKFLOW_MUTATION_NAMES,
            "effects":agents_relay_rust2::workflow::contracts::WORKFLOW_EFFECT_NAMES,
        })
        .to_string()),
        "workflowEffectFailureEvent" => Ok(json!(
            agents_relay_rust2::workflow::contracts::workflow_effect_failure_event(
                request["effect"].as_str().unwrap_or("")
            )?
        )
        .to_string()),
        "classifyWorkflowActions" => Ok(
            agents_relay_rust2::workflow::contracts::classify_workflow_actions(
                &request["actions"]
                    .as_array()
                    .ok_or("actions must be an array")?
                    .iter()
                    .map(|action| action.as_str().unwrap_or("").to_owned())
                    .collect::<Vec<_>>(),
            )?
            .to_string(),
        ),
        "emptyWorkflowDecision" => Ok(
            agents_relay_rust2::workflow::contracts::empty_workflow_decision(
                request["reason"].as_str().unwrap_or(""),
            )
            .to_string(),
        ),
        "relayStoreDirectory" => Ok(json!(relay_store_directory(
            request["env"].as_str(),
            request["home"].as_str()
        ))
        .to_string()),
        "workflowOperation" => {
            let args = request["args"]
                .as_array()
                .ok_or("args must be an array")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_owned())
                .collect::<Vec<_>>();
            Ok(json!(workflow_operation(&args)?).to_string())
        }
        "shutdownExitCode" => Ok(json!(final_exit_code(
            request["mainError"].as_bool().unwrap_or(false),
            request["processExitCode"].as_i64().map(|v| v as i32)
        ))
        .to_string()),
        "auditTail" => Ok(json!(read_jsonl_newest_first(
            request["path"].as_str().ok_or("path required")?
        )
        .map_err(|e| e.to_string())?)
        .to_string()),
        "isFinalReviewAgent" => {
            Ok(json!(is_final_review_agent(request["name"].as_str())).to_string())
        }
        "validatePlannerAgentRoles" => {
            let specs = request["specs"]
                .as_array()
                .ok_or("specs must be an array")?;
            validate_planner_agent_roles(specs)?;
            Ok(Value::Null.to_string())
        }
        "jobHasActiveExecution" => Ok(json!(job_has_active_execution(
            &request["job"],
            request["except"]["taskId"].as_str(),
            request["except"]["planId"].as_str(),
        ))
        .to_string()),
        "jobHasConflictingExecution" => Ok(json!(job_has_conflicting_execution(
            &request["job"],
            &request["candidate"],
        ))
        .to_string()),
        "deriveTaskTitle" => Ok(json_string_from_utf16(&derive_task_title(
            request["input"].as_str().unwrap_or(""),
            request["fallback"].as_str().unwrap_or("Task"),
        ))),
        "requiredPlannerTaskTitle" => Ok(json!(required_planner_task_title(
            &request["value"],
            request["index"].as_i64().unwrap_or(0)
        )?)
        .to_string()),
        "validateDependencyValidity" => {
            let deps = request["dependencies"]
                .as_array()
                .ok_or("dependencies must be an array")?
                .iter()
                .map(|x| x.as_str().unwrap_or("").to_owned())
                .collect::<Vec<_>>();
            match validate_dependency_validity(
                &deps,
                &request["value"],
                request["field"].as_str().unwrap_or("dependencyValidity"),
            )? {
                Some(result) => Ok(Value::Object(result).to_string()),
                None => Ok(Value::Null.to_string()),
            }
        }
        "terminalRecoveryEligible" => {
            let facts = &request["facts"];
            Ok(json!(terminal_recovery_eligible(&TerminalRecoveryFacts {
                has_session: facts["hasSession"].as_bool().unwrap_or(false),
                has_thread: facts["hasThread"].as_bool().unwrap_or(false),
                terminal_observed: facts["terminalObserved"].as_bool().unwrap_or(false),
                recovery_attempts: facts["recoveryAttempts"].as_f64().unwrap_or(f64::NAN),
                outcome_uncertain: facts["outcomeUncertain"].as_bool().unwrap_or(false),
                cancelled: facts["cancelled"].as_bool().unwrap_or(false),
            }))
            .to_string())
        }
        "terminalRecoveryPrompt" => Ok(json!(terminal_recovery_prompt(
            request["executionId"].as_str().unwrap_or("")
        ))
        .to_string()),
        "authoritativeBranchPushArgs" => Ok(json!(authoritative_branch_push_args(
            request["sourceRef"].as_str().unwrap_or(""),
            request["branch"].as_str().unwrap_or(""),
            request["remoteHeadSha"].as_str(),
            request["remoteTreeMatchesBase"].as_bool().unwrap_or(false),
        ))
        .to_string()),
        "configureLocalGitMerge" => {
            let mut job = request["job"].clone();
            configure_local_git_merge(
                &mut job,
                request["source"].as_str().unwrap_or(""),
                request["target"].as_str().unwrap_or(""),
                request["localOnly"].as_bool().unwrap_or(false),
            )?;
            Ok(job.to_string())
        }
        "preserveReviewRevisionHistory" => {
            let mut merged = request["merged"].clone();
            preserve_review_revision_history(&request["local"], &mut merged);
            Ok(merged.to_string())
        }
        "orderGitHubBindingCandidates" => Ok(json!(order_github_binding_candidates(
            request["items"]
                .as_array()
                .ok_or("items must be an array")?,
        ))
        .to_string()),
        "parsePlannerHistoryCleanup" => {
            let result = match request.get("value") {
                Some(value) => parse_planner_history_cleanup(value)?,
                None => None,
            };
            Ok(json!(result).to_string())
        }
        "projectionFailureShouldReport" => {
            let report = PROJECTION_FAILURE_DEDUPLICATOR.with(|dedupe| {
                dedupe.borrow_mut().should_report(
                    request["jobId"].as_str().unwrap_or(""),
                    request["updatedAt"].as_str().unwrap_or(""),
                    request["reason"].as_str().unwrap_or(""),
                    request["classification"].as_str().unwrap_or(""),
                )
            });
            Ok(json!(report).to_string())
        }
        "resetProjectionFailureDeduplicator" => {
            PROJECTION_FAILURE_DEDUPLICATOR.with(|dedupe| dedupe.borrow_mut().reset());
            Ok(Value::Null.to_string())
        }
        "bindPlannedReviewHead" => {
            let mut task = request["task"].clone();
            bind_planned_review_head(&mut task, request["localHeadSha"].as_str())?;
            Ok(json!({"task": task, "saveCalls": 1}).to_string())
        }
        "normalizeReviewEvidence" => Ok(
            agents_relay_rust2::review_evidence::normalize_review_evidence(
                &request["event"],
                &request["task"],
            )
            .to_string(),
        ),
        "classifyWorkerRejection" => Ok(json!(
            agents_relay_rust2::worker_rejection::classify_worker_rejection(
                request["message"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "classifyChatGptFailure" => Ok(
            agents_relay_rust2::worker_rejection::classify_chatgpt_failure(
                &request["error"],
                request["phase"].as_str().unwrap_or("delivery"),
            )
            .to_string(),
        ),
        "parseJobTag" => Ok(agents_relay_rust2::task_tag::parse_job_tag_json(
            request["raw"].as_str().unwrap_or(""),
        )?
        .to_string()),
        "acceptedReportedTag" => Ok(agents_relay_rust2::task_tag::accepted_reported_tag(
            &request["job"],
            &request["data"],
        )
        .to_string()),
        "eventDataWithoutTag" => {
            Ok(agents_relay_rust2::task_tag::event_data_without_tag(&request["data"]).to_string())
        }
        "taskTagWorkerPrompt" => Ok(json!(agents_relay_rust2::task_tag::task_tag_worker_prompt(
            &request["job"]
        ))
        .to_string()),
        "normalizeReviewerTerminalEvent" => Ok(
            agents_relay_rust2::review_terminal_normalization::normalize_reviewer_terminal_event(
                &request["event"],
            )
            .to_string(),
        ),
        "plannerTaskContext" => Ok(
            agents_relay_rust2::planner_task_context::planner_task_context_json_wire(
                &request["task"],
            ),
        ),
        "conditionCheck" => Ok(json!(agents_relay_rust2::workflow::conditions::check(
            request["specs"]
                .as_array()
                .ok_or("specs must be an array")?,
            request["id"].as_str().unwrap_or(""),
            &request["facts"]
        )?)
        .to_string()),
        "conditionDiscover" => Ok(json!(agents_relay_rust2::workflow::conditions::discover(
            request["specs"]
                .as_array()
                .ok_or("specs must be an array")?
        ))
        .to_string()),
        "conditionValidate" => {
            agents_relay_rust2::workflow::conditions::validate_specs(
                request["specs"]
                    .as_array()
                    .ok_or("specs must be an array")?,
            )?;
            Ok("null".into())
        }
        "conditionSafeRetry" => Ok(json!(agents_relay_rust2::workflow::conditions::safe_retry(
            request["outcome"].as_str().unwrap_or("")
        ))
        .to_string()),
        "conditionVerify" => Ok(agents_relay_rust2::workflow::conditions::verify(
            request["specs"]
                .as_array()
                .ok_or("specs must be an array")?,
            request["actionId"].as_str().unwrap_or(""),
            request["conditionId"].as_str().unwrap_or(""),
            &request["facts"],
        )?
        .to_string()),
        "conditionGuard" => Ok(json!(
            agents_relay_rust2::workflow::conditions::check(
                request["specs"]
                    .as_array()
                    .ok_or("specs must be an array")?,
                request["id"].as_str().unwrap_or(""),
                &request["facts"],
            )? == "Verified"
        )
        .to_string()),
        "validateArtifact" => {
            let r = agents_relay_rust2::cli_artifact::validate_artifact(
                request["artifactPath"]
                    .as_str()
                    .ok_or("artifactPath required")?,
                request["schemaPath"]
                    .as_str()
                    .ok_or("schemaPath required")?,
            )?;
            Ok(agents_relay_rust2::cli_artifact::result_json(&r).to_string())
        }
        "inspectWorkflowSymbol" => Ok(
            agents_relay_rust2::dashboard_workflow_inspection::inspect_workflow_symbol(
                std::path::Path::new(request["root"].as_str().ok_or("root required")?),
                request["graph"].as_str().unwrap_or(""),
                request["kind"].as_str().unwrap_or(""),
                request["name"].as_str().unwrap_or(""),
            )
            .unwrap_or(Value::Null)
            .to_string(),
        ),
        "troubleshooterQaHandle" => {
            let body = if let Some(data) = request["bodyBytes"].as_array() {
                data.iter()
                    .filter_map(Value::as_u64)
                    .map(|byte| byte as u8)
                    .collect::<Vec<_>>()
            } else {
                request["body"].as_str().unwrap_or("").as_bytes().to_vec()
            };
            let response = agents_relay_rust2::troubleshooter_qa_api::handle(
                std::path::Path::new(request["path"].as_str().ok_or("path required")?),
                agents_relay_rust2::troubleshooter_qa_api::Request {
                    method: request["method"].as_str().unwrap_or("GET").into(),
                    content_type: request["contentType"].as_str().map(str::to_string),
                    body,
                },
            );
            let headers = response
                .headers
                .into_iter()
                .collect::<std::collections::BTreeMap<_, _>>();
            Ok(json!({"status":response.status,"headers":headers,"body":String::from_utf8_lossy(&response.body)}).to_string())
        }
        "webHelmRequest" => {
            let req = agents_relay_rust2::webhelm_daemon_client::DaemonRequest {
                op: request["payload"]["op"].as_str().unwrap_or("").into(),
                fields: request["payload"].as_object().cloned().unwrap_or_default(),
            };
            let cancelled = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(
                request["aborted"] == true,
            ));
            let abort_timer = request["abortAfterMs"].as_u64().map(|delay| {
                let flag = std::sync::Arc::clone(&cancelled);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(delay));
                    flag.store(true, std::sync::atomic::Ordering::Release);
                })
            });
            let outcome = agents_relay_rust2::webhelm_daemon_client::request_with_cancel(
                request["socket"].as_str().ok_or("socket required")?,
                &req,
                std::time::Duration::from_millis(request["timeoutMs"].as_u64().unwrap_or(45000)),
                if request.get("aborted").is_some() || abort_timer.is_some() {
                    Some(&cancelled)
                } else {
                    None
                },
            );
            if let Some(timer) = abort_timer {
                let _ = timer.join();
            }
            Ok(outcome?.to_string())
        }
        "discoverAgents" => Ok(json!(agents_relay_rust2::registry::discover_agents(
            request["agents"]
                .as_array()
                .ok_or("agents must be an array")?,
            &request["query"]
        ))
        .to_string()),
        "reviewRevisionLimits" => Ok(
            agents_relay_rust2::review_revision_policy::review_revision_limits(&request["env"])?
                .to_string(),
        ),
        "reviewFindingFingerprint" => Ok(json!(
            agents_relay_rust2::review_revision_policy::review_finding_fingerprint(
                request["findings"]
                    .as_array()
                    .ok_or("findings must be an array")?
            )
        )
        .to_string()),
        "reviewRoundFindingFingerprint" => Ok(json!(
            agents_relay_rust2::review_revision_policy::review_round_finding_fingerprint(
                &request["job"],
                &request["round"]
            )
        )
        .to_string()),
        "repeatedFindingRounds" => Ok(json!(
            agents_relay_rust2::review_revision_policy::repeated_finding_rounds(
                &request["job"],
                &request["currentRound"]
            )
        )
        .to_string()),
        "validateDAGStageGate" => {
            let response = &request["response"];
            agents_relay_rust2::dag_stage_contract::validate_dag_stage_gate(
                std::path::Path::new(
                    request["projectPath"]
                        .as_str()
                        .ok_or("projectPath required")?,
                ),
                request["agent"].as_str().unwrap_or(""),
                std::path::Path::new(request["runPath"].as_str().ok_or("runPath required")?),
                request["interpreter"].as_str().unwrap_or("node"),
                |args, cwd| {
                    if let Some(expected) = request.get("expectedInvocation") {
                        let expected_args = expected["args"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default()
                            .into_iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .collect::<Vec<_>>();
                        if args != expected_args
                            || cwd.to_string_lossy() != expected["cwd"].as_str().unwrap_or("")
                        {
                            return Err("stage validator invocation mismatch".into());
                        }
                    }
                    Ok(agents_relay_rust2::dag_stage_contract::StageExecution {
                        stdout: response["stdout"].as_str().unwrap_or("").into(),
                        stderr: response["stderr"].as_str().unwrap_or("").into(),
                        code: response["code"].as_i64().unwrap_or(0) as i32,
                    })
                },
            )?;
            Ok("null".into())
        }
        _ => Err(format!("unknown operation: {op}")),
    }
}

thread_local! {
    static PROJECTION_FAILURE_DEDUPLICATOR: std::cell::RefCell<ProjectionFailureDeduplicator> =
        std::cell::RefCell::new(ProjectionFailureDeduplicator::default());
}

fn main() {
    for line in io::stdin().lock().lines() {
        let output = match line {
            Ok(line) => match serde_json::from_str::<Value>(&line) {
                Ok(request) => match invoke(&request) {
                    Ok(raw_json) => format!(r#"{{"ok":true,"value":{raw_json}}}"#),
                    Err(message) => json!({"ok":false,"error":message}).to_string(),
                },
                Err(error) => json!({"ok":false,"error":error.to_string()}).to_string(),
            },
            Err(error) => json!({"ok":false,"error":error.to_string()}).to_string(),
        };
        println!("{output}");
    }
}
