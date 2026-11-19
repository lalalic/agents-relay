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
#[path = "relay-rust2-parity/closure.rs"]
mod closure;
#[path = "relay-rust2-parity/pool_public.rs"]
mod pool_public;
#[path = "relay-rust2-parity/cli_runtime_public.rs"]
mod cli_runtime_public;
#[path = "relay-rust2-parity/cli_service_public.rs"]
mod cli_service_public;
#[path = "relay-rust2-parity/reconciler_recovery_public.rs"]
mod reconciler_recovery_public;
#[path = "relay-rust2-parity/reconcile_public.rs"]
mod reconcile_public;
#[path = "relay-rust2-parity/reconciler_git_head_public.rs"]
mod reconciler_git_head_public;
#[path = "relay-rust2-parity/runtime_base_public.rs"]
mod runtime_base_public;
#[path = "relay-rust2-parity/review_base_public.rs"]
mod review_base_public;
#[path = "relay-rust2-parity/planner_finish_public.rs"]
mod planner_finish_public;
#[path = "relay-rust2-parity/planner_launch_public.rs"]
mod planner_launch_public;
#[path = "relay-rust2-parity/control_factory.rs"]
mod control_factory;
#[path = "relay-rust2-parity/dashboard_factory.rs"]
mod dashboard_factory;
#[path = "relay-rust2-parity/worker_failure_parity.rs"]
mod worker_failure_parity;
#[path = "relay-rust2-parity/additional_40.rs"]
mod additional_40;
#[path = "relay-rust2-parity/workflow_effect_failures_public.rs"]
mod workflow_effect_failures_public;
#[path = "relay-rust2-parity/reconciler_context_public.rs"]
mod reconciler_context_public;
#[path = "relay-rust2-parity/script_task_adapter_public.rs"]
mod script_task_adapter_public;
#[path = "relay-rust2-parity/dependency_revision_execution_public.rs"]
mod dependency_revision_execution_public;
#[path = "relay-rust2-parity/browser_worker_routing_public.rs"]
mod browser_worker_routing_public;
#[path = "relay-rust2-parity/feedback_public.rs"]
mod feedback_public;
#[path = "relay-rust2-parity/events_public.rs"]
mod events_public;
#[path = "relay-rust2-parity/single_job_task_control_public.rs"]
mod single_job_task_control_public;
#[path = "relay-rust2-parity/interactive_resume_public.rs"]
mod interactive_resume_public;
#[path = "relay-rust2-parity/escalation_notifier_public.rs"]
mod escalation_notifier_public;
#[path = "relay-rust2-parity/chatgpt_platform_fallback_public.rs"]
mod chatgpt_platform_fallback_public;
#[path = "relay-rust2-parity/types_public.rs"]
mod types_public;
#[path = "relay-rust2-parity/execution_context_public.rs"]
mod execution_context_public;
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
    if let Some(output)=execution_context_public::invoke(request){return output;}
    if let Some(output)=dependency_revision_execution_public::invoke(request){return output;}
    if let Some(output)=browser_worker_routing_public::invoke(request){return output;}
    if let Some(output)=feedback_public::invoke(request){return output;}
    if let Some(output)=events_public::invoke(request){return output;}
    if let Some(output)=single_job_task_control_public::invoke(request){return output;}
    if let Some(output)=interactive_resume_public::invoke(request){return output;}
    if let Some(output)=escalation_notifier_public::invoke(request){return output;}
    if let Some(output)=chatgpt_platform_fallback_public::invoke(request){return output;}
    if let Some(output)=types_public::invoke(request){return output;}
    if let Some(output)=script_task_adapter_public::invoke(request){return output;}
    if let Some(output)=reconciler_context_public::invoke(request){return output;}
    if let Some(output)=workflow_effect_failures_public::invoke(request){return output;}
    if let Some(output)=worker_failure_parity::invoke(request)?{return Ok(output);}
    if let Some(output)=additional_40::invoke(request){return output;}
    if let Some(output)=dashboard_factory::invoke(request)?{return Ok(output);}
    if let Some(output)=closure::invoke(request)?{return Ok(output);}
    let op = request["op"].as_str().ok_or("missing op")?;
    match op {
        "certPlannerInput" => {
            Ok(agents_relay_rust2::planner::planner_input(&request["context"]))
        },
        "certExecutionTracker" => {
            use agents_relay_rust2::execution_process_tracker::{
                monitor_execution_process,reclaim_stale_execution_process,
            };
            let method=request["method"].as_str().ok_or("method required")?;
            let result=if method=="monitor"{
                let mut saved=Vec::<Value>::new();
                let pid=request["pid"].as_i64();
                {
                let future=monitor_execution_process(
                    request["jobId"].as_str().unwrap_or("17"),
                    request["taskId"].as_str().unwrap_or("2"),
                    request["executionId"].as_str().unwrap_or("ex-1"),
                    request["owner"].as_str().unwrap_or("fixture"),
                    pid,|record|{saved.push(record);std::future::ready(Ok(()))});
                let mut future=std::pin::pin!(future);
                let _result=loop{
                    let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
                    if let std::task::Poll::Ready(done)=std::future::Future::poll(
                        future.as_mut(),&mut ctx){break done?;}
                    std::thread::yield_now();
                };
                }
                json!({"saved":saved})
            }else if method=="reclaim"{
                let record=request.get("record").cloned().filter(|v|!v.is_null());
                let mut calls=0;
                let reclaimed={
                let future=reclaim_stale_execution_process(
                    &request["task"],
                    request["currentOwner"].as_str(),
                    |_,_,_|{calls+=1;std::future::ready(Ok(record))});
                let mut future=std::pin::pin!(future);
                let reclaimed=loop{
                    let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
                    if let std::task::Poll::Ready(done)=std::future::Future::poll(
                        future.as_mut(),&mut ctx){break done?;}
                    std::thread::yield_now();
                };
                reclaimed
                };
                json!({"reclaim":reclaimed,"loadCalls":calls})
            }else{return Err("Unknown Execution Tracker method".into());};
            Ok(result.to_string())
        },
        "certForceRestate" => {
            let guidance=request["guidance"].as_str().map(str::to_owned);
            let job_id=request["jobId"].as_str().ok_or("jobId required")?.to_owned();
            let timeout=request["timeoutMs"].as_u64().unwrap_or(0);
            let marker=request["marker"].as_str().unwrap_or("").to_owned();
            let fail=request["fail"].as_str().map(str::to_owned);
            let future=agents_relay_rust2::force_restate::execute_force_restate(
                marker,&job_id,guidance.as_deref(),timeout,(),
                |store,id,guidance,timeout,_,force| {
                    let id=id.to_owned();let guidance=guidance.map(str::to_owned);
                    async move {
                        if let Some(error)=fail{return Err(error);}
                        Ok(json!({"store":store,"jobId":id,"guidance":guidance,
                            "timeoutMs":timeout,"forceRestate":force,
                            "launcherInvoked":true}))
                    }
                },
            );
            let mut future=std::pin::pin!(future);
            let output=loop {
                let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
                if let std::task::Poll::Ready(value)=std::future::Future::poll(
                    future.as_mut(),&mut ctx){break value?;}
                std::thread::yield_now();
            };
            Ok(output.to_string())
        },
        "certRelaydMain" => {
            let argv=request["argv"].as_array().ok_or("argv array required")?
                .iter().map(|v|v.as_str().ok_or("argv item must be string")
                    .map(str::to_owned)).collect::<Result<Vec<_>,_>>()?;
            let error=request["error"].as_str().map(str::to_owned);
            let seen=std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
            let captured=std::sync::Arc::clone(&seen);
            let fut=agents_relay_rust2::relayd_main::run_relayd_main(argv,move|args|{
                *captured.lock().unwrap()=args;
                async move{if let Some(err)=error{Err(err)}else{Ok(())}}
            });
            let mut fut=std::pin::pin!(fut);
            let exit=loop{
                let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
                match std::future::Future::poll(fut.as_mut(),&mut ctx){
                    std::task::Poll::Ready(exit)=>break exit,
                    std::task::Poll::Pending=>std::thread::yield_now(),
                }
            };
            Ok(json!({"exitCode":exit,"forwardedArgs":*seen.lock().unwrap()}).to_string())
        },
        "certJobPauseResume" => {
            let graph=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).parent()
                .ok_or("manifest parent missing")?.join("workflow");
            let snapshot=&request["job"];
            let outcome=match request["method"].as_str().unwrap_or("") {
                "pause"=>agents_relay_rust2::job_pause::pause_job(snapshot,|task,event|{
                    agents_relay_rust2::task_transitions::try_transition_task_event(
                        &graph,task,event,&json!({}),"2026-11-19T00:00:00.000Z")
                        .is_ok_and(|decision|decision["accepted"]==true)
                }),
                "resume"=>agents_relay_rust2::job_pause::resume_job(snapshot),
                other=>Err(format!("unknown pause/resume action: {other}")),
            }?;
            Ok(outcome.to_string())
        },
        "certLocalJobRegistry" => {
            use agents_relay_rust2::local_job_registry::{
                find_job_id_snapshot, create_job_id_registry_resolver,
            };
            let directory=std::path::Path::new(request["directory"].as_str()
                .ok_or("directory required")?);
            let id=request["jobId"].as_str().ok_or("jobId required")?;
            let selected=find_job_id_snapshot(directory,id)?;
            let selected_json=selected.as_ref().map(|snapshot|
                json!({"job":snapshot.job,"path":snapshot.snapshot.path}));
            let mut resolver=create_job_id_registry_resolver(directory,true);
            let (resolved,first_ptr)=match resolver.resolve(id)?{
                Some(first)=>(
                    Some(json!({"job":first.job,"path":first.relay().path,
                        "scope":first.relay().scope_job_id})),
                    Some(first as *const _)),
                None=>(None,None),
            };
            let next=resolver.resolve(id)?.map(|second|second as *const _);
            Ok(json!({"selected":selected_json,"resolved":resolved,
                "sameInstance":first_ptr==next,
                "cacheCount":resolver.cached_count()}).to_string())
        },
        "apiLocalBlockerPorts" => {
            use agents_relay_rust2::{
                local_authority_store::LocalAuthorityDurableStore,
                blocker_store_port::CrossJobBlockerStore,
                relay_store::SQLiteRelayStore,
            };
            use std::time::{SystemTime,UNIX_EPOCH};
            let base=std::env::temp_dir().join(format!(
                "rust2-blocker-api-{}-{}",
                std::process::id(),
                SystemTime::now().duration_since(UNIX_EPOCH)
                    .map_err(|e|e.to_string())?.as_nanos()
            ));
            std::fs::create_dir_all(&base).map_err(|e|e.to_string())?;
            let dependent_path=base.join("dependent.sqlite");
            let result=(|| ->Result<Value,String>{
                let mut blocking=LocalAuthorityDurableStore::new(
                    SQLiteRelayStore::open(&base.join("blocker.sqlite"),None)?,true);
                let mut dependent=LocalAuthorityDurableStore::new(
                    SQLiteRelayStore::open(&dependent_path,None)?,true);
                blocking.save_job(&request["blocker"])?;
                dependent.save_job(&request["dependent"])?;
                let graph=std::path::Path::new(
                    request["graphDirectory"].as_str().unwrap_or("workflow"));
                let blocker_id=request["blocker"]["id"].as_str().unwrap_or("");
                let dependent_id=request["dependent"]["id"].as_str().unwrap_or("");
                let target=request["target"].clone();
                let mut stages=Vec::<Value>::new();
                for (step_index,step) in request["steps"].as_array()
                    .into_iter().flatten().enumerate(){
                    let step_stamp=request["now"].as_str().and_then(|stamp|
                        chrono::DateTime::parse_from_rfc3339(stamp).ok())
                        .map(|stamp|(stamp+chrono::Duration::milliseconds(
                            step_index as i64+1)).to_rfc3339_opts(
                            chrono::SecondsFormat::Millis,true));
                    let effect=match step.as_str().unwrap_or(""){
                        "register"=>blocking.register_blocker_dependent(
                            graph,blocker_id,&target,Some(&mut dependent),
                            step_stamp.as_deref()).map(|_|Value::Null),
                        "resolve-merge"|"resolve-verified"=>{
                            let resolution=if step=="resolve-merge"{"merge"}else{"verified"};
                            let mut related_factory=|repository:&str,pr_number:u64|
                                ->Result<Box<dyn CrossJobBlockerStore>,String>{
                                if repository!=request["dependent"]["repository"]
                                    .as_str().unwrap_or("")
                                    ||pr_number!=request["dependent"]["prNumber"]
                                        .as_u64().unwrap_or(0){
                                    return Err("Related Job store fixture missing".into());
                                }
                                Ok(Box::new(LocalAuthorityDurableStore::new(
                                    SQLiteRelayStore::open(&dependent_path,None)?,true)))
                            };
                            blocking.resolve_blocker_dependents(
                                graph,blocker_id,resolution,Some(&mut related_factory),
                                step_stamp.as_deref())
                        },
                        "advance-attempt"=>{
                            let current=dependent.load(dependent_id)?;
                            let mut task=current["tasks"][0].clone();
                            task["attempt"]=json!(task["attempt"].as_i64().unwrap_or(0)+1);
                            task["updatedAt"]=json!("2099-01-01T00:00:00.000Z");
                            dependent.save_task(&task)?;
                            Ok(Value::Null)
                        },
                        other=>Err(format!("Unknown fixture blocker step {other}"))
                    };
                    stages.push(json!({"step":step,"outcome":match effect{
                        Ok(value)=>json!({"ok":true,"value":value}),
                        Err(error)=>json!({"ok":false,"error":error}),
                    }}));
                }
                Ok(json!({"stages":stages,
                    "blocker":blocking.load(blocker_id)?,
                    "dependent":dependent.load(dependent_id)?}))
            })();
            let _=std::fs::remove_dir_all(base);
            result.map(|value|value.to_string())
        }
        "apiOutcomeReview" => {
            use agents_relay_rust2::outcome_review::evaluate_outcome;
            let role=std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent().unwrap().join("agents/outcome-reviewer.agent.md");
            let mut inputs=Vec::<Value>::new();
            let run=evaluate_outcome(&request["options"],
                |reviewer,_|{
                    if reviewer!="reviewer" {
                        return Err(format!("professional reviewer not found: {reviewer}"));
                    }
                    std::fs::read_to_string(&role).map_err(|error|error.to_string())
                },
                |reviewer,prompt,project|{
                    inputs.push(json!({"reviewer":reviewer,"prompt":prompt,
                        "project":project.to_string_lossy()}));
                    if let Some(error)=request.get("spawnError").and_then(Value::as_str){
                        return Err(error.to_owned());
                    }
                    Ok(request.get("spawnResponse").cloned().unwrap_or(Value::Null))
                });
            Ok(json!({"outcome":match run{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"inputs":inputs}).to_string())
        }
        "apiResolvePullRequest" => {
            use agents_relay_rust2::{
                store_pull_request::resolve_pull_request,
                store_github::GitHubApi,
            };
            struct FixtureClient {responses:Vec<Value>,calls:Vec<Value>}
            impl FixtureClient {
                fn next(&mut self)->Result<Value,String>{
                    if self.responses.is_empty(){
                        return Err("Fixture GitHub effect exhausted".into());
                    }
                    let row=self.responses.remove(0);
                    if let Some(error)=row.get("fixtureError").and_then(Value::as_str){
                        return Err(error.to_owned());
                    }
                    Ok(row)
                }
            }
            impl GitHubApi for FixtureClient {
                fn graphql(&mut self,query:&str,variables:&Value)->Result<Value,String>{
                    self.calls.push(json!({"kind":"graphql",
                        "query":query,"variables":variables}));
                    self.next()
                }
                fn request(&mut self,path:&str,method:&str,body:Option<&Value>)
                    ->Result<Value,String>{
                    self.calls.push(json!({"kind":"request",
                        "path":path,"method":method,"body":body}));
                    self.next()
                }
            }
            let mut client=FixtureClient{
                responses:request["responses"].as_array().cloned().unwrap_or_default(),
                calls:Vec::new()
            };
            let result=resolve_pull_request(&mut client,
                request["repository"].as_str().unwrap_or(""),
                &request["options"]);
            Ok(json!({"outcome":match result{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"calls":client.calls}).to_string())
        }
        "apiPlannerLaunch" => planner_launch_public::invoke(request),
        "apiPlannerFinish" => planner_finish_public::invoke(request),
        "apiPlannerApplyTree" => planner_finish_public::apply_tree(request),
        "apiReviewBase" => review_base_public::invoke(request),
        "apiRuntimeBase" => runtime_base_public::invoke(request),
        "apiReconcilerPlanJob" => reconciler_recovery_public::plan(request),
        "apiReconcilerRecovery" => reconciler_recovery_public::invoke(request),
        "apiReconcilerReconcile" => reconcile_public::invoke(request),
        "apiReconcilerCurrentGitHead" => reconciler_git_head_public::invoke(request),
        "apiCliRuntimePublic" => cli_runtime_public::invoke(request),
        "apiCliRuntimeFactory" => cli_runtime_public::factory(request),
        "apiCliService" => cli_service_public::invoke(request),
        "apiPoolLocal" => pool_public::local(request),
        "apiPoolWatch" => pool_public::watch(request),
        "apiPoolWebhook" => {
            use agents_relay_rust2::pool::RepositoryWorkerPool;
            let pool=RepositoryWorkerPool::new(2,"workflow");
            let mut events=Vec::<Value>::new();
            let fail_at=request["failAt"].as_u64().map(|n|n as usize);
            let mut publish=|event:&Value|->Result<(),String>{
                if fail_at==Some(events.len()){
                    return Err("Fixture publish failure".into());
                }
                events.push(event.clone());
                Ok(())
            };
            let result=if request["bus"]==false{
                pool.webhook_wake(&request["job"],&request["wake"],None)
            }else{
                pool.webhook_wake(&request["job"],&request["wake"],Some(&mut publish))
            };
            Ok(json!({"outcome":match result{
                Ok(())=>json!({"ok":true}),
                Err(error)=>json!({"ok":false,"error":error})
            },"events":events}).to_string())
        }
        "apiPoolKnown" => {
            use agents_relay_rust2::pool::RepositoryWorkerPool;
            use std::{cell::RefCell,collections::HashMap,rc::Rc};
            let found=Rc::new(request["localJobs"].as_array().into_iter().flatten()
                .filter_map(|job|job.get("id").and_then(Value::as_str)
                    .map(|id|(id.to_owned(),job.clone())))
                .collect::<HashMap<_,_>>());
            let discovered=request["discovered"].as_array().into_iter()
                .flatten().map(|job|json!({"job":job})).collect::<Vec<_>>();
            let calls=Rc::new(RefCell::new(Vec::<Value>::new()));
            let mut pool=RepositoryWorkerPool::new(2,"workflow");
            let hydrated=request["hydrateEnabled"]!=false;
            let recoverable=request["recoverEnabled"]!=false;
            let recovery_error=request["recoverError"].as_str().map(str::to_owned);
            let recovered_state=request["recoveredState"].as_str().map(str::to_owned);
            let found_lookup=Rc::clone(&found);
            let found_recovery=Rc::clone(&found);
            let hydrate_calls=Rc::clone(&calls);
            let recovery_calls=Rc::clone(&calls);
            let execute_calls=Rc::clone(&calls);
            let result=pool.reconcile_known(&discovered,
                move |id|Ok(found_lookup.get(id).cloned()),
                move |id,_job|{
                    if hydrated{
                        hydrate_calls.borrow_mut().push(json!(["hydrate",id]));
                    }
                    Ok(())
                },
                move |id|{
                    recovery_calls.borrow_mut().push(json!(["make",0,id]));
                    if !recoverable{return Ok(None);}
                    recovery_calls.borrow_mut().push(json!(["recover",id]));
                    if let Some(error)=&recovery_error{return Err(error.clone());}
                    let Some(mut next)=found_recovery.get(id).cloned()
                        else{return Err(format!("Local job not found: {id}"));};
                    if let Some(state)=&recovered_state{next["state"]=json!(state);}
                    Ok(Some(next))
                },
                move |id,slots|{
                    execute_calls.borrow_mut().push(json!(["reconcile",id,slots]));
                    Ok(Value::Null)
                });
            Ok(json!({"outcome":match result{
                Ok(())=>json!({"ok":true}),
                Err(error)=>json!({"ok":false,"error":error})
            },"calls":calls.borrow().clone()}).to_string())
        }
        "apiStoreGithubPublic" => {
            use agents_relay_rust2::{
                pool::aggregate_managed_github_jobs,
                store::{
                    load_managed_github_pull_request_graphql,
                    load_managed_github_job_graphql,list_managed_github_jobs,
                },
                store_github::GitHubApi,
            };
            use std::collections::HashSet;
            struct FixtureClient {
                responses:Vec<Value>,calls:Vec<Value>,
            }
            impl GitHubApi for FixtureClient {
                fn graphql(&mut self,query:&str,variables:&Value)->Result<Value,String>{
                    self.calls.push(json!({"query":query,"variables":variables}));
                    if self.responses.is_empty() {
                        return Err("Fixture GraphQL response exhausted".into());
                    }
                    let response=self.responses.remove(0);
                    if let Some(error)=response.get("fixtureError").and_then(Value::as_str){
                        return Err(error.to_owned());
                    }
                    Ok(response)
                }
                fn request(&mut self,_path:&str,_method:&str,_body:Option<&Value>)
                    ->Result<Value,String>{
                    Err("Unexpected fixture network request".into())
                }
            }
            let mut client=FixtureClient{
                responses:request["responses"].as_array().cloned().unwrap_or_default(),
                calls:Vec::new()
            };
            let trusted=request["trusted"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<HashSet<_>>();
            let repo=request["repository"].as_str().unwrap_or("");
            let number=request["prNumber"].as_u64().unwrap_or(0);
            let result=match request["kind"].as_str().unwrap_or("pull"){
                "pull"=>load_managed_github_pull_request_graphql(
                    &mut client,repo,number,&trusted).map(|value|json!(value)),
                "job"=>load_managed_github_job_graphql(
                    &mut client,repo,number,
                    request["jobId"].as_str().unwrap_or(""),&trusted).map(|value|json!(value)),
                "list"=>list_managed_github_jobs(&mut client,repo,&trusted)
                    .map(|value|json!(value)),
                "aggregate"=>{
                    let repositories=request["repositories"].as_array()
                        .into_iter().flatten().filter_map(Value::as_str)
                        .map(str::to_owned).collect::<Vec<_>>();
                    aggregate_managed_github_jobs(&mut client,&repositories,&trusted)
                        .map(|value|json!(value))
                },
                _=>Err("Unknown Store GitHub operation".into()),
            };
            Ok(json!({"outcome":match result{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"calls":client.calls}).to_string())
        }
        "apiCliCoordinator" => {
            use agents_relay_rust2::{
                cli_coordinator::run_coordinator_job_command,
                relay_store::SQLiteRelayStore,
            };
            let store=SQLiteRelayStore::open(std::path::Path::new(":memory:"),None)?;
            store.save_job(&request["job"])?;
            let id=request["job"]["id"].as_str().ok_or("Fixture Job ID required")?;
            let job=store.load_job(id)?.ok_or("Fixture Job missing")?;
            let args=request["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let mut foreground_called=false;
            let mut foreground=|_:&SQLiteRelayStore,_:&str,_:&str|{
                foreground_called=true;Ok(())
            };
            let result=run_coordinator_job_command(
                std::path::Path::new(request["graphDirectory"].as_str().unwrap_or("workflow")),
                &args,id,&store,&job,None,None,None,
                if request["hasForeground"]==true{Some(&mut foreground)}else{None},
                None);
            let after=store.load_job(id)?.ok_or("Fixture Job vanished")?;
            Ok(json!({"outcome":match result{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"after":after,"foregroundCalled":foreground_called}).to_string())
        }
        "apiModelRedecision" => {
            struct StubUsage(Value);
            impl agents_relay_rust2::usage::UsageSnapshotProvider for StubUsage {
                fn snapshot(&self)->Result<Value,String>{Ok(self.0.clone())}
            }
            let registered=request["registered"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let mut updated=Value::Null;
            let mut audits=Vec::<Value>::new();
            let result=agents_relay_rust2::model_redecision::redecide_failed_task(
                &request["task"],&request["worker"],registered,
                &StubUsage(request["usage"].clone()),&request["evidence"],
                std::path::Path::new(request["codexHome"].as_str().unwrap_or("/tmp/nonexistent-rust2-home")),
                request["nowMs"].as_i64().unwrap_or(1_794_938_400_000),
                request["policyPath"].as_str().unwrap_or("/tmp/nonexistent-rust2-policy"),
                request["rulesPath"].as_str().unwrap_or("/tmp/nonexistent-rust2-rules"),
                request["decisionMode"].as_str(),
                request["choice"].as_str(),request.get("decisionEvidence"),
                request["withAudit"].as_bool().unwrap_or(false),
                |_,route|{updated=route.clone();Ok(())},
                |record|{audits.push(record.clone());Ok(())});
            Ok(json!({"outcome":match result{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"updated":updated,"audits":audits}).to_string())
        }
        "apiCliReview" => {
            use agents_relay_rust2::cli_review::run_review_command;
            let action=request["action"].as_str().unwrap_or("interactive");
            let args=request["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let mut request_body=Value::Null;
            let mut control_body=Value::Null;
            let output=run_review_command(action,&args,
                |file|{
                    let bytes=std::fs::read(file).map_err(|e|e.to_string())?;
                    request_body=serde_json::from_slice(&bytes)
                        .map_err(|e|e.to_string())?;
                    Ok(request["previewOutput"].as_str()
                        .unwrap_or("{\"status\":\"pending\"}").to_owned())
                },
                |_,body|{
                    control_body=body.clone();
                    Ok(request.get("controlResponse").cloned().unwrap_or(Value::Null))
                },
                |_| Ok(request.get("outcomeResponse").cloned()
                    .unwrap_or(Value::Null)),
            );
            Ok(json!({"outcome":match output{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"preview":request_body,"control":control_body}).to_string())
        }
        "apiCliUnblock" => {
            use agents_relay_rust2::{
                cli_unblock::{run_task_unblock_command,run_job_unblock_command},
                relay_store::SQLiteRelayStore,
            };
            let store=SQLiteRelayStore::open(std::path::Path::new(":memory:"),None)?;
            store.save_job(&request["job"])?;
            let job_id=request["job"]["id"].as_str().ok_or("Fixture Job ID required")?;
            let job=store.load_job(job_id)?.ok_or("Fixture Job missing")?;
            let args=request["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let graph=std::path::Path::new(request["graphDirectory"].as_str().unwrap_or("workflow"));
            let result=match request["kind"].as_str().unwrap_or("task"){
                "job"=>run_job_unblock_command(graph,&args,&store,&job,None),
                "task"=>{
                    let id=request["taskId"].as_str().ok_or("Fixture Task ID required")?;
                    let task=job["tasks"].as_array().into_iter().flatten()
                        .find(|item|item["id"]==id)
                        .ok_or("Fixture Task missing")?;
                    run_task_unblock_command(graph,&args,&store,&job,task,None,None)
                },
                _=>Err("Unknown CLI unblock fixture".into()),
            };
            let after=store.load_job(job_id)?.ok_or("Fixture Job vanished")?;
            Ok(json!({"outcome":match result{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            },"after":after}).to_string())
        }
        "apiDaemonObservability" => {
            let configured=agents_relay_rust2::relayd_utilities::configure_daemon_observability(
                &request["env"]);
            let global=agents_relay_rust2::observability::observability();
            Ok(json!({"level":configured.minimum_level,
                "installedLevel":global.minimum_level,
                "enabled":request["levels"].as_array().into_iter().flatten()
                    .map(|level|configured.is_enabled(level.as_str().unwrap_or("")))
                    .collect::<Vec<_>>()}).to_string())
        }
        "apiRouterRulesDaemonConfig" => {
            let mut env=request["env"].as_object().into_iter().flatten()
                .filter_map(|(key,value)|value.as_str().map(|value|(key.clone(),value.to_owned())))
                .collect::<std::collections::HashMap<_,_>>();
            let args=request["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let home=std::path::Path::new(request["home"].as_str().unwrap_or("/tmp"));
            let path=agents_relay_rust2::relayd_utilities::configure_execution_router_rules_path_with_env(
                &args,&mut env,home);
            Ok(json!({"path":path,"env":env}).to_string())
        }
        "apiEscalationConfigured" => {
            let env = request["env"].as_object().into_iter().flatten()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
                .collect::<std::collections::HashMap<_,_>>();
            let timeout = std::time::Duration::from_millis(
                request["timeoutMs"].as_u64().unwrap_or(600_000));
            Ok(agents_relay_rust2::cli_escalation::run_configured_escalation_with_timeout(
                &request["request"], &env, timeout).to_string())
        }
        "apiEscalationCommand" => {
            let env = request["env"].as_object().into_iter().flatten()
                .filter_map(|(key, value)| value.as_str().map(|value| (key.clone(), value.to_owned())))
                .collect::<std::collections::HashMap<_,_>>();
            let args = request["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            Ok(agents_relay_rust2::cli_escalation::run_escalation_command(
                &args, &env,
                std::path::Path::new(request["graphDirectory"].as_str().unwrap_or("workflow")),
            )?.to_string())
        }
        // Newly closed API surfaces live in an isolated parity fixture module.
        // Node src/adapters.ts: exact public worker argument and submitted receipt contracts.
        "stage2BuildCodexArgs" => Ok(json!(agents_relay_rust2::adapters::build_codex_args(
            &request["route"],request["input"].as_str().unwrap_or(""))).to_string()),
        "stage2TabClosePolicy" => Ok(json!(agents_relay_rust2::adapters::chatgpt_tab_close_policy_value(
            request.get("value"),request["fallback"].as_str().unwrap_or("after-start"))?).to_string()),
        "stage2ParseDriverJson" => Ok(agents_relay_rust2::adapters::parse_driver_json(
            request["output"].as_str().unwrap_or(""))?.to_string()),
        // Node src/pool.ts: pure Job ordering, admission and Graph restart checks.
        "stage2CompareJobPriority" => {
            use std::cmp::Ordering;
            let compared=agents_relay_rust2::pool::compare_job_priority(&request["a"],&request["b"]);
            Ok(json!(match compared{Ordering::Less=>-1,Ordering::Equal=>0,Ordering::Greater=>1}).to_string())
        }
        "stage2RunnableManagedJobs" => Ok(json!(agents_relay_rust2::pool::runnable_managed_jobs(
            request["items"].as_array().map(Vec::as_slice).unwrap_or(&[]))).to_string()),
        "stage2ActiveWorkerSlots" => Ok(json!(agents_relay_rust2::pool::active_worker_slots(
            &request["job"])).to_string()),
        "stage2NeedsLifecycleReconciliation" => Ok(json!(agents_relay_rust2::pool::needs_lifecycle_reconciliation(
            std::path::Path::new(request["graphDirectory"].as_str().unwrap_or("workflow")),
            &request["job"],request["now"].as_i64().unwrap_or(0))?).to_string()),
        "nativeLocalMergeReconcile" => {
            use std::{future::{ready,Future},pin::pin,task::{Context,Poll,Waker}};
            let mut job=request["job"].clone();
            let now=request["nowMs"].as_i64().unwrap_or(1795000000000);
            let head=request["headSha"].as_str();
            let mut inputs=Vec::new();
            let completed={
            let future=agents_relay_rust2::local_merge_delivery::reconcile_local_git_completion(
                std::path::Path::new("workflow"),&mut job,head,true,
                Some(std::path::Path::new("/tmp/rust2-mock-repo")),now,
                |candidate,_event|ready(Ok(candidate)),
                |_repo,receipt|{
                    inputs.push(receipt.clone());
                    if let Some(error)=request["mergeError"].as_str(){
                        return Err(error.into());
                    }
                    Ok(request.get("mergeResult").cloned().unwrap_or(json!({
                        "sourceSha":head,"mergedCommitSha":"b".repeat(40)
                    })))
                });
            let mut future=pin!(future);
            let mut ctx=Context::from_waker(Waker::noop());
            match future.as_mut().poll(&mut ctx){
                Poll::Ready(answer)=>answer?,
                Poll::Pending=>return Err("Mock Git completion Future unexpectedly suspended".into()),
            }
            };
            Ok(json!({"completed":completed,"job":job,"mergeInputs":inputs}).to_string())
        }
        "nativeRemoteProjectionReconcile" => {
            use std::cell::RefCell;
            let job_id=request["job"]["id"].as_str().ok_or("Job ID missing")?;
            let repo=std::path::Path::new(request["repo"].as_str().ok_or("Git root missing")?);
            let job=RefCell::new(request["job"].clone());
            agents_relay_rust2::local_merge_projection::reconcile_completed_local_delivery(
                std::path::Path::new("workflow"),job_id,repo,
                |_id|Ok(job.borrow().clone()),
                |_id,mutate|{
                    let mut current=job.borrow().clone();
                    let changed=mutate(&mut current)?;
                    *job.borrow_mut()=current.clone();
                    Ok((current,changed))
                })?;
            let output=job.into_inner();
            Ok(output.to_string())
        }
        "wave4LocalMerge" => {
            let repo = std::path::Path::new(request["repo"].as_str().ok_or("repo missing")?);
            let receipt = agents_relay_rust2::local_git_merge::deliver_local_merge(
                repo,
                &request["receipt"],
            )?;
            Ok(json!({"sourceSha":receipt.source_sha,
                "mergedCommitSha":receipt.merged_commit_sha})
            .to_string())
        }
        "wave4Continuation" => {
            use agents_relay_rust2::continuation::{
                continue_with_owned_process, Continuation, DeliveryProcessOptions,
            };
            let kind = request["kind"].as_str().unwrap_or("");
            let target = request["target"].as_str().unwrap_or("");
            let input = request["input"].as_str().unwrap_or("");
            let continuation = match request["continuationKind"].as_str().unwrap_or(kind) {
                "codex-thread" => Continuation::CodexThread { target },
                "command" => Continuation::Command { target },
                "webhook" => Continuation::Webhook { target },
                _ => return Err("Unsupported fixture continuation kind".into()),
            };
            let mut owned = agents_relay_rust2::owned_process::OwnedProcessManager::default();
            continue_with_owned_process(
                kind,
                input,
                continuation,
                request["commandOverride"].as_str(),
                &mut owned,
                DeliveryProcessOptions {
                    timeout: Some(std::time::Duration::from_secs(4)),
                    ..Default::default()
                },
            )?;
            Ok("null".into())
        }
        "wave4DagOwned" => {
            let mut owned = agents_relay_rust2::owned_process::OwnedProcessManager::default();
            let outcome = agents_relay_rust2::dag_result_contract::dag_completion_error_owned(
                &request["task"],
                request["projectPath"].as_str().map(std::path::Path::new),
                request["interpreter"].as_str().unwrap_or("node"),
                &mut owned,
                agents_relay_rust2::continuation::DeliveryProcessOptions {
                    timeout: Some(std::time::Duration::from_secs(4)),
                    ..Default::default()
                },
            );
            Ok(json!(outcome).to_string())
        }
        "wave4RouteJsonl" => {
            use agents_relay_rust2::route_outcome_recording as audit;
            let path = std::path::Path::new(request["path"].as_str().ok_or("path required")?);
            let task = &request["task"];
            let execution_id = request["executionId"].as_str();
            let outcome = match request["kind"].as_str().unwrap_or("terminal") {
                "terminal" => audit::record_terminal_route_outcome_jsonl(
                    path,
                    task,
                    &request["event"],
                    execution_id,
                ),
                "launch" => audit::record_launch_route_outcome_jsonl(
                    path,
                    task,
                    request["message"].as_str().unwrap_or(""),
                    request["phase"].as_str().unwrap_or("launch"),
                    execution_id,
                    request["unknownOutcome"] == true,
                ),
                "watchdog" => {
                    audit::record_watchdog_route_outcome_jsonl(path, task, &request["watchdog"])
                }
                _ => return Err("Unsupported fixture route kind".into()),
            };
            Ok(json!(outcome.is_some()).to_string())
        }
        "deliveryWave2" => {
            Ok(agents_relay_rust2::delivery_parity_harness::delivery_wave2(request)?.to_string())
        }
        "settlementFacts" => Ok(
            agents_relay_rust2::review_revision_settlement::settlement_facts(
                &request["job"],
                request["taskId"].as_str().unwrap_or(""),
                request["maxRounds"].as_u64().unwrap_or(5),
                request["maxNoProgressRounds"].as_u64().unwrap_or(1),
            )
            .to_string(),
        ),
        "settleReviewRevisionRound" => {
            let mut job = request["job"].clone();
            let changed =
                agents_relay_rust2::review_revision_settlement::settle_review_revision_round(
                    &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                        .join("workflow"),
                    &mut job,
                    request["maxRounds"].as_u64().unwrap_or(5),
                    request["maxNoProgressRounds"].as_u64().unwrap_or(1),
                )?;
            Ok(json!({"changed":changed,"job":job}).to_string())
        }
        "staleReviewRevisions" => {
            let mut job = request["job"].clone();
            let cancelled = agents_relay_rust2::review_revision_stale::stale_review_revisions(
                &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                    .join("workflow"),
                &mut job,
                request["reviewTaskId"].as_str().unwrap_or(""),
                request["headSha"].as_str().unwrap_or(""),
                request["activeExecutionId"].as_str(),
            )?;
            Ok(json!({"job":job,"cancelled":cancelled}).to_string())
        }
        "createFailedPlanRecovery" => Ok(
            agents_relay_rust2::planner_recovery::create_failed_plan_recovery(
                &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                    .join("workflow"),
                std::path::Path::new(request["storeDir"].as_str().ok_or("storeDir required")?),
                &request["job"],
                &request["plan"],
            )?
            .to_string(),
        ),
        "fallbackFailedTroubleshooters" => {
            let mut job = request["job"].clone();
            let queued =
                agents_relay_rust2::troubleshooter_fallback::fallback_failed_troubleshooters(
                    &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                        .join("workflow"),
                    &mut job,
                )?;
            Ok(json!({"job":job,"queued":queued}).to_string())
        }

        // Worker B: source-level deterministic differential adapters. Never touch durable stores.
        "parseReviewFinding" => Ok(agents_relay_rust2::review_chair::parse_review_finding(
            &request["value"],
            request["index"].as_u64().unwrap_or(0) as usize,
        )?
        .to_string()),
        "parseSpecialistReview" => Ok(agents_relay_rust2::review_chair::parse_specialist_review(
            &request["value"],
        )?
        .to_string()),
        "selectReviewPanel" => Ok(json!(agents_relay_rust2::review_chair::select_review_panel(
            request["candidates"]
                .as_array()
                .ok_or("candidates required")?,
            request["dimensions"]
                .as_array()
                .ok_or("dimensions required")?,
            agents_relay_rust2::review_chair::panel_max(request.get("max"))?
        )?)
        .to_string()),
        "specialistReviewTaskMetadata" => Ok(
            agents_relay_rust2::review_chair::specialist_review_task_metadata(
                &request["target"],
                &request["member"],
                request["round"].as_u64().unwrap_or(1),
            )
            .to_string(),
        ),
        "createSpecialistReviewTasks" => Ok(json!(
            agents_relay_rust2::review_chair::create_specialist_review_tasks(
                request["tasks"].as_array().ok_or("tasks required")?,
                &request["target"],
                request["panel"].as_array().ok_or("panel required")?,
                request["round"].as_u64().unwrap_or(1)
            )
        )
        .to_string()),
        "createReviewChairExecutionPlan" => Ok(
            agents_relay_rust2::review_chair::create_review_chair_execution_plan(
                request["agents"].as_array().ok_or("agents required")?,
                &request["target"],
                agents_relay_rust2::review_chair::panel_max(request.get("max"))?,
            )?
            .to_string(),
        ),
        "synthesizeReview" => Ok(agents_relay_rust2::review_chair::synthesize_review(
            &request["target"],
            request["panel"].as_array().ok_or("panel required")?,
            request["reviews"].as_array().ok_or("reviews required")?,
        )?
        .to_string()),
        "reviewWorkSettled" => Ok(
            json!(agents_relay_rust2::review_replan::review_work_settled(
                &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                    .join("workflow"),
                &request["job"],
            )?)
            .to_string(),
        ),
        "recordTargetedRevisionRequest" => {
            let mut job = request["job"].clone();
            let result =
                agents_relay_rust2::review_revision_model::record_targeted_revision_request(
                    &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                        .join("workflow"),
                    &mut job,
                    &request["input"],
                )?;
            Ok(json!({"result":result,"job":job}).to_string())
        }
        "reviewNeedsReplan" => Ok(
            json!(agents_relay_rust2::review_replan::review_needs_replan(
                &request["job"]
            ))
            .to_string(),
        ),
        "reviewPlanReady" => Ok(json!(agents_relay_rust2::review_replan::review_plan_ready(
            &request["job"]
        ))
        .to_string()),
        "revisionRequestReady" => Ok(json!(
            agents_relay_rust2::review_revision_execution::revision_request_ready(
                &request["job"],
                &request["task"]
            )
        )
        .to_string()),
        "reconcileReviewRevisionFacts" => {
            let mut job = request["job"].clone();
            let changed =
                agents_relay_rust2::review_revision_execution::reconcile_review_revision_facts(
                    &std::path::Path::new(request["root"].as_str().ok_or("root required")?)
                        .join("workflow"),
                    &mut job,
                )?;
            if changed {
                job["updatedAt"] = json!("NORMALIZED");
            }
            Ok(json!({"changed":changed,"job":job}).to_string())
        }
        "targetedRequestsForReview" => Ok(json!(
            agents_relay_rust2::review_revision_model::targeted_requests_for_review(
                &request["job"],
                &request["task"],
                request["headSha"].as_str().unwrap_or("")
            )
        )
        .to_string()),
        "targetedRequestsCoverReview" => Ok(json!(
            agents_relay_rust2::review_revision_model::targeted_requests_cover_review(
                &request["job"],
                &request["task"],
                request["headSha"].as_str().unwrap_or(""),
                request["issues"].as_array().ok_or("issues required")?
            )
        )
        .to_string()),
        "dependencyValidityReview" => Ok(json!(
            agents_relay_rust2::review_revision_model::dependency_validity(
                &request["task"],
                request["id"].as_str().unwrap_or("")
            )?
        )
        .to_string()),
        "dependencyRevisionVectorReview" => Ok(
            agents_relay_rust2::review_revision_model::dependency_revision_vector(
                &request["job"],
                &request["task"],
            )?
            .to_string(),
        ),
        "sameDependencyRevisionVectorReview" => Ok(json!(
            agents_relay_rust2::review_revision_model::same_dependency_revision_vector(
                &request["a"],
                &request["b"]
            )
        )
        .to_string()),
        "normalizeThreadId" => Ok(
            json!(agents_relay_rust2::reviewer_thread::normalize_thread_id(
                &request["value"],
                request["label"].as_str().unwrap_or("thread ID")
            )?)
            .to_string(),
        ),
        "resolveImplementationThreadDestination" => Ok(
            agents_relay_rust2::reviewer_thread::resolve_implementation_thread_destination(
                &request["job"],
            )?
            .to_string(),
        ),
        "resolveImplementationTaskThreadDestination" => Ok(
            agents_relay_rust2::reviewer_thread::resolve_implementation_task_thread_destination(
                &request["job"],
                &request["task"],
            )?
            .to_string(),
        ),
        "resolveReviewerThreadDestination" => Ok(
            agents_relay_rust2::reviewer_thread::resolve_reviewer_thread_destination(
                &request["job"],
                request.get("override"),
            )?
            .to_string(),
        ),
        "prepareReviewerThreadDelivery" => Ok(
            agents_relay_rust2::reviewer_thread::prepare_reviewer_thread_delivery(
                &request["job"],
                &request["task"],
                request.get("override"),
            )?
            .to_string(),
        ),
        "chatgptThreadRequirements" => Ok(
            agents_relay_rust2::reviewer_thread::chatgpt_thread_requirements(
                &request["configured"],
            )
            .to_string(),
        ),
        "runtimeReviewer" => Ok(agents_relay_rust2::reviewer_thread::runtime_reviewer(
            &request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>(),
        )?
        .to_string()),
        "prepareRevisionThreadDelivery" => {
            let mut child = request["child"].clone();
            let delivery = agents_relay_rust2::reviewer_thread::prepare_revision_thread_delivery(
                &request["job"],
                &mut child,
            )?;
            if !child["revision"]["threadContinuation"].is_null() {
                child["revision"]["threadContinuation"]["decidedAt"] = json!("NORMALIZED");
            }
            Ok(json!({"child":child,"delivery":delivery}).to_string())
        }
        "parseOutcomeReviewArgs" => Ok(
            agents_relay_rust2::outcome_review::parse_outcome_review_args(
                &request["args"]
                    .as_array()
                    .ok_or("args required")?
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>(),
                std::path::Path::new(request["cwd"].as_str().ok_or("cwd required")?),
            )?
            .to_string(),
        ),
        "reviewerContract" => Ok(json!(agents_relay_rust2::outcome_review::reviewer_contract(
            request["name"].as_str().unwrap_or(""),
            std::path::Path::new(
                request["projectPath"]
                    .as_str()
                    .ok_or("projectPath required")?
            ),
            request["sharedRoot"].as_str().map(std::path::Path::new),
            std::path::Path::new(request["root"].as_str().ok_or("root required")?)
        )?
        .to_string_lossy())
        .to_string()),
        "combineOutcomeReviews" => Ok(agents_relay_rust2::outcome_review::combine_outcome_reviews(
            request["reviews"].as_array().ok_or("reviews required")?,
        )
        .to_string()),

        "wave2Coordinator" => {
            use agents_relay_rust2::reconcile_coordinator::ReconcileCoordinator;
            use std::sync::{Arc, Mutex};
            let batches = Arc::new(Mutex::new(Vec::<Value>::new()));
            let failures = Arc::new(Mutex::new(Vec::<Value>::new()));
            let log = Arc::clone(&batches);
            let errors = Arc::clone(&failures);
            let coordinator = ReconcileCoordinator::new(
                move |job, signals| {
                    log.lock()
                        .map_err(|e| e.to_string())?
                        .push(json!({"jobId":job,"signals":signals}));
                    if signals.iter().any(|s| s["fail"] == true) {
                        Err("fixture consumer failed".into())
                    } else {
                        Ok(())
                    }
                },
                Some(Arc::new(move |err, signal| {
                    errors
                        .lock()
                        .expect("fixture errors")
                        .push(json!({"error":err,"signal":signal}));
                })),
            );
            let mut outcomes = Vec::new();
            for signal in request["signals"].as_array().into_iter().flatten() {
                let method = signal["method"].as_str().unwrap_or("accept");
                let input = signal["signal"].clone();
                let receiver = match method {
                    "accept" => coordinator.accept(input),
                    "acceptTransport" => coordinator.accept_transport(input),
                    "acceptObserved" => coordinator.accept_observed(input),
                    _ => return Err(format!("Unknown coordinator method {method}")),
                };
                let resolved = receiver
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .map_err(|e| format!("Coordinator acceptance timeout: {e}"))?;
                outcomes.push(match resolved {
                    Ok(()) => json!({"ok":true}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
                coordinator.settle();
            }
            Ok(json!({"outcomes":outcomes,
                "batches":batches.lock().map_err(|e|e.to_string())?.clone(),
                "failures":failures.lock().map_err(|e|e.to_string())?.clone(),
                "idle":coordinator.is_idle()})
            .to_string())
        }
        "wave2Decision" => {
            use agents_relay_rust2::decision::{
                self, JevDecisionEngine, JevDecisionOptions, LayaCliDecisionEngine, LayaCliOptions,
            };
            let action = request["action"].as_str().unwrap_or("");
            let output: Value = match action {
                "validate" => {
                    decision::validate_decision_request(&request["request"], &request["contract"])?;
                    json!(null)
                }
                "parse" => decision::parse_choice_decision(&request["raw"], &request["contract"])?,
                "mode" => json!(decision::decision_mode()),
                "layaArgs" => json!(decision::laya_args_from_env(request["env"].as_str())?),
                "jevBody" => JevDecisionEngine::request_body(
                    &request["request"],
                    &request["contract"],
                    request["model"].as_str().unwrap_or("typesafe/jev-1.13"),
                )?,
                "jevResponse" => {
                    JevDecisionEngine::parse_response(&request["raw"], &request["contract"], 0)?
                }
                "jevDecide" => {
                    let engine = JevDecisionEngine::new(JevDecisionOptions {
                        api_key: request["apiKey"].as_str().map(str::to_owned),
                        endpoint: Some("http://127.0.0.1:1".into()),
                        model: None,
                        timeout_ms: Some(99),
                    });
                    engine.decide_with_fetcher(
                        &request["request"],
                        &request["contract"],
                        |_, _, body, _| {
                            if body["questions"]["decision"]["criteria"].is_null() {
                                return Err("bad Jev criteria".into());
                            }
                            Ok((
                                request["httpStatus"].as_u64().unwrap_or(200) as u16,
                                request["raw"].clone(),
                            ))
                        },
                    )?
                }
                "choose" => {
                    let engine = if request["hasEngine"] == true {
                        Some("mock-engine")
                    } else {
                        None
                    };
                    let raw = request["raw"].clone();
                    let err = request["engineError"].as_str().map(str::to_owned);
                    let f = decision::choose_with_decision(
                        engine,
                        move |_, _| {
                            let result = if let Some(ref err) = err {
                                Err(err.clone())
                            } else {
                                Ok(raw.clone())
                            };
                            async move { result }
                        },
                        request["mode"].as_str().unwrap_or("active"),
                        &request["request"],
                        &request["contract"],
                        || request["fallback"].as_str().unwrap_or("").to_string(),
                    );
                    use std::{
                        future::Future,
                        pin::pin,
                        task::{Context, Poll, Waker},
                    };
                    let mut pin = pin!(f);
                    let mut context = Context::from_waker(Waker::noop());
                    match pin.as_mut().poll(&mut context) {
                        Poll::Ready(done) => done?,
                        Poll::Pending => return Err("Unexpected deferred mock decision".into()),
                    }
                }
                "layaRunner" => {
                    let options = LayaCliOptions {
                        command: "laya".into(),
                        args: vec!["predict".into()],
                        timeout_ms: 2000,
                    };
                    let engine = LayaCliDecisionEngine::new(options);
                    engine.decide_with_owned_runner(
                        &request["request"],
                        &request["contract"],
                        |_, argv, _| {
                            let state_path =
                                std::path::Path::new(argv.get(2).map(String::as_str).unwrap_or(""));
                            let questions_path =
                                std::path::Path::new(argv.get(4).map(String::as_str).unwrap_or(""));
                            if !state_path.is_file() || !questions_path.is_file() {
                                return Err("Laya file contract missing".into());
                            }
                            let actual: Value = serde_json::from_slice(
                                &std::fs::read(state_path).map_err(|e| e.to_string())?,
                            )
                            .map_err(|e| e.to_string())?;
                            if actual != request["request"]["facts"] {
                                return Err("Laya state mismatch".into());
                            }
                            Ok(request["output"].as_str().unwrap_or("").to_string())
                        },
                    )?
                }
                _ => return Err("unknown wave2 decision action".into()),
            };
            Ok(output.to_string())
        }
        "wave2Operations" => {
            use agents_relay_rust2::{
                relay_workflow_operations::SQLiteWorkflowOperations,
                workflow::durable_publication::DurableWorkflowPublication,
            };
            use rusqlite::{params, Connection, OptionalExtension};
            let db = Connection::open_in_memory().map_err(|e| e.to_string())?;
            db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT)")
                .map_err(|e| e.to_string())?;
            let job_id = request["jobId"].as_str().unwrap_or("123");
            if !request["job"].is_null() {
                db.execute(
                    "INSERT INTO job_snapshot VALUES (?1,?2)",
                    params![job_id, request["job"].to_string()],
                )
                .map_err(|e| e.to_string())?;
            }
            let action = request["action"].as_str().unwrap_or("");
            let result: Result<Value, String> = (|| {
                if action == "drainWorkflowEvents" {
                    let publication = DurableWorkflowPublication::new(&db)?;
                    for item in request["events"].as_array().into_iter().flatten() {
                        publication.enqueue(
                            item["key"].as_str().unwrap_or(""),
                            item["eventId"].as_str().unwrap_or(""),
                            &item["payload"],
                        )?;
                    }
                }
                let write = |job: &Value, _now: &str| -> Result<(), String> {
                    db.execute(
                        "INSERT OR REPLACE INTO job_snapshot VALUES (?1,?2)",
                        params![job_id, job.to_string()],
                    )
                    .map_err(|e| e.to_string())?;
                    Ok(())
                };
                let mut ops = SQLiteWorkflowOperations {
                    db: &db,
                    write,
                    enqueue: None::<fn(&Value, &str) -> Result<(), String>>,
                };
                match action {
                    "mutateJob" => {
                        ops.mutate_job(job_id, |_| Ok(request["newJob"].clone()))?;
                        Ok(json!(null))
                    }
                    "commitWorkflowMutationAndEvents" => {
                        ops.commit_workflow_mutation_and_events(
                            job_id,
                            |_| Ok(request["newJob"].clone()),
                            request["events"]
                                .as_array()
                                .map(Vec::as_slice)
                                .unwrap_or(&[]),
                        )?;
                        Ok(json!(null))
                    }
                    "commitWorkflowMutationWithEvents" => {
                        ops.commit_workflow_mutation_with_events(job_id, |_| {
                            Ok((
                                request["newJob"].clone(),
                                request["events"].as_array().cloned().unwrap_or_default(),
                            ))
                        })?;
                        Ok(json!(null))
                    }
                    "reserveWorkflowLaunch" => Ok(json!(ops.reserve_workflow_launch(
                        std::path::Path::new(request["directory"].as_str().unwrap_or("workflow")),
                        &request["identity"]
                    )?)),
                    "verifyWorkflowLaunch" => Ok(json!(ops.verify_workflow_launch(
                        job_id,
                        request["taskId"].as_str().unwrap_or(""),
                        request["executionId"].as_str().unwrap_or("")
                    )?)),
                    "drainWorkflowEvents" => {
                        let mut published = Vec::<Value>::new();
                        let count = ops.drain_workflow_events(|event| {
                            if request["failPublish"] == true {
                                return Err("fixture publisher failed".into());
                            }
                            published.push(event.clone());
                            Ok(())
                        })?;
                        Ok(json!({"count":count,"published":published}))
                    }
                    _ => Err("unknown wave2Operations action".into()),
                }
            })();
            let outbox = if let Ok(publication) = DurableWorkflowPublication::new(&db) {
                publication
                    .pending()
                    .unwrap_or_default()
                    .into_iter()
                    .map(|p| p.as_value())
                    .collect::<Vec<_>>()
            } else {
                vec![]
            };
            let snapshot: Option<String> = db
                .query_row(
                    "SELECT json FROM job_snapshot WHERE job_id=?",
                    params![job_id],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|e| e.to_string())?;
            Ok(json!({"result":match result{Ok(value)=>json!({"ok":true,"value":value}),Err(error)=>json!({"ok":false,"error":error})},
                "job":snapshot.map(|raw|serde_json::from_str::<Value>(&raw).unwrap_or(Value::Null)),"pending":outbox}).to_string())
        }
        "wave3CoordinatorTurn" => {
            use agents_relay_rust2::reconcile_coordinator::ReconcileCoordinator;
            use std::sync::{Arc, Mutex};
            let batches = Arc::new(Mutex::new(Vec::<Value>::new()));
            let failures = Arc::new(Mutex::new(Vec::<Value>::new()));
            let produced = Arc::clone(&batches);
            let reported = Arc::clone(&failures);
            type ErrorReporter = dyn Fn(&str, &Value) + Send + Sync;
            let reporter: Arc<ErrorReporter> = Arc::new(move |error, signal| {
                reported
                    .lock()
                    .expect("fixture errors")
                    .push(json!({"error":error,"signal":signal}));
            });
            let worker = ReconcileCoordinator::new(
                move |job, signals| {
                    produced
                        .lock()
                        .expect("fixture batches")
                        .push(json!({"jobId":job,"signals":signals}));
                    if signals.iter().any(|s| s["fail"] == true) {
                        Err("fixture consumer failed".into())
                    } else {
                        Ok(())
                    }
                },
                Some(reporter),
            );
            let turn = worker.begin_turn();
            let replies = request["signals"]
                .as_array()
                .ok_or("signals array required")?
                .iter()
                .map(|item| {
                    let signal = item["signal"].clone();
                    match item["method"].as_str().unwrap_or("") {
                        "accept" => Ok(worker.accept(signal)),
                        "acceptTransport" => Ok(worker.accept_transport(signal)),
                        "acceptObserved" => Ok(worker.accept_observed(signal)),
                        other => Err(format!("Unknown ReconcileCoordinator method {other}")),
                    }
                })
                .collect::<Result<Vec<_>, _>>()?;
            drop(turn);
            let outcomes = replies
                .into_iter()
                .map(|reply| match reply.recv() {
                    Ok(Ok(())) => json!({"ok":true}),
                    Ok(Err(error)) => json!({"ok":false,"error":error}),
                    Err(error) => json!({"ok":false,"error":error.to_string()}),
                })
                .collect::<Vec<_>>();
            worker.settle();
            let mut batches = batches.lock().expect("fixture batches").clone();
            batches.sort_by(|a, b| a["jobId"].as_str().cmp(&b["jobId"].as_str()));
            let mut failures = failures.lock().expect("fixture errors").clone();
            failures.sort_by(|a, b| {
                a["signal"]["reason"]
                    .as_str()
                    .cmp(&b["signal"]["reason"].as_str())
            });
            Ok(json!({"outcomes":outcomes,"batches":batches,"failures":failures,"idle":worker.is_idle()}).to_string())
        }
        "wave3Graph" => {
            let directory =
                std::path::Path::new(request["directory"].as_str().unwrap_or("workflow"));
            match request["action"].as_str().unwrap_or("") {
                "progressSqlite" => {
                    use rusqlite::Connection;
                    let mut db = Connection::open_in_memory().map_err(|e| e.to_string())?;
                    db.execute_batch(
                         "CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL)",
                    )
                    .map_err(|e| e.to_string())?;
                    let job = &request["job"];
                    let job_id = job["id"].as_str().ok_or("job id required")?;
                    db.execute(
                        "INSERT INTO job_snapshot VALUES(?,?,?)",
                        rusqlite::params![
                            job_id,
                            job.to_string(),
                            job["updatedAt"]
                                .as_str()
                                .unwrap_or("2026-11-17T09:00:00.000Z")
                        ],
                    )
                    .map_err(|e| e.to_string())?;
                    let applied =
                        agents_relay_rust2::task_inactivity_watchdog::accept_task_progress_sqlite(
                            &mut db,
                            directory,
                            &request["event"],
                            request["now"].as_i64().ok_or("now required")?,
                        )?;
                    let raw: String = db
                        .query_row(
                            "SELECT json FROM job_snapshot WHERE job_id=?",
                            [job_id],
                            |r| r.get(0),
                        )
                        .map_err(|e| e.to_string())?;
                    let updated: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
                    let task = updated["tasks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .find(|t| t["id"] == request["event"]["task_id"]);
                    Ok(json!({"accepted":applied.is_some(),
                      "state":task.map(|t|t["state"].clone()).unwrap_or(Value::Null),
                      "lastProgressEventAt":task.map(|t|t["lastProgressEventAt"].clone()).unwrap_or(Value::Null),
                      "executionId":task.map(|t|t["executionId"].clone()).unwrap_or(Value::Null)
                    }).to_string())
                }
                "plannerFactsMutable" => {
                    let mut job = request["job"].clone();
                    let facts=agents_relay_rust2::workflow::planner_orchestration_v2::
                        planner_orchestration_facts_in_place(&mut job,request["recoverable"]==true);
                    Ok(json!({"facts":facts,"plans":job["plans"]}).to_string())
                }
                "laya" => {
                    let timeout = request["timeoutMs"].as_u64().unwrap_or(2000);
                    let script = request["script"].as_str().ok_or("script required")?;
                    let options = agents_relay_rust2::decision::LayaCliOptions {
                        command: "/bin/sh".into(),
                        args: vec!["-c".into(), script.into(), "fixture".into()],
                        timeout_ms: timeout,
                    };
                    let engine = agents_relay_rust2::decision::LayaCliDecisionEngine::new(options);
                    // Match Node's public `decide`, not the stub runner used by Wave2.
                    Ok(engine
                        .decide(&request["request"], &request["contract"])?
                        .to_string())
                }
                "asyncTransition" => {
                    use agents_relay_rust2::task_transitions::{
                        transition_job_event_async, transition_task_event_async,
                    };
                    use std::sync::{Arc, Mutex};
                    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
                    let state = Mutex::new(request["entity"].clone());
                    let event = request["event"].as_str().ok_or("event required")?;
                    let facts = &request["facts"];
                    let timestamp = request["timestamp"]
                        .as_str()
                        .unwrap_or("2026-11-17T09:00:00Z");
                    let effect_error = request["effectError"].as_str().map(str::to_owned);
                    let persist_error = request["persistError"].as_str().map(str::to_owned);
                    let affected = Arc::clone(&trace);
                    let stored = Arc::clone(&trace);
                    let effect = move |action: String| {
                        let trace = Arc::clone(&affected);
                        let error = effect_error.clone();
                        async move {
                            trace
                                .lock()
                                .expect("trace")
                                .push(format!("effect:{action}"));
                            if let Some(error) = error {
                                return Err(error);
                            }
                            Ok(())
                        }
                    };
                    let persist = move |_: Value| {
                        let trace = Arc::clone(&stored);
                        let error = persist_error.clone();
                        async move {
                            trace.lock().expect("trace").push("persist".into());
                            if let Some(error) = error {
                                return Err(error);
                            }
                            Ok(())
                        }
                    };
                    fn run<T>(future: impl std::future::Future<Output = T>) -> T {
                        use std::{
                            pin::pin,
                            task::{Context, Poll, Waker},
                        };
                        let mut future = pin!(future);
                        let mut ctx = Context::from_waker(Waker::noop());
                        match future.as_mut().poll(&mut ctx) {
                            Poll::Ready(value) => value,
                            Poll::Pending => panic!("async native fixture must resolve"),
                        }
                    }
                    let mut entity = state.lock().expect("entity");
                    let outcome = if request["kind"] == "task" {
                        run(transition_task_event_async(
                            directory,
                            &mut entity,
                            event,
                            facts,
                            timestamp,
                            effect,
                            persist,
                        ))
                    } else {
                        run(transition_job_event_async(
                            directory,
                            &mut entity,
                            event,
                            facts,
                            timestamp,
                            effect,
                            persist,
                        ))
                    };
                    let trace = trace.lock().expect("trace").clone();
                    Ok(json!({"outcome":match outcome {
                        Ok(decision)=>json!({"ok":true,"decision":decision}),
                        Err(error)=>json!({"ok":false,"error":error}),
                    },"entity":*entity,"trace":trace})
                    .to_string())
                }
                "plannerAsyncEffects" => {
                    use std::future::Future;
                    use std::sync::{Arc, Mutex};
                    use std::{
                        pin::pin,
                        task::{Context, Poll, Waker},
                    };
                    let trace = Arc::new(Mutex::new(Vec::<String>::new()));
                    let recorded = Arc::clone(&trace);
                    let fail = request["effectError"].as_str().map(str::to_owned);
                    let receipt = request.get("receipt").cloned().unwrap_or_else(|| json!({}));
                    let future = agents_relay_rust2::workflow::planner_orchestration_v2::
                        dispatch_planner_orchestration_async(directory, &request["facts"], move |action| {
                            let recorded = Arc::clone(&recorded);
                            let fail = fail.clone();
                            let receipt = receipt.clone();
                            async move {
                                recorded.lock().expect("trace").push(action);
                                if let Some(error) = fail { return Err(error); }
                                Ok(receipt)
                            }
                        });
                    let mut future = pin!(future);
                    let mut context = Context::from_waker(Waker::noop());
                    let outcome = match future.as_mut().poll(&mut context) {
                        Poll::Ready(Ok(decision)) => json!({"ok":true,"decision":decision}),
                        Poll::Ready(Err(error)) => json!({"ok":false,"error":error}),
                        Poll::Pending => {
                            return Err("native async fixture unexpectedly pending".into())
                        }
                    };
                    let trace = trace.lock().expect("trace").clone();
                    Ok(json!({"outcome":outcome,"trace":trace}).to_string())
                }
                "plannerRuntime" => {
                    let runtime =
                        agents_relay_rust2::workflow::planner_orchestration_v2::planner_orchestration_v2(
                            directory,
                        )?;
                    let mut states = runtime.registry.states.iter().cloned().collect::<Vec<_>>();
                    let mut guards = runtime.registry.guards.keys().cloned().collect::<Vec<_>>();
                    let mut actions = runtime.registry.actions.keys().cloned().collect::<Vec<_>>();
                    let mut events = runtime.registry.events.keys().cloned().collect::<Vec<_>>();
                    states.sort();
                    guards.sort();
                    actions.sort();
                    events.sort();
                    Ok(
                        json!({"states":states,"guards":guards,"actions":actions,"events":events})
                            .to_string(),
                    )
                }
                "resolutionRuntime" => {
                    let runtime =
                        agents_relay_rust2::workflow::task_resolution::task_resolution_v2(
                            directory,
                        )?;
                    Ok(json!({"states":runtime.registry.states.len(),
                      "guards":runtime.registry.guards.len(),
                      "actions":runtime.registry.actions.len(),
                      "events":runtime.registry.events.len()})
                    .to_string())
                }
                action => Err(format!("unknown wave3 Graph action: {action}")),
            }
        }
        "wave4ResolutionEffects" => {
            use agents_relay_rust2::workflow::task_resolution;
            use std::{
                future::Future,
                pin::pin,
                sync::{Arc, Mutex},
                task::{Context, Poll, Waker},
            };
            let graph = std::path::Path::new(request["directory"].as_str().unwrap_or("workflow"));
            let trace = Arc::new(Mutex::new(Vec::<String>::new()));
            let error = request["effectError"].as_str().map(str::to_owned);
            let absent = request["effectMissing"] == true;
            let result = if request["async"] == true {
                let observed = Arc::clone(&trace);
                let future = task_resolution::dispatch_task_resolution(
                    graph,
                    &request["task"],
                    &request["proposal"],
                    &request["owner"],
                    move |action| {
                        let observed = Arc::clone(&observed);
                        let error = error.clone();
                        async move {
                            if absent {
                                return Err(format!(
                                    "Task resolution effect {action} is unavailable"
                                ));
                            }
                            observed.lock().expect("trace").push(action);
                            if let Some(error) = error {
                                return Err(error);
                            }
                            Ok(())
                        }
                    },
                );
                let mut future = pin!(future);
                let mut context = Context::from_waker(Waker::noop());
                match future.as_mut().poll(&mut context) {
                    Poll::Ready(done) => done,
                    Poll::Pending => return Err("unhandled native asynchronous callback".into()),
                }
            } else {
                task_resolution::dispatch_task_resolution_sync(
                    graph,
                    &request["task"],
                    &request["proposal"],
                    &request["owner"],
                    |action| {
                        if absent {
                            return Err(format!("Task resolution effect {action} is unavailable"));
                        }
                        trace.lock().expect("trace").push(action.to_owned());
                        if let Some(error) = &error {
                            return Err(error.clone());
                        }
                        Ok(())
                    },
                )
            };
            let outcome = match result {
                Ok(value) => json!({"ok":true,"value":value}),
                Err(error) => json!({"ok":false,"error":error}),
            };
            let trace = trace.lock().expect("trace").clone();
            Ok(json!({"outcome":outcome,"trace":trace}).to_string())
        }
        "wave4Watchdog" => {
            use agents_relay_rust2::task_inactivity_watchdog as watchdog;
            let task = &request["task"];
            let result = match request["action"].as_str().unwrap_or("") {
                "requires" => json!(watchdog::requires_worker_inactivity_watchdog(task)),
                "recoverable" => json!(watchdog::is_recoverable_watchdog_failure(task)),
                "correlated" => json!(watchdog::is_correlated_worker_event(
                    task,
                    &request["event"]
                )),
                "deadline" => json!(watchdog::inactivity_deadline(
                    task,
                    request["executionId"].as_str().unwrap_or(""),
                    request["graceMs"].as_i64().unwrap_or(0),
                    request["now"].as_i64().unwrap_or(0),
                )),
                action => return Err(format!("unknown wave4 watchdog action {action}")),
            };
            Ok(result.to_string())
        }
        "wave2Graph" => {
            use agents_relay_rust2::{
                task_transitions,
                workflow::{
                    authoritative_conditions, planner_orchestration_v2, task_reconcile,
                    task_resolution,
                },
            };
            let action = request["action"].as_str().unwrap_or("");
            let directory =
                std::path::Path::new(request["directory"].as_str().unwrap_or("workflow"));
            let result: Value = match action {
                "dependencyReady" => {
                    let mut map = std::collections::HashMap::new();
                    for row in request["tasks"].as_array().into_iter().flatten() {
                        map.insert(row["id"].as_str().unwrap_or("").to_string(), row.clone());
                    }
                    json!(task_reconcile::dependency_ready(&request["task"], &map))
                }
                "detectCycles" => {
                    task_reconcile::detect_cycles(
                        request["tasks"]
                            .as_array()
                            .map(Vec::as_slice)
                            .unwrap_or(&[]),
                    )?;
                    json!(null)
                }
                "revisionRequestReady" => json!(task_reconcile::revision_request_ready(
                    &request["job"],
                    &request["task"]
                )),
                "reconcileTaskDependencies" => {
                    let mut job = request["job"].clone();
                    task_reconcile::reconcile_task_dependencies(
                        directory,
                        &mut job,
                        "2026-11-17T10:00:00.000Z",
                    )?;
                    json!(job["tasks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|t| t["state"].clone())
                        .collect::<Vec<_>>())
                }
                "plannerFacts" => planner_orchestration_v2::planner_orchestration_facts(
                    &request["job"],
                    request["recoverable"] == true,
                ),
                "plannerDecision" => planner_orchestration_v2::decide_planner_orchestration(
                    directory,
                    &request["facts"],
                )?,
                "plannerDispatch" => planner_orchestration_v2::dispatch_planner_orchestration(
                    directory,
                    &request["facts"],
                    |_| Ok(json!({})),
                )?,
                "transitionTaskTry" | "transitionTask" => {
                    let mut task = request["task"].clone();
                    let event = request["event"].as_str().unwrap_or("");
                    let decision = if action == "transitionTask" {
                        task_transitions::transition_task_event(
                            directory,
                            &mut task,
                            event,
                            &request["facts"],
                            "2026-11-17T10:00:00.000Z",
                        )?
                    } else {
                        task_transitions::try_transition_task_event(
                            directory,
                            &mut task,
                            event,
                            &request["facts"],
                            "2026-11-17T10:00:00.000Z",
                        )?
                    };
                    json!({"decision":decision,"task":task})
                }
                "transitionJob" => {
                    let mut job = request["job"].clone();
                    let decision = task_transitions::transition_job_event(
                        directory,
                        &mut job,
                        request["event"].as_str().unwrap_or(""),
                        &request["facts"],
                        "2026-11-17T10:00:00.000Z",
                    )?;
                    json!({"decision":decision,"job":job})
                }
                "completionGateSatisfied" => {
                    json!(task_transitions::completion_gate_satisfied(&request["job"]))
                }
                "extendRetryBudget" => json!(task_transitions::extend_retry_budget(
                    request["attempt"].as_f64().unwrap_or(0.0),
                    request["maxAttempts"].as_f64().unwrap_or(0.0),
                    request
                        .get("windowSize")
                        .and_then(Value::as_f64)
                        .unwrap_or(3.0)
                )?),
                "refreshTaskDependencies" => {
                    let mut job = request["job"].clone();
                    task_transitions::refresh_task_dependencies(
                        directory,
                        &mut job,
                        "2026-11-17T10:00:00.000Z",
                    )?;
                    json!(job["tasks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .map(|t| t["state"].clone())
                        .collect::<Vec<_>>())
                }
                "resolutionValidate" => {
                    task_resolution::validate_resolution_proposal(
                        &request["job"],
                        &request["task"],
                        &request["proposal"],
                    )?;
                    json!(null)
                }
                "resolutionFacts" => task_resolution::resolution_facts(
                    &request["task"],
                    &request["proposal"],
                    &request["owner"],
                ),
                "resolutionDecision" => task_resolution::decide_task_resolution(
                    directory,
                    &request["task"],
                    &request["proposal"],
                    &request["owner"],
                )?,
                "resolutionMaterialize" => task_resolution::materialize_resolution(
                    &request["proposal"],
                    &request["owner"],
                    "2026-11-17T10:00:00.000Z",
                ),
                "resolutionClassification" => {
                    let mut task = request["task"].clone();
                    let applied = task_resolution::classify_task_resolution(
                        directory,
                        &mut task,
                        &request["classification"],
                        "2026-11-17T10:00:00.000Z",
                    )?;
                    json!({"applied":applied,"task":task})
                }
                "resolutionClaim" => {
                    let mut task = request["task"].clone();
                    task_resolution::claim_exact_original_recovery(
                        &mut task,
                        &request["recovery"],
                        "2026-11-17T10:00:00.000Z",
                    )?;
                    task
                }
                "resolutionAttach" => {
                    let mut job = request["job"].clone();
                    task_resolution::attach_resolution_ownership(
                        directory,
                        &mut job,
                        &request["child"],
                        &request["proposal"],
                        &request["owner"],
                        "2026-11-17T10:00:00.000Z",
                    )?;
                    job
                }
                "authoritative" => {
                    let db = rusqlite::Connection::open_in_memory().map_err(|e| e.to_string())?;
                    db.execute_batch(
                        "CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT);",
                    )
                    .map_err(|e| e.to_string())?;
                    if !request["job"].is_null() {
                        db.execute(
                            "INSERT INTO job_snapshot VALUES (?1,?2)",
                            rusqlite::params![
                                request["jobId"].as_str().unwrap_or(""),
                                request["job"].to_string()
                            ],
                        )
                        .map_err(|e| e.to_string())?;
                    }
                    if request["createProcessTable"] == true {
                        db.execute_batch("CREATE TABLE execution_process(job_id TEXT,task_id TEXT,execution_id TEXT,ended_at TEXT);").map_err(|e|e.to_string())?;
                        for row in request["processes"].as_array().into_iter().flatten() {
                            db.execute(
                                "INSERT INTO execution_process VALUES (?1,?2,?3,?4)",
                                rusqlite::params![
                                    row["jobId"].as_str().unwrap_or(""),
                                    row["taskId"].as_str().unwrap_or(""),
                                    row["executionId"].as_str().unwrap_or(""),
                                    row["endedAt"].as_str()
                                ],
                            )
                            .map_err(|e| e.to_string())?;
                        }
                    }
                    json!(authoritative_conditions::verify_authoritative_condition(
                        &db,
                        request["jobId"].as_str().unwrap_or(""),
                        request["predicate"].as_str().unwrap_or(""),
                        request["taskId"].as_str(),
                        request["executionId"].as_str()
                    )?)
                }
                _ => return Err(format!("Unknown wave2 graph action {action}")),
            };
            Ok(result.to_string())
        }

        "runArtifactCommand" => {
            let args = request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            let mut outputs = Vec::<String>::new();
            let result = agents_relay_rust2::cli_artifact::run_artifact_command(
                request["action"].as_str().unwrap_or(""),
                &args,
                |line| outputs.push(line),
            );
            Ok(json!({"stdout":outputs,"error":result.err()}).to_string())
        }
        "parseRevisionFindings" => Ok(agents_relay_rust2::cli_revision::parse_revision_findings(
            request["source"].as_str().unwrap_or(""),
        )?
        .to_string()),
        "revisionRequest" => {
            let args = request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            Ok(agents_relay_rust2::cli_revision::revision_request(&args)?.to_string())
        }
        "revisionReceipt" => Ok(agents_relay_rust2::cli_revision::validate_revision_receipt(
            &request["request"],
            request["response"].clone(),
        )?
        .to_string()),
        "blockerEffect" => {
            let args = request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            let effect = agents_relay_rust2::cli_blocker::blocker_effect(
                request["action"].as_str().unwrap_or(""),
                &args,
                request["stdin"].as_str(),
            )?;
            use agents_relay_rust2::cli_blocker::BlockerEffect;
            Ok(match effect {
                BlockerEffect::Control(body) => json!({"type":"control","body":body}),
                BlockerEffect::Job(id) => json!({"type":"job","jobId":id}),
                BlockerEffect::Resolve(id) => json!({"type":"resolve","jobId":id}),
            }
            .to_string())
        }
        "workflowCliResult" => {
            let args = request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            Ok(agents_relay_rust2::cli_workflow::workflow_cli_result(&args)?.to_string())
        }
        "runContextCommand" => {
            let args = request["args"]
                .as_array()
                .ok_or("args required")?
                .iter()
                .map(|v| v.as_str().unwrap_or("").to_string())
                .collect::<Vec<_>>();
            Ok(agents_relay_rust2::cli_context::run_context_command(
                request["action"].as_str().unwrap_or(""),
                &args,
            )?
            .to_string())
        }
        "discoverScriptAgent" => Ok(json!(
            agents_relay_rust2::agent_script_discovery::discover_script_agent(
                request["agent"].as_str().unwrap_or(""),
                request["projectPath"].as_str().unwrap_or(""),
                request["sharedRoot"].as_str(),
                request["workspaceRoot"].as_str(),
                request["globalRoot"].as_str()
            )?
        )
        .to_string()),
        "missingScriptAgents" => Ok(json!(
            agents_relay_rust2::agent_script_discovery::missing_script_agents(
                request["graph"].as_str().unwrap_or(""),
                request["projectPath"].as_str().unwrap_or(""),
                request["sharedRoot"].as_str(),
                request["workspaceRoot"].as_str(),
                request["globalRoot"].as_str()
            )?
        )
        .to_string()),
        "processWorkerScenario" => {
            Ok(agents_relay_rust2::process_worker_parity_harness::scenario(request)?.to_string())
        }
        "lifecycleBatchScenario" => Ok(
            agents_relay_rust2::workflow::lifecycle_parity_harness::scenario(request)?.to_string(),
        ),

        "workflowObservationScenario" => Ok(
            agents_relay_rust2::workflow::policy_parity_harness::observation_scenario(request)?
                .to_string(),
        ),

        "workflowVerifiedDispatcherScenario" => Ok(
            agents_relay_rust2::workflow::policy_parity_harness::verified_dispatcher_scenario(
                request,
            )?
            .to_string(),
        ),

        "workflowPolicyScenario" => Ok(
            agents_relay_rust2::workflow::policy_parity_harness::policy_scenario(request)?
                .to_string(),
        ),
        "workflowDispatcherScenario" => Ok(
            agents_relay_rust2::workflow::policy_parity_harness::dispatcher_scenario(request)?
                .to_string(),
        ),

        "workflowRuntimeMutation" => {
            use agents_relay_rust2::workflow::runtime::*;
            let mut target = request.get("target").cloned().unwrap_or(json!({}));
            let at = request["timestamp"]
                .as_str()
                .unwrap_or("2026-11-17T05:00:00.000Z");
            let result = match request["action"].as_str().unwrap_or("") {
                "applyTaskMutation" => {
                    apply_task_mutation(&mut target, request["mutation"].as_str().unwrap_or(""), at)
                }
                "applyTaskGraphTarget" => apply_task_graph_target(
                    &mut target,
                    request["state"].as_str().unwrap_or(""),
                    at,
                    request["authoritativeUnblock"] == true,
                ),
                "applyJobGraphTarget" => {
                    apply_job_graph_target(
                        &mut target,
                        request["state"].as_str().unwrap_or(""),
                        at,
                    );
                    Ok(())
                }
                "applyTaskWorkflowDecision" => {
                    apply_task_workflow_decision(&mut target, &request["decision"], at)
                }
                "applyJobWorkflowDecision" => {
                    apply_job_workflow_decision(&mut target, &request["decision"], at)
                }
                "applyHistoricalJobCompatibilityRepair" => {
                    apply_historical_job_compatibility_repair(
                        &mut target,
                        request["state"].as_str().unwrap_or(""),
                        at,
                    )
                }
                _ => Err("Unknown workflow runtime mutation".into()),
            };
            result?;
            Ok(agents_relay_rust2::observability::json_wire(&target))
        }
        "graphWorkflowDecision" => {
            use agents_relay_rust2::workflow::{
                mermaid::{
                    parse_executable_mermaid, WorkflowAction, WorkflowEngine, WorkflowGuard,
                },
                runtime::graph_workflow_decision,
            };
            use std::{collections::HashMap, sync::Arc};
            let graph = parse_executable_mermaid(request["source"].as_str().unwrap_or(""))?;
            let guards = graph
                .transitions
                .iter()
                .filter_map(|transition| transition.guard.as_deref())
                .map(|name| {
                    let result = request["guards"]
                        .get(name)
                        .and_then(Value::as_bool)
                        .unwrap_or(false);
                    (
                        name.to_string(),
                        WorkflowGuard::Sync(Arc::new(move |_| Ok(result))),
                    )
                })
                .collect::<HashMap<_, _>>();
            let actions = graph
                .transitions
                .iter()
                .flat_map(|transition| transition.actions.iter())
                .map(|name| (name.clone(), WorkflowAction::Declarative))
                .collect::<HashMap<_, _>>();
            let engine = WorkflowEngine::new(graph, guards, actions)?;
            Ok(graph_workflow_decision(
                &engine,
                request["from"].as_str().unwrap_or(""),
                request["event"].as_str().unwrap_or(""),
                &request["facts"],
            )?
            .to_string())
        }

        "assertV2StateTransition" => {
            use std::path::Path;
            let graph = if request["graph"] == "task" {
                agents_relay_rust2::workflow::definitions_v2::task_lifecycle_v2(Path::new(
                    request["directory"].as_str().ok_or("directory needed")?,
                ))?
                .graph
            } else if request["graph"] == "job" {
                agents_relay_rust2::workflow::definitions_v2::job_lifecycle_v2(Path::new(
                    request["directory"].as_str().ok_or("directory needed")?,
                ))?
                .graph
            } else {
                agents_relay_rust2::workflow::graph_v2::parse_graph_v2(
                    request["source"].as_str().unwrap_or(""),
                )?
            };
            agents_relay_rust2::workflow::definitions_v2::assert_v2_state_transition(
                &graph,
                request["from"].as_str().unwrap_or(""),
                request["to"].as_str().unwrap_or(""),
                request["kind"].as_str().unwrap_or("Job"),
            )?;
            Ok("null".into())
        }
        "canonicalWorkflowV2Evaluate" => {
            use std::path::Path;
            let path = Path::new(request["directory"].as_str().ok_or("directory needed")?);
            let runtime = if request["graph"] == "task" {
                agents_relay_rust2::workflow::definitions_v2::task_lifecycle_v2(path)?
            } else {
                agents_relay_rust2::workflow::definitions_v2::job_lifecycle_v2(path)?
            };
            Ok(runtime.evaluate_sync(&request["facts"])?.to_string())
        }

        "parseAgentGraph" => Ok(agents_relay_rust2::agent_graph::parse_agent_graph(
            request["source"].as_str().unwrap_or(""),
        )?
        .json()
        .to_string()),
        "validateAgentSelection" => {
            use std::collections::HashSet;
            let visible = request["visible"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<HashSet<_>>();
            agents_relay_rust2::agent_graph::validate_agent_selection(
                &visible,
                request["agentName"].as_str(),
                request["source"].as_str(),
            )?;
            Ok("null".into())
        }
        "agentGraphPrompt" => {
            use std::collections::HashSet;
            let visible = request["visible"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<HashSet<_>>();
            let prompt = agents_relay_rust2::agent_graph::agent_graph_prompt(
                &visible,
                request["source"].as_str().unwrap_or(""),
                |name| {
                    request["contracts"][name]
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| format!("Agent {name} contract not found"))
                },
            )?;
            Ok(json!(prompt).to_string())
        }

        "workflowUsageIndex" => {
            use agents_relay_rust2::workflow::{
                graph_v2::parse_graph_v2,
                usage_index::{build_workflow_usage_index, where_workflow_symbol},
            };
            use std::{collections::BTreeMap, path::Path};
            let mut graphs = BTreeMap::new();
            for entry in request["graphs"].as_array().into_iter().flatten() {
                let name = entry["name"].as_str().ok_or("Graph name missing")?;
                graphs.insert(
                    name.to_string(),
                    parse_graph_v2(entry["source"].as_str().unwrap_or(""))?,
                );
            }
            if let Some(directory) = request["directory"].as_str() {
                graphs = agents_relay_rust2::workflow::usage_index::executable_graphs(Path::new(
                    directory,
                ))?;
            }
            let index = build_workflow_usage_index(&graphs);
            let usage = if let Some(id) = request["id"].as_str() {
                where_workflow_symbol(&index, id, request["kind"].as_str())
            } else {
                index
            };
            Ok(json!(usage).to_string())
        }

        "parseGraphV2" => Ok(agents_relay_rust2::workflow::graph_v2::parse_graph_v2(
            request["source"].as_str().unwrap_or(""),
        )?
        .json()
        .to_string()),
        "graphV2Scenario" => {
            use agents_relay_rust2::workflow::graph_v2::{
                parse_graph_v2, GraphDispatcher, GraphRegistry, GraphRuntime,
            };
            use std::sync::Arc;
            let source = request["source"].as_str().unwrap_or("");
            let graph = parse_graph_v2(source)?;
            let mut registry = GraphRegistry::default();
            for node in &graph.nodes {
                match node.kind.as_str() {
                    "state" => {
                        registry.states.insert(node.semantic_id.clone());
                    }
                    "guard" => {
                        let result = request["guards"]
                            .get(&node.semantic_id)
                            .and_then(Value::as_bool)
                            .unwrap_or(false);
                        registry
                            .guards
                            .insert(node.semantic_id.clone(), Arc::new(move |_facts| result));
                    }
                    "action" => {
                        registry
                            .actions
                            .insert(node.semantic_id.clone(), (None, None));
                    }
                    "emit" => {
                        registry.events.insert(node.semantic_id.clone(), None);
                    }
                    _ => {}
                }
            }
            for edge in &graph.edges {
                if let Some(id) = edge.semantic_id.as_deref() {
                    match edge.kind.as_str() {
                        "on" | "emit" => {
                            registry.events.insert(id.into(), None);
                        }
                        "request" => {
                            registry.actions.entry(id.into()).or_insert((None, None));
                        }
                        _ => {}
                    }
                }
            }
            for rejected in request["rejectedPayloadIds"]
                .as_array()
                .into_iter()
                .flatten()
            {
                let Some(id) = rejected.as_str() else {
                    continue;
                };
                let check = Arc::new(|_payload: &Value| false);
                if let Some(entry) = registry.events.get_mut(id) {
                    *entry = Some(check.clone());
                }
                if let Some(entry) = registry.actions.get_mut(id) {
                    entry.0 = Some(check.clone());
                }
            }
            let receipts = request.get("receipts").cloned().unwrap_or(Value::Null);
            for (id, (_, execute)) in registry.actions.iter_mut() {
                let id = id.clone();
                let output = receipts.get(&id).cloned().unwrap_or(json!({}));
                *execute = Some(Arc::new(move |_context| Ok(output.clone())));
            }
            let runtime = GraphRuntime::new(source, registry)?;
            let facts = &request["facts"];
            if request["dispatch"] == true {
                use std::{cell::RefCell, rc::Rc};
                let transitions = Rc::new(RefCell::new(Vec::<Value>::new()));
                let events = Rc::new(RefCell::new(Vec::<Value>::new()));
                let transitions_sink = Rc::clone(&transitions);
                let events_sink = Rc::clone(&events);
                let result = GraphDispatcher { runtime: &runtime }.dispatch_sync(
                    facts,
                    move |transition| {
                        transitions_sink.borrow_mut().push(transition.clone());
                        Ok(())
                    },
                    move |event| {
                        events_sink.borrow_mut().push(event.clone());
                        Ok(())
                    },
                )?;
                return Ok(json!({"result":result,"transitions":transitions.borrow().clone(),"events":events.borrow().clone()}).to_string());
            }
            Ok(runtime.evaluate_sync(facts)?.to_string())
        }

        "durableWorkflowScenario" => {
            use rusqlite::{params, Connection};
            let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch(
                "CREATE TABLE objective (value INTEGER NOT NULL); INSERT INTO objective VALUES(0);",
            )
            .map_err(|error| error.to_string())?;
            let outbox =
                agents_relay_rust2::workflow::durable_publication::DurableWorkflowPublication::new(
                    &db,
                )?;
            let inbox =
                agents_relay_rust2::workflow::durable_publication::DurableWorkflowConsumer::new(
                    &db,
                )?;
            let mut outputs = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                use agents_relay_rust2::workflow::durable_publication::PendingWorkflowEvent;
                let key = op["key"].as_str().unwrap_or("");
                let event_id = op["eventId"].as_str().unwrap_or("");
                let evt = PendingWorkflowEvent {
                    key: key.to_string(),
                    event_id: event_id.to_string(),
                    payload: op["payload"].clone(),
                };
                let result: Result<Value, String> = match op["action"].as_str().unwrap_or("enqueue")
                {
                    "enqueue" => outbox
                        .enqueue(key, event_id, &op["payload"])
                        .map(|_| Value::Null),
                    "transition" => outbox
                        .commit_transition_and_events(
                            |db| {
                                db.execute("UPDATE objective SET value = value + 1", [])
                                    .map_err(|error| error.to_string())?;
                                if op["reject"] == true {
                                    return Err("fixture transition failed".into());
                                }
                                Ok(())
                            },
                            &op["events"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .map(PendingWorkflowEvent::from_value)
                                .collect::<Vec<_>>(),
                        )
                        .map(|_| Value::Null),
                    "consume" => inbox
                        .consume(op["consumerId"].as_str().unwrap_or(""), &evt, |db| {
                            db.execute("UPDATE objective SET value = value + 1", [])
                                .map_err(|error| error.to_string())?;
                            if op["reject"] == true {
                                return Err("fixture consumer failed".into());
                            }
                            Ok(())
                        })
                        .map(|accepted| json!(accepted)),
                    "pending" => outbox.pending().map(|items| {
                        json!(items
                            .iter()
                            .map(PendingWorkflowEvent::as_value)
                            .collect::<Vec<_>>())
                    }),
                    "replay" => {
                        let reject = op["rejectAfter"].as_i64().unwrap_or(-1);
                        let mut sent = 0;
                        outbox
                            .replay(|event| {
                                if reject >= 0 && sent >= reject {
                                    return Err("fixture transport failed".into());
                                }
                                let _ = event;
                                sent += 1;
                                Ok(())
                            })
                            .map(|count| json!(count))
                    }
                    "drain" => {
                        let transport = op["transport"].as_str().unwrap_or("both");
                        let bus = transport == "both" || transport == "bus";
                        let emit = transport == "both" || transport == "emit";
                        let fail = op["reject"] == true;
                        agents_relay_rust2::reconciler_workflow_outbox::drain_production_workflow_outbox(
                            Some(&outbox),bus.then_some(move |_event:&PendingWorkflowEvent|if fail{Err("fixture bus failed".into())}else{Ok(())}),
                            emit.then_some(move |_event:&PendingWorkflowEvent|if fail{Err("fixture emit failed".into())}else{Ok(())})
                        ).map(|count|json!(count))
                    }
                    _ => Err("unknown workflow durable operation".into()),
                };
                outputs.push(match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
                // Fixture-only canonical wall clock; actual runtime uses SystemTime.
                // Bucket 3 rowids per timestamp to preserve equal-time key ordering tests.
                if request["canonicalClockBuckets"] == true {
                    db.execute_batch("UPDATE workflow_event_outbox SET created_at=printf('2026-01-01T00:00:%02d.000Z',(rowid-1)/3)")
                        .map_err(|error| error.to_string())?;
                }
            }
            let value: i64 = db
                .query_row("SELECT value FROM objective", [], |row| row.get(0))
                .map_err(|error| error.to_string())?;
            let mut out=db.prepare("SELECT event_key,event_id,payload_json,state FROM workflow_event_outbox ORDER BY event_key").map_err(|error|error.to_string())?;
            let outbox_rows=out.query_map([],|row|Ok(json!({"key":row.get::<_,String>(0)?,"eventId":row.get::<_,String>(1)?,
                "payload":serde_json::from_str::<Value>(&row.get::<_,String>(2)?).unwrap_or(Value::Null),"state":row.get::<_,String>(3)?})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            let mut query=db.prepare("SELECT consumer_id,event_key,event_id,payload_json FROM workflow_event_inbox ORDER BY consumer_id,event_key").map_err(|error|error.to_string())?;
            let receipts=query.query_map([],|row|Ok(json!({"consumerId":row.get::<_,String>(0)?,"key":row.get::<_,String>(1)?,
                "eventId":row.get::<_,String>(2)?,"payload":serde_json::from_str::<Value>(&row.get::<_,String>(3)?).unwrap_or(Value::Null)})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            let _ = params![];
            Ok(
                json!({"outputs":outputs,"value":value,"outbox":outbox_rows,"receipts":receipts})
                    .to_string(),
            )
        }

        "marker" => Ok(json!(agents_relay_rust2::markers::marker(
            request["label"].as_str().unwrap_or(""),
            &request["value"]
        ))
        .to_string()),
        "parseMarker" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::markers::parse_marker(
                request["body"].as_str().unwrap_or(""),
                request["label"].as_str().unwrap_or(""),
            )
            .unwrap_or(Value::Null),
        )),
        "renderJobBody" => Ok(json!(agents_relay_rust2::markers::render_job_body(
            &request["job"]
        ))
        .to_string()),
        "renderJobComment" => Ok(json!(agents_relay_rust2::markers::render_job_comment(
            &request["job"]
        ))
        .to_string()),
        "renderTaskComment" => Ok(json!(agents_relay_rust2::markers::render_task_comment(
            &request["task"]
        ))
        .to_string()),
        "parseJob" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::markers::parse_job(request["body"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null),
        )),
        "parseTask" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::markers::parse_task(request["body"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null),
        )),
        "renderPlanComment" => Ok(json!(agents_relay_rust2::markers::render_plan_comment(
            &request["plan"]
        ))
        .to_string()),
        "parsePlan" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::markers::parse_plan(request["body"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null),
        )),
        "renderAgentComment" => Ok(json!(agents_relay_rust2::markers::render_agent_comment(
            &request["agent"]
        ))
        .to_string()),
        "parseAgent" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::markers::parse_agent(request["body"].as_str().unwrap_or(""))
                .unwrap_or(Value::Null),
        )),

        "parseGitHubWebhook" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::github_webhook::parse_github_webhook(
                &request["headers"],
                request["body"].as_str().unwrap_or("").as_bytes(),
            )
            .unwrap_or(Value::Null),
        )),
        "parsePackagePublicationMarker" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::github_webhook::parse_package_publication_marker(&request["body"])
                .unwrap_or(Value::Null),
        )),
        "parsePackagePublishFailureMarker" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::github_webhook::parse_package_publish_failure_marker(
                &request["body"],
            )
            .unwrap_or(Value::Null),
        )),
        "verifyGitHubWebhook" => Ok(json!(
            agents_relay_rust2::github_webhook::verify_github_webhook(
                request["secret"].as_str().unwrap_or(""),
                request["body"].as_str().unwrap_or("").as_bytes(),
                request["signature"].as_str()
            )
        )
        .to_string()),
        "deliveryDeduperScenario" => {
            let mut deduper = agents_relay_rust2::github_webhook::DeliveryDeduper::new(
                request["ttlMs"].as_i64().unwrap_or(86400000),
                request["maxEntries"].as_u64().unwrap_or(10000) as usize,
            );
            let results = request["operations"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|op| {
                    let id = op["id"].as_str().unwrap_or("");
                    let now = op["now"].as_i64().unwrap_or(0);
                    if op["action"] == "has" {
                        deduper.has(id, now)
                    } else {
                        deduper.accept(id, now)
                    }
                })
                .collect::<Vec<_>>();
            Ok(json!(results).to_string())
        }

        "actionLedgerScenario" => {
            use rusqlite::{params, Connection};
            let db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch(
                "CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);",
            )
            .map_err(|error| error.to_string())?;
            for entry in request["jobs"].as_array().into_iter().flatten() {
                db.execute(
                    "INSERT INTO job_snapshot VALUES(?,?)",
                    params![entry["id"].as_str(), entry["value"].to_string()],
                )
                .map_err(|error| error.to_string())?;
            }
            let ledger =
                agents_relay_rust2::workflow::action_ledger::WorkflowActionLedger::new(&db)?;
            let mut outputs = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                let result: Result<Value, String> = match op["action"].as_str().unwrap_or("reserve")
                {
                    "reserve" => ledger
                        .reserve(
                            &op["identity"],
                            &op["decision"],
                            op["conditionId"].as_str().unwrap_or(""),
                        )
                        .map(|inserted| json!(inserted)),
                    "running" => ledger
                        .reserve_for_running_task(
                            &op["identity"],
                            &op["decision"],
                            op["conditionId"].as_str().unwrap_or(""),
                            op["now"].as_str().unwrap_or(""),
                            op["allowedState"].as_str().unwrap_or("RUNNING"),
                        )
                        .map(|inserted| json!(inserted)),
                    "dispatch" => ledger
                        .reserve_for_claimed_dispatch(
                            &op["identity"],
                            &op["decision"],
                            op["conditionId"].as_str().unwrap_or(""),
                        )
                        .map(|inserted| json!(inserted)),
                    "trace" => ledger
                        .trace(op["attemptKey"].as_str().unwrap_or(""))
                        .map(|trace| trace.unwrap_or(Value::Null)),
                    "verify" => {
                        let specs = op["conditions"].as_array().cloned().unwrap_or_default();
                        let conditions =
                            agents_relay_rust2::workflow::conditions::ConditionRegistry::new(
                                specs,
                            )?;
                        ledger.verify(
                            op["attemptKey"].as_str().unwrap_or(""),
                            &conditions,
                            &op["facts"],
                        )
                    }
                    _ => Err("unknown action ledger operation".into()),
                };
                outputs.push(match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            let mut query=db.prepare("SELECT attempt_key,execution_id,generation,graph,action_id,condition_id,outcome FROM workflow_action_trace ORDER BY attempt_key").map_err(|error|error.to_string())?;
            let traces=query.query_map([],|row|Ok(json!({"attemptKey":row.get::<_,String>(0)?,"executionId":row.get::<_,String>(1)?,
                "generation":row.get::<_,i64>(2)?,"graph":row.get::<_,String>(3)?,"actionId":row.get::<_,String>(4)?,
                "conditionId":row.get::<_,String>(5)?,"outcome":row.get::<_,String>(6)?})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            Ok(agents_relay_rust2::observability::json_wire(
                &json!({"outputs":outputs,"traces":traces}),
            ))
        }

        "taskExecutionContext" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::task_context::task_execution_context(
                &request["job"],
                request["taskId"].as_str().unwrap_or(""),
                request["executionId"].as_str().unwrap_or(""),
            )?,
        )),
        "taskAgentHistoryContext" => Ok(json!(
            agents_relay_rust2::task_context::task_agent_history_context(
                &request["job"],
                &request["task"]
            )
        )
        .to_string()),
        "taskReferencePrompt" => Ok(json!(
            agents_relay_rust2::task_context::task_reference_prompt(
                request["repository"].as_str().unwrap_or(""),
                request["jobId"].as_str().unwrap_or(""),
                request["taskId"].as_str().unwrap_or(""),
                request["executionId"].as_str().unwrap_or(""),
                request["managedInput"].as_str()
            )?
        )
        .to_string()),
        "publicationStoreScenario" => {
            use rusqlite::Connection;
            let mut db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch("CREATE TABLE publication_state(job_id TEXT PRIMARY KEY,json TEXT NOT NULL); CREATE TABLE publication_delivery (job_id TEXT NOT NULL, delivery_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,observed_at TEXT NOT NULL, PRIMARY KEY(job_id,delivery_id));").map_err(|error|error.to_string())?;
            let mut operations = Vec::new();
            for op in request["operations"].as_array().into_iter().flatten() {
                let id = op["jobId"].as_str().unwrap_or("");
                let result:Result<Value,String>=match op["action"].as_str().unwrap_or("record"){
                    "load"=>agents_relay_rust2::publication_store::load_publication_from_database(&db,id).map(|result|result.unwrap_or(Value::Null)),
                    "list"=>agents_relay_rust2::publication_store::list_publication_events_from_database(&db,id).map(|items|json!(items)),
                    _=>agents_relay_rust2::publication_store::record_publication_in_database(&mut db,id,
                        op["deliveryId"].as_str().unwrap_or(""),op.get("publication").filter(|value|!value.is_null()),
                        op.get("failure").filter(|value|!value.is_null()),op["observedAt"].as_str()).map(|ok|json!(ok))
                };
                operations.push(match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            let mut state_query = db
                .prepare("SELECT job_id,json FROM publication_state ORDER BY job_id")
                .map_err(|error| error.to_string())?;
            let states = state_query
                .query_map([], |row| {
                    Ok(json!({"jobId":row.get::<_,String>(0)?,"json":row.get::<_,String>(1)?}))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            let mut deliveries_query=db.prepare("SELECT job_id,delivery_id,type,json,observed_at FROM publication_delivery ORDER BY job_id,delivery_id").map_err(|error|error.to_string())?;
            let deliveries=deliveries_query.query_map([],|row|Ok(json!({"jobId":row.get::<_,String>(0)?,"deliveryId":row.get::<_,String>(1)?,
                "type":row.get::<_,String>(2)?,"json":row.get::<_,String>(3)?,"observedAt":row.get::<_,String>(4)?})))
                .map_err(|error|error.to_string())?.collect::<Result<Vec<_>,_>>().map_err(|error|error.to_string())?;
            Ok(agents_relay_rust2::observability::json_wire(
                &json!({"operations":operations,"states":states,"deliveries":deliveries}),
            ))
        }

        "mergeInboundJobSnapshot" => Ok(agents_relay_rust2::observability::json_wire(
            &agents_relay_rust2::relay_job_merge::merge_inbound_job_snapshot(
                &request["local"],
                &request["remote"],
            ),
        )),
        "sameTaskDefinition" => Ok(json!(
            agents_relay_rust2::store_task_definition::same_task_definition(
                &request["left"],
                &request["right"]
            )
        )
        .to_string()),
        "samePlanDefinition" => Ok(json!(
            agents_relay_rust2::store_task_definition::same_plan_definition(
                &request["left"],
                &request["right"]
            )
        )
        .to_string()),
        "taskDefinitionDivergence" => Ok(json!(
            agents_relay_rust2::store_task_definition::task_definition_divergence(
                &request["left"],
                &request["right"]
            )
        )
        .to_string()),
        "planDefinitionDivergence" => Ok(json!(
            agents_relay_rust2::store_task_definition::plan_definition_divergence(
                &request["left"],
                &request["right"]
            )
        )
        .to_string()),
        "divergingDefinitionFields" => Ok(json!(
            agents_relay_rust2::store_task_definition::diverging_definition_fields(
                request["kind"].as_str().unwrap_or("task"),
                &request["left"],
                &request["right"]
            )
        )
        .to_string()),
        "isTaskForJob" => Ok(
            json!(agents_relay_rust2::store_task_definition::is_task_for_job(
                &request["task"],
                request["jobId"].as_str().unwrap_or(""),
                request["soleTrustedJob"].as_bool().unwrap_or(false)
            ))
            .to_string(),
        ),
        "isDurableDefinitionConflict" => Ok(json!(
            agents_relay_rust2::store_task_definition::is_durable_definition_conflict(
                &request["error"]
            )
        )
        .to_string()),
        "relayCreateScenario" => {
            use rusqlite::{params, Connection};
            let mut db = Connection::open_in_memory().map_err(|error| error.to_string())?;
            db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);").map_err(|error|error.to_string())?;
            for row in request["existing"].as_array().into_iter().flatten() {
                db.execute(
                    "INSERT INTO job_snapshot VALUES(?,?,?)",
                    params![row["jobId"].as_str(), row["json"].as_str(), "preexisting"],
                )
                .map_err(|error| error.to_string())?;
            }
            let mut results = Vec::new();
            for job in request["jobs"].as_array().into_iter().flatten() {
                let result = agents_relay_rust2::relay_create::create_job_if_absent(&mut db, job);
                results.push(match result {
                    Ok(value) => json!({"ok":true,"value":value}),
                    Err(error) => json!({"ok":false,"error":error}),
                });
            }
            let mut query = db
                .prepare("SELECT job_id,json FROM job_snapshot ORDER BY job_id")
                .map_err(|error| error.to_string())?;
            let rows = query
                .query_map([], |row| {
                    Ok(json!({"jobId":row.get::<_,String>(0)?,"json":row.get::<_,String>(1)?}))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            Ok(agents_relay_rust2::observability::json_wire(
                &json!({"results":results,"rows":rows}),
            ))
        }

        "runtimeStatusPublisherScenario" => {
            use std::{cell::RefCell, rc::Rc};
            let events = Rc::new(RefCell::new(Vec::<Value>::new()));
            let sink = Rc::clone(&events);
            let mut publisher =
                agents_relay_rust2::runtime_status_events::create_runtime_status_publisher(
                    move |event| {
                        sink.borrow_mut().push(event);
                        Ok(())
                    },
                );
            for job in request["jobs"].as_array().into_iter().flatten() {
                publisher.publish(job);
            }
            let output = events.borrow().clone();
            Ok(json!(output).to_string())
        }

        "summarizeRuntime" => Ok(agents_relay_rust2::runtime_summary::summarize_runtime(
            &request["jobs"].as_array().cloned().unwrap_or_default(),
            request["now"].as_i64().unwrap_or(0),
        )
        .to_string()),
        "runtimeHasLiveExecution" => Ok(json!(
            agents_relay_rust2::runtime_summary::has_live_execution(
                &request["job"],
                &request["task"],
                request["now"].as_i64().unwrap_or(0)
            )
        )
        .to_string()),
        "runtimeRunningWorker" => Ok(json!(agents_relay_rust2::runtime_summary::running_worker(
            &request["task"]
        ))
        .to_string()),

        "runtimeStatusIsSuperseded" => {
            let mut map = std::collections::HashMap::<String, Value>::new();
            for task in request["tasks"].as_array().into_iter().flatten() {
                if let Some(id) = task["id"].as_str() {
                    map.insert(id.to_string(), task.clone());
                }
            }
            Ok(json!(agents_relay_rust2::runtime_status::is_superseded(
                &request["task"],
                &map
            ))
            .to_string())
        }
        "runtimeImplementationTasks" => Ok(json!(
            agents_relay_rust2::runtime_status::implementation_tasks(&request["job"])
        )
        .to_string()),
        "runtimeImplementationComplete" => Ok(json!(
            agents_relay_rust2::runtime_status::implementation_complete(&request["job"])
        )
        .to_string()),
        "deriveJobRuntimeStatus" => Ok(json!(
            agents_relay_rust2::runtime_status::derive_job_runtime_status(
                &request["job"],
                request["prState"].as_str().unwrap_or("OPEN")
            )
        )
        .to_string()),

        "cliUsage" => Ok(json!(agents_relay_rust2::cli_help::CLI_USAGE).to_string()),
        "helpText" => Ok(json!(agents_relay_rust2::cli_help::help_text(
            request["command"].as_str(),
            request["action"].as_str()
        ))
        .to_string()),
        "archiveDisplayPullRequestScenario" => {
            use agents_relay_rust2::github_pr_archive::{
                archive_display_pull_request, GitHubRequestCallback, GitHubRequestFuture,
            };
            use std::{
                future::Future,
                pin::pin,
                sync::{Arc, Mutex},
                task::{Context, Poll, Waker},
            };
            let trace = Arc::new(Mutex::new(Vec::<Value>::new()));
            let out = Arc::clone(&trace);
            let comments = request["comments"].clone();
            let fail_at = request["failAt"].as_str().map(str::to_string);
            let error = request["error"]
                .as_str()
                .unwrap_or("injected GitHub failure")
                .to_string();
            let mut client = move |path: String, options: Option<Value>| -> GitHubRequestFuture {
                let method = options
                    .as_ref()
                    .and_then(|value| value.get("method"))
                    .and_then(Value::as_str)
                    .unwrap_or("GET")
                    .to_string();
                out.lock()
                    .expect("archive trace mutex")
                    .push(json!({"path":path,"options":options}));
                let fails = fail_at.as_deref()
                    == Some(match method.as_str() {
                        "POST" => "post",
                        "PATCH" => "patch",
                        _ => "list",
                    });
                let error = error.clone();
                let result = if fails {
                    Err(error)
                } else if method == "GET" {
                    Ok(comments.clone())
                } else {
                    Ok(json!({"status":"ok"}))
                };
                Box::pin(async move { result })
            };
            let work = archive_display_pull_request(
                &mut client as &mut GitHubRequestCallback,
                request["repository"].as_str().unwrap_or(""),
                request["number"].as_i64().unwrap_or(0),
                request["jobId"].as_str().unwrap_or(""),
                request["publishedSha"].as_str().unwrap_or(""),
                request["state"].as_str().unwrap_or(""),
            );
            let mut work = pin!(work);
            let mut cx = Context::from_waker(Waker::noop());
            let result = loop {
                if let Poll::Ready(value) = work.as_mut().poll(&mut cx) {
                    break value;
                }
            };
            let trace = trace.lock().expect("archive trace mutex").clone();
            Ok(json!({"result":match result {Ok(outcome)=>json!({"ok":true,"value":outcome}),Err(error)=>json!({"ok":false,"error":error})},"trace":trace}).to_string())
        }

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
