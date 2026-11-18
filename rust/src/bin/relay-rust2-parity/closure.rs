// Node provenance: src/usage.ts, src/cli-support.ts, src/local-authority-store.ts
// and src/projected-store.ts. Isolated real Node/Rust differential fixtures;
// no production Service, provider command, account or live Job is accessed.
use serde_json::{json,Value};

pub(super) fn invoke(request:&Value)->Result<Option<String>,String>{
    let op=request["op"].as_str().unwrap_or("");
    let result:Result<String,String>=match op{
        // Real temporary local Git repositories: no network, external PR,
        // force reset or Job effects are allowed by this parity fixture.
        "workspaceManagedParity"=>{
            let result=agents_relay_rust2::workspace::prepare_managed_execution_worktree(
                std::path::Path::new(request["projectPath"].as_str().ok_or("projectPath required")?),
                request["repository"].as_str().ok_or("repository required")?,
                request["prNumber"].as_u64().ok_or("prNumber required")?,
                &request["head"],"ignored",
                std::path::Path::new(request["workspaceRoot"].as_str().ok_or("workspaceRoot required")?),
            );
            Ok(json!({"outcome":match result{
                Ok(path)=>json!({"ok":true,"value":path.to_string_lossy()}),
                Err(error)=>json!({"ok":false,"error":error}),
            }}).to_string())
        }
        // Direct Node HostInteractiveInvocationCoordinator + hostInvocationPorts
        // through real temporary SQLite and the canonical interactive Graph.
        "hostInvocationPortsScenario"=>{
            use agents_relay_rust2::{
                relay_store::SQLiteRelayStore,
                interactive_invocation::HostInteractiveInvocationCoordinator,
                interactive_invocation_ports::host_invocation_ports,
            };
            let mut store=SQLiteRelayStore::open(std::path::Path::new(":memory:"),None)?;
            store.save_job(&request["job"])?;
            let mut coordinator=HostInteractiveInvocationCoordinator::default();
            let graph=std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
            let mut decisions=Vec::new();
            let mut callback_count=0usize;
            let mut events=Vec::new();
            let mut ports=host_invocation_ports(&mut store);
            for event in request["events"].as_array().ok_or("events required")? {
                let outcome=coordinator.apply_event(&mut ports,&graph,event,
                    |_,_|{callback_count+=1;Ok(())},
                    |accepted|{events.push(accepted.clone());Ok(())});
                decisions.push(match outcome{
                    Ok(value)=>json!({"ok":true,"value":value}),
                    Err(error)=>json!({"ok":false,"error":error}),
                });
            }
            let job=ports.load_job(request["job"]["id"].as_str().unwrap_or(""))?
                .ok_or("snapshot disappeared")?;
            Ok(json!({"decisions":decisions,"callbacks":callback_count,
                "events":events,"task":job["tasks"][0]}).to_string())
        }
        // Public PlannerTaskSpec and CommandObjectivePlanner effects.
        // Runner is injected and never invokes a real Codex executable.
        "plannerPublicPorts"=>{
            use agents_relay_rust2::planner::{planning_spec,CommandObjectivePlanner};
            let method=request["method"].as_str().unwrap_or("");
            let result=match method{
                "planningSpec"=>planning_spec(&request["task"]),
                "command"=>{
                    let command=request["command"].as_str().unwrap_or("");
                    let planner=CommandObjectivePlanner::new(command)?;
                    planner.plan(&request["context"],|actual,stdin|{
                        if stdin.trim().is_empty(){return Err("Planner stdin missing".into());}
                        if actual!=command{return Err("Wrong Planner executable".into());}
                        Ok(agents_relay_rust2::planner_adapters::PlannerProcessResult{
                            exit_code:request["exitCode"].as_i64().unwrap_or(0) as i32,
                            stdout:request["stdout"].as_str().unwrap_or("").into(),
                            stderr:request["stderr"].as_str().unwrap_or("").into(),
                        })
                    })
                },
                _=>Err("Unknown Planner method".into()),
            };
            Ok(json!({"outcome":match result{
                Ok(value)=>json!({"ok":true,"value":value}),
                Err(error)=>json!({"ok":false,"error":error}),
            }}).to_string())
        }
        // Node model-routing.ts, worker-routing.ts and execution-routing.ts
        // public entrypoints using the original Rust policy/eligibility paths.
        // Choices are injected; a CLI/model receipt cannot bypass hard gates.
        "routeFacade"=>{
            let candidates=request["candidates"].as_array().ok_or("candidates required")?;
            let requirements=&request["requirements"];
            let options=&request["options"];
            let proposed=request["choice"].as_str();
            let evidence=request.get("evidence").filter(|v|!v.is_null());
            let policy=request["policyPath"].as_str().unwrap_or("");
            let rules=request["rulesPath"].as_str().unwrap_or("");
            let result=match request["kind"].as_str().unwrap_or(""){
                "worker"=>agents_relay_rust2::worker_routing::route_worker(
                    candidates,requirements,options,proposed,evidence),
                "model"=>agents_relay_rust2::model_routing::route_model(
                    &request["worker"],candidates,options,policy,rules,
                    proposed,evidence,None),
                "execution"=>agents_relay_rust2::execution_routing::route_execution(
                    candidates,requirements,options,
                    std::path::Path::new(request["home"].as_str().unwrap_or("")),
                    std::path::Path::new(policy),std::path::Path::new(rules),
                    request["nowMs"].as_i64().unwrap_or(0),proposed,
                    evidence.cloned(),
                    request["recentOutcomes"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                    None),
                _=>Err("Unknown routing facade".into()),
            };
            Ok(json!({"outcome":match result {
                Ok(mut result)=>{
                    for path in ["routing","candidate.routing"]{
                        if let Some(route)=if path=="routing"{result.get_mut("routing")}
                            else{result.pointer_mut("/candidate/routing")} {
                            if route.get("decidedAt").is_some(){route["decidedAt"]=json!("NORMALIZED");}
                            if route.get("decisionId").is_some(){route["decisionId"]=json!("NORMALIZED");}
                        }
                    }
                    if result.pointer("/selection/selectedAt").is_some(){
                        result["selection"]["selectedAt"]=json!("NORMALIZED");
                    }
                    if result.get("audit").is_some(){result["audit"]=Value::Null;}
                    json!({"ok":true,"value":result})
                },
                Err(error)=>json!({"ok":false,"error":error}),
            }}).to_string())
        }
        // Original Node adapters.ts WebHelm readiness: argv, late JSON,
        // platform validation and daemon running truth are all observable.
        "webhelmReadyParity"=>{
            let mut calls=Vec::<String>::new();
            let outcome=agents_relay_rust2::adapters::ensure_chat_gpt_webhelm_ready(|argv|{
                calls.push(argv.join(" "));
                Ok(if argv.first()==Some(&"platform") {
                    request["profileOutput"].as_str().unwrap_or("")
                }else{request["statusOutput"].as_str().unwrap_or("")}.into())
            });
            Ok(json!({"calls":calls,"outcome":match outcome{
                Ok(())=>json!({"ok":true}),
                Err(error)=>json!({"ok":false,"error":error})
            }}).to_string())
        }
        // Node ProjectedDurableStore.comments: call actual GitHubStore
        // GraphQL pagination/cache/seed through injected offline API.
        "projectedGithubComments"=>{
            use agents_relay_rust2::{
                projected_store::ProjectedDurableStore,
                relay_store::SQLiteRelayStore,
                store_github::{GitHubApi,GitHubStore},
            };
            use std::sync::{Arc,atomic::{AtomicUsize,Ordering}};
            struct FakeApi{pages:Vec<Value>,calls:Arc<AtomicUsize>}
            impl GitHubApi for FakeApi{
                fn graphql(&mut self,_query:&str,_variables:&Value)->Result<Value,String>{
                    let index=self.calls.fetch_add(1,Ordering::SeqCst);
                    self.pages.get(index).cloned()
                        .ok_or("GraphQL fixture exhausted".into())
                }
                fn request(&mut self,_path:&str,_method:&str,_body:Option<&Value>)
                    ->Result<Value,String>{Err("Unexpected REST write".into())}
            }
            let calls=Arc::new(AtomicUsize::new(0));
            let pages=request["pages"].as_array().cloned().unwrap_or_default();
            let github=GitHubStore::new(
                FakeApi{pages,calls:Arc::clone(&calls)},
                request["repository"].as_str().unwrap_or("owner/repo"),
                request["prNumber"].as_u64().unwrap_or(1),
                Default::default(),request.get("seed").filter(|v|!v.is_null()));
            let relay=SQLiteRelayStore::open(std::path::Path::new(":memory:"),None)?;
            let mut projected=ProjectedDurableStore::new(relay,None)
                .with_github_store(github);
            let count=request["readCount"].as_u64().unwrap_or(1).min(3);
            let mut outcomes=Vec::new();
            for _ in 0..count {
                outcomes.push(match projected.comments(){
                    Ok(comments)=>json!({"ok":true,"value":comments}),
                    Err(error)=>json!({"ok":false,"error":error}),
                });
            }
            Ok(json!({"outcomes":outcomes,
                "calls":calls.load(Ordering::SeqCst)}).to_string())
        }
        // Node src/usage.ts CodexApiUsageReader: launch an owned *injected*
        // fake app-server only, send JSON-RPC 1+2 and read id=2 quota.
        "codexApiUsage"=>{
            use agents_relay_rust2::usage::CodexApiUsageReader;
            let command=request["command"].as_str().ok_or("command required")?;
            let clock=request["clock"].as_str().ok_or("clock required")?.to_string();
            let reader=CodexApiUsageReader::with_command_and_clock(
                command,move||clock.clone());
            Ok(reader.read().to_string())
        }
        // Node src/usage.ts public observer reader interfaces. All cases use
        // disposable source fixtures or unconfigured keys, never real providers.
        "usageReaderSurface" => {
            use agents_relay_rust2::usage::{
                BrowserWorkspaceUsageReader,CodexSessionUsageReader,
                ZaiUsageReader,DeepSeekCreditReader,OpenRouterCreditReader,
            };
            let mut results=Vec::new();
            let count=request["count"].as_u64().unwrap_or(1).min(8);
            match request["kind"].as_str().unwrap_or("") {
                "codex-session"=>{
                    let home=request["home"].as_str().ok_or("home required")?;
                    let now=request["nowMs"].as_i64().ok_or("nowMs required")?;
                    let reader=CodexSessionUsageReader::with_clock(
                        Some(std::path::Path::new(home)),Some(8),Some(10_000),move||now);
                    for _ in 0..count{results.push(reader.read());}
                },
                "browser"=>{
                    let command=request["command"].as_str().ok_or("command required")?;
                    let reader=BrowserWorkspaceUsageReader::new(
                        Some(std::path::Path::new(command)),Some(3000));
                    for _ in 0..count{results.push(reader.read());}
                },
                "zai"=>{
                    let reader=ZaiUsageReader::new(Some(""));
                    for _ in 0..count{results.push(reader.read());}
                },
                "deepseek"=>{
                    let reader=DeepSeekCreditReader::new(Some(""));
                    for _ in 0..count{results.push(reader.read());}
                },
                "openrouter"=>{
                    let reader=OpenRouterCreditReader::new(Some(""));
                    for _ in 0..count{results.push(reader.read());}
                },
                _=>return Err("Unknown usage reader".into()),
            }
            for result in &mut results{
                for timestamp in ["generatedAt","observedAt"] {
                    if result.get(timestamp).is_some(){result[timestamp]=json!("NORMALIZED");}
                }
            }
            Ok(json!(results).to_string())
        }
        // Node usage.ts: concurrent usage snapshot aggregation and injected
        // unavailable reader; no command or network providers in fixtures.
        "usageRegistryScenario" => {
            use agents_relay_rust2::usage::{
                UsageReader,UsageRegistry,read_usage_snapshot,UnavailableUsageReader,
            };
            struct FixedReader{value:Value}
            impl UsageReader for FixedReader{
                fn read(&self)->Result<Value,String>{
                    if let Some(error)=self.value.get("error").and_then(Value::as_str){
                        return Err(error.into());
                    }
                    Ok(self.value.clone())
                }
            }
            let box_reader=|value:&Value|->Box<dyn UsageReader>{
                Box::new(FixedReader{value:value.clone()})
            };
            if request["method"]=="unavailable"{
                let reason=request["reason"].as_str().unwrap_or("");
                let clock=request["clock"].as_str().unwrap_or("").to_owned();
                let reader=UnavailableUsageReader::with_now(reason,
                    move ||clock.clone());
                return Ok(Some(reader.read().to_string()));
            }
            let deepseek=request.get("deepseek").filter(|v|!v.is_null()).map(&box_reader);
            let openrouter=request.get("openrouter").filter(|v|!v.is_null()).map(&box_reader);
            let browser=request.get("browser").filter(|v|!v.is_null()).map(&box_reader);
            let registry=UsageRegistry::with_now(
                box_reader(&request["openai"]),box_reader(&request["zai"]),
                deepseek,openrouter,browser,||"NORMALIZED".into(),
            );
            if request["method"]=="readUsageSnapshot"{
                Ok(read_usage_snapshot(&registry)?.to_string())
            }else{Ok(registry.snapshot()?.to_string())}
        }
        // Node cli-support.ts publishes Graph-selected wake observations;
        // capture exact event shape and enforce no-bus reconciliation failure.
        "cliSupportEventPublishing" => {
            use agents_relay_rust2::{
                cli_support::{publish_wake,publish_task_unblocked,publish_task_blocked,
                    publish_dependent_unblocked,request_managed_reconciliation},
                events::{MemoryEventBus,Wake},
            };
            let bus=MemoryEventBus::new();
            let observed=std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
            let received=std::sync::Arc::clone(&observed);
            let wake:Wake=std::sync::Arc::new(move |event|{
                let mut normalized=event.clone();
                normalized["event_id"]=json!("NORMALIZED");
                normalized["timestamp"]=json!("NORMALIZED");
                received.lock().map_err(|e|e.to_string())?.push(normalized);
                Ok(())
            });
            let _unsubscribe=bus.subscribe_all(wake);
            let mut receipts=Vec::new();
            for action in request["actions"].as_array().ok_or("actions required")? {
                let job=&action["job"];
                let task=action["taskId"].as_str().unwrap_or("");
                let reason=action["reason"].as_str().unwrap_or("");
                match action["method"].as_str().unwrap_or(""){
                    "wake"=>publish_wake(Some(&bus),job,task,
                        action["message"].as_str().unwrap_or("")),
                    "unblock"=>publish_task_unblocked(Some(&bus),job,task,reason),
                    "block"=>publish_task_blocked(Some(&bus),job,task,reason,action.get("extra")),
                    "dependent"=>publish_dependent_unblocked(Some(&bus),
                        action["targets"].as_array().map(Vec::as_slice).unwrap_or(&[]),reason),
                    "none"=>publish_wake(None,job,task,
                        action["message"].as_str().unwrap_or("")),
                    "require"|"requireNone"=>{
                        let outcome=request_managed_reconciliation(
                            if action["method"]=="require"{Some(&bus)}else{None},job);
                        receipts.push(match outcome{
                            Ok(())=>json!({"ok":true}),
                            Err(error)=>json!({"ok":false,"error":error}),
                        });
                    },
                    _=>return Err("Unknown publishing action".into()),
                }
            }
            let events=observed.lock().map_err(|e|e.to_string())?.clone();
            Ok(json!({"events":events,"receipts":receipts}).to_string())
        }
        // ServiceEventBus subscription lifetime: in-memory original Node
        // and native Rust event buses, without touching NATS or Job state.
        "serviceEventBusScenario" => {
            use agents_relay_rust2::{
                cli_support::{ServiceEventBus,ServiceSubscription},
                events::{MemoryEventBus,Wake},
            };
            let bus=ServiceEventBus::new(MemoryEventBus::new());
            let observed=std::sync::Arc::new(std::sync::Mutex::new(Vec::<Value>::new()));
            let mut subscriptions=Vec::<Option<ServiceSubscription>>::new();
            for action in request["actions"].as_array().ok_or("actions required")? {
                match action["method"].as_str().unwrap_or("") {
                    "subscribe"|"subscribeAll"=>{
                        let label=action["label"].as_str().unwrap_or("").to_string();
                        let captured=std::sync::Arc::clone(&observed);
                        let wake:Wake=std::sync::Arc::new(move |event|{
                            captured.lock().map_err(|e|e.to_string())?.push(json!({
                                "label":label,"jobId":event["job_id"],
                                "type":event["type"]
                            }));Ok(())
                        });
                        let subscription=if action["method"]=="subscribeAll" {
                            bus.subscribe_all(wake)?
                        }else{
                            bus.subscribe(action["jobId"].as_str().unwrap_or(""),wake)?
                        };
                        subscriptions.push(Some(subscription));
                    },
                    "publish"=>bus.publish(&action["event"])?,
                    "unsubscribe"=>{
                        if let Some(entry)=subscriptions.get_mut(
                            action["index"].as_u64().unwrap_or(u64::MAX) as usize){
                            if let Some(subscription)=entry.take(){subscription.unsubscribe();}
                        }
                    },
                    "close"=>bus.close()?,
                    _=>return Err("Unknown service event bus action".into()),
                }
            }
            let trace=observed.lock().map_err(|e|e.to_string())?.clone();
            Ok(json!(trace).to_string())
        }
        // Node src/local-authority-store.ts and src/projected-store.ts:
        // isolated real in-memory SQLite DurableStore delegation. Each action
        // mutates one Store and the next action reads that same durable truth.
        "storeFacadeDelegation" => {
            use agents_relay_rust2::{
                local_authority_store::LocalAuthorityDurableStore,
                projected_store::ProjectedDurableStore,
                relay_store::SQLiteRelayStore,
            };
            let relay=SQLiteRelayStore::open(std::path::Path::new(":memory:"),None)?;
            let variant=request["variant"].as_str().unwrap_or("");
            let operations=request["actions"].as_array().ok_or("actions required")?;
            let mut outcomes=Vec::<Value>::new();
            if variant=="local" {
                let local=LocalAuthorityDurableStore::new(relay,false);
                for action in operations {
                    let result:Result<Value,String>=match action["method"].as_str().unwrap_or("") {
                        "saveJob"=>local.save_job(&action["job"]).map(|_|Value::Null),
                        "load"=>local.load(action["id"].as_str().unwrap_or("")).map(|v|v),
                        "pendingProjectionCount"=>local.authority.pending_projection_count().map(|v|json!(v)),
                        "saveAgent"=>local.save_agent(&action["agent"]).map(|_|Value::Null),
                        "listAgents"=>local.list_agents().map(|v|json!(v)),
                        "applyPullRequestFacts"=>local.apply_pull_request_facts(&action["facts"]).map(|_|Value::Null),
                        "pullRequestState"=>local.pull_request_state().map(|v|json!(v)),
                        "pullRequestHead"=>local.pull_request_head().map(|v|json!(v)),
                        "recordExecutionProcess"=>local.record_execution_process(&action["record"]).map(|_|Value::Null),
                        "loadExecutionProcess"=>local.load_execution_process(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["executionId"].as_str().unwrap_or("")
                        ).map(|v|json!(v)),
                        "finishExecutionProcess"=>local.finish_execution_process(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["executionId"].as_str().unwrap_or("")
                        ).map(|_|Value::Null),
                        "hasHostInvocationDecision"=>local.has_host_invocation_decision(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["invocationId"].as_str().unwrap_or(""),
                            action["fingerprint"].as_str(),
                        ).map(|v|json!(v)),
                        "recordHostInvocationEvent"=>local.record_host_invocation_event(
                            &action["delivery"],action["outcome"].as_str().unwrap_or(""),
                            action["fingerprint"].as_str().unwrap_or("")
                        ).map(|_|Value::Null),
                        "verifyWorkflowLaunch"=>local.verify_workflow_launch(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["executionId"].as_str().unwrap_or("")
                        ).map(|v|json!(v)),
                        "reserveWorkflowLaunch"=>local.reserve_workflow_launch(&action["identity"])
                            .map(|v|json!(v)),
                        _=>Err("Unknown local Store action".into()),
                    };
                    // Preserve failures as observable responses and keep the
                    // original SQLite connection for recovery/idempotency cases.
                    outcomes.push(match result {
                        Ok(mut v)=>{if action["method"]=="loadExecutionProcess" && v.is_object() && v["endedAt"].is_string(){v["endedAt"]=json!("SET");}json!({"ok":true,"value":v})},
                        Err(error)=>json!({"ok":false,"error":error}),
                    });
                }
            }else if variant=="projected" {
                let projected=ProjectedDurableStore::new(relay,None);
                for action in operations {
                    let result:Result<Value,String>=match action["method"].as_str().unwrap_or("") {
                        "saveJob"=>projected.save_job(&action["job"]).map(|_|Value::Null),
                        "load"=>projected.load(action["id"].as_str().unwrap_or(""),
                            |_|Err("remote unavailable in isolated fixture".into())),
                        "pendingProjectionCount"=>projected.relay.pending_projection_count().map(|v|json!(v)),
                        "saveAgent"=>projected.save_agent_with_remote(&action["agent"],
                            ||Ok(Vec::new())).map(|_|Value::Null),
                        "listAgents"=>projected.list_agents_with_remote(||Ok(Vec::new())).map(|v|json!(v)),
                        "applyPullRequestFacts"=>projected.apply_pull_request_facts(&action["facts"]).map(|_|Value::Null),
                        "pullRequestState"=>projected.pull_request_state().map(|v|json!(v)),
                        "pullRequestHead"=>projected.pull_request_head().map(|v|json!(v)),
                        "recordExecutionProcess"=>projected.record_execution_process(&action["record"]).map(|_|Value::Null),
                        "loadExecutionProcess"=>projected.load_execution_process(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["executionId"].as_str().unwrap_or("")
                        ).map(|v|json!(v)),
                        "finishExecutionProcess"=>projected.finish_execution_process(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["executionId"].as_str().unwrap_or("")
                        ).map(|_|Value::Null),
                        "markEventProcessed"=>projected.mark_event_processed(
                            action["eventId"].as_str().unwrap_or(""),
                            action["stream"].as_str(),action["sequence"].as_i64()
                        ).map(|v|json!(v)),
                        "hasHostInvocationDecision"=>projected.has_host_invocation_decision(
                            action["jobId"].as_str().unwrap_or(""),
                            action["taskId"].as_str().unwrap_or(""),
                            action["invocationId"].as_str().unwrap_or(""),
                            action["fingerprint"].as_str(),
                        ).map(|v|json!(v)),
                        "recordHostInvocationEvent"=>projected.record_host_invocation_event(
                            &action["delivery"],action["outcome"].as_str().unwrap_or(""),
                            action["fingerprint"].as_str().unwrap_or("")
                        ).map(|_|Value::Null),
                        _=>Err("Unknown projected Store action".into()),
                    };
                    outcomes.push(match result {
                        Ok(mut v)=>{if action["method"]=="loadExecutionProcess"&&v.is_object()&&v["endedAt"].is_string(){v["endedAt"]=json!("SET");}json!({"ok":true,"value":v})},
                        Err(error)=>json!({"ok":false,"error":error}),
                    });
                }
            }else{return Err("Unknown Store variant".into());}
            Ok(json!(outcomes).to_string())
        }
        // Node src/cli-support.ts: deterministic CLI option and error parity.
        "cliSupportPure" => {
            use agents_relay_rust2::cli_support as cli;
            let args=request["args"].as_array().ok_or("args required")?
                .iter().filter_map(Value::as_str).map(str::to_owned)
                .collect::<Vec<_>>();
            let fallback=request["fallback"].as_str().unwrap_or("");
            let value=match request["method"].as_str().unwrap_or("") {
                "defaults"=>json!(cli::SERVICE_DEFAULTS),
                "arg"=>json!(cli::arg(&args,request["flag"].as_str().unwrap_or(""),fallback)),
                "hasArg"=>json!(cli::has_arg(&args,request["flag"].as_str().unwrap_or(""))),
                "priority"=>json!(cli::priority(&args,request["fallback"].as_str().unwrap_or("P2"))?),
                "storySize"=>json!(cli::story_size(&args,request["fallback"].as_str().unwrap_or("M"))?),
                "chatGptTabClosePolicy"=>json!(cli::chatgpt_tab_close_policy(&args,request["env"].as_str())?),
                "jobTagFromArgs"=>cli::job_tag_from_args(&args)?,
                "continuation"=>cli::continuation(&args),
                "rejectRemovedJobOptions"=>{cli::reject_removed_job_options(&args)?;Value::Null},
                "rejectRemoteLifecycleOptions"=>{cli::reject_remote_lifecycle_options(&args)?;Value::Null},
                "integerArg"=>json!(cli::integer_arg(&args,request["flag"].as_str().unwrap_or(""),
                    request["fallback"].as_u64().unwrap_or(0))?),
                "newLocalRepository"=>json!(cli::new_local_repository(&args)?),
                "repository"=>json!(cli::repository(&args)?),
                "optionalLegacyPr"=>json!(cli::optional_legacy_pr(&args)?),
                "eventBusResolutionMessage"=>json!(cli::event_bus_resolution_message(&request["resolution"])),
                _=>return Err("unknown CLI support method".into()),
            };
            Ok(value.to_string())
        }
        _=>return Ok(None),
    };
    Ok(Some(result?))
}
