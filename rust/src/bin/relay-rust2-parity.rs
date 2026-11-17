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

fn invoke(request: &Value) -> Result<String, String> {
    let op = request["op"].as_str().ok_or("missing op")?;
    match op {
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
