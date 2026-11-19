//! Independent original Node public API differential adapters for Rust2
//! certification. No live service, provider or persistent Job store.
use serde_json::{json,Value};
use std::path::Path;

pub fn invoke(req:&Value)->Option<Result<String,String>>{
    match req["op"].as_str()?{
        "certInteractiveLifecycle"=>Some((||{
            use agents_relay_rust2::interactive_request as i;
            let job_id=req["jobId"].as_str().unwrap_or("25");
            let task_id=req["taskId"].as_str().unwrap_or("11");
            let execution_id=req["executionId"].as_str().unwrap_or("gen-1");
            let result=match req["action"].as_str().unwrap_or(""){
                "begin"=>{
                    let (job,receipt)=i::begin_interactive_review(
                        &req["job"],job_id,task_id,execution_id)?;
                    json!({"job":job,"receipt":receipt})
                },
                "abort"=>json!({"job":i::abort_interactive_review(
                    &req["job"],task_id,execution_id)}),
                "template"=>i::interactive_template(job_id,task_id,execution_id),
                "waiting"=>i::interactive_waiting_event(job_id,task_id,
                    req["parentTaskId"].as_str(),execution_id),
                _=>return Err("Unknown interactive lifecycle API".into())
            };
            Ok(result.to_string())
        })()),
        "certDaemonUtilities"=>Some((||{
            use agents_relay_rust2::relayd_utilities as d;
            let args=req["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let result=match req["action"].as_str().unwrap_or(""){
                "help"=>json!(d::DAEMON_HELP),
                "value"=>json!(d::value(&args,
                    req["name"].as_str().unwrap_or("--id"),
                    req["fallback"].as_str().unwrap_or(""))),
                "choices"=>json!(d::first_stage_choices(req.get("decision"))),
                "coalesce"=>json!(d::should_coalesce_pull_request_refresh(
                    req["completedAt"].as_i64(),req["now"].as_i64().unwrap_or(1000),
                    req["force"].as_bool().unwrap_or(false))),
                "merge"=>json!(d::merge_operational_inventory(
                    req["current"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                    req["discovered"].as_array().map(Vec::as_slice).unwrap_or(&[]))),
                "recovery"=>json!(d::recovery_scan_repositories(
                    &req["repositories"].as_array().into_iter().flatten()
                        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>(),
                    req["cached"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                    req["index"].as_i64().unwrap_or(0))),
                "normalize"=>{
                    let parsed=d::normalize_daemon_arguments(&args,
                        req["workspaceEnv"].as_str())?;
                    json!({"repository":parsed.repository,
                        "workspaceRoot":parsed.workspace_root,
                        "pullRequest":parsed.pull_request,"jobId":parsed.job_id,
                        "serviceArguments":parsed.service_arguments})
                },
                "overlay"=>{
                    use std::{future::{Future,ready},pin::pin,task::{Context,Poll,Waker}};
                    let overviews=req["overviews"].as_array().map(Vec::as_slice).unwrap_or(&[]);
                    let mut f=pin!(d::overlay_operational_overviews(overviews,|repo,pr,mut job|{
                        let injected=req["updates"].get(&repo)
                            .and_then(|r|r.get(pr.to_string())).cloned();
                        if let Some(v)=injected{job=v;}
                        ready(Ok::<_,String>(job))
                    }));
                    let mut cx=Context::from_waker(Waker::noop());
                    match f.as_mut().poll(&mut cx){
                        Poll::Ready(Ok(x))=>json!(x),
                        Poll::Ready(Err(e))=>return Err(e),
                        Poll::Pending=>return Err("Injected overview hydrator suspended".into()),
                    }
                },
                _=>return Err("Unknown daemon utilities API".into()),
            };
            Ok(result.to_string())
        })()),
        "certCliReviewThread"=>Some((||{
            let args=req["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            Ok(json!(agents_relay_rust2::cli_review::review_request_thread_override(&args)?).to_string())
        })()),
        "certExecutionRouterPublic"=>Some((||{
            use agents_relay_rust2::execution_routing as e;
            let value=match req["action"].as_str().unwrap_or(""){
                "shape"=>e::execution_task_shape(&req["taskFacts"]),
                "capabilities"=>json!(e::task_capability_facts(&req["taskFacts"])),
                "principles"=>json!(e::EXECUTION_ROUTING_PRINCIPLES),
                "label"=>json!(e::execution_choice_label(&req["route"],
                    req["isDefault"].as_bool().unwrap_or(false))),
                "discover"=>{
                    let routes=e::discover_execution_routes(
                        req["workers"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                        &req["requirements"],&req["options"],
                        Path::new(req["home"].as_str().ok_or("home missing")?),
                        Path::new(req["policyPath"].as_str().ok_or("policy missing")?),
                        Path::new(req["rulesPath"].as_str().ok_or("rules missing")?),
                        req["nowMs"].as_i64().unwrap_or(1795000000000))?;
                    json!({"routes":routes.routes,"evaluations":routes.evaluations,
                        "workerGateEvaluations":routes.worker_gate_evaluations,
                        "policy":routes.policy,"choices":routes.choices,
                        "routingInstruction":routes.routing_instruction})
                },
                _=>return Err("Unknown execution routing API".into()),
            };
            Ok(value.to_string())
        })()),
        "certManualPlan"=>Some((||{
            use std::{cell::RefCell,rc::Rc,future::{ready,Future},pin::pin,task::{Context,Poll,Waker}};
            use agents_relay_rust2::{manual_plan::execute_manual_plan,planner::create_plan_round};
            let state=Rc::new(RefCell::new(req["job"].clone()));
            let created=Rc::new(RefCell::new(Vec::<Value>::new()));
            let loaded=state.clone();let committed=state.clone();
            let launched=state.clone();let launch_records=created.clone();
            let timeout=req["timeoutMs"].as_u64().unwrap_or(5000);
            let future=execute_manual_plan(Path::new("workflow"),
                req["jobId"].as_str().unwrap_or("17"),
                req["guidance"].as_str(),timeout,
                req["forceRestate"].as_bool().unwrap_or(false),
                req["atomic"].as_bool().unwrap_or(true),
                move||ready(Ok::<_,String>(loaded.borrow().clone())),
                move|next:Value|{
                    *committed.borrow_mut()=next.clone();
                    ready(Ok::<_,String>(next))
                },
                |job,guidance,timeout|create_plan_round(Path::new("workflow"),
                    job,guidance,true,Some(timeout),Some("2026-11-18T20:00:00.000Z")),
                move|job,round|{
                    launch_records.borrow_mut().push(round.clone());
                    let mut current=job.clone();
                    if req["failLaunch"]==true {
                        return ready(Err("injected Planner transport failure".into()));
                    }
                    let plan_id=round["id"].clone();
                    if let Some(plans)=current["plans"].as_array_mut(){
                        if let Some(p)=plans.iter_mut().find(|p|p["id"]==plan_id){
                            p["status"]=json!(req["terminalStatus"].as_str().unwrap_or("SUCCEEDED"));
                            if req["terminalStatus"]=="FAILED"{
                                p["error"]=json!("injected Planner failure");
                            }
                        }
                    }
                    *launched.borrow_mut()=current;
                    ready(Ok(()))
                });
            let mut pinned=pin!(future);let mut cx=Context::from_waker(Waker::noop());
            let result=match pinned.as_mut().poll(&mut cx){
                Poll::Ready(value)=>value,
                Poll::Pending=>return Err("Injected manual Planner cannot suspend".into()),
            };
            // Difference report transport shape keeps original Node errors.
            let output=match result {
                Ok((job,round))=>json!({"job":job,"round":round,"launched":created.borrow().len()}),
                Err(error)=>return Err(error),
            };
            Ok(output.to_string())
        })()),
        "certWorkerRouterPublic"=>Some((||{
            use agents_relay_rust2::worker_routing as w;
            let candidates=req["candidates"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let adapters=req["adapters"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let registered=req["registered"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let requirements=&req["requirements"];
            let strict=req["strict"].as_bool().unwrap_or(false);
            let value=match req["action"].as_str().unwrap_or(""){
                "defaults"=>json!({"preferred":w::DEFAULT_CHATGPT_PREFERRED_CONCURRENCY,
                    "principles":w::DEFAULT_WORKER_ROUTER_PRINCIPLES}),
                "usage"=>w::usage_for_provider(req.get("usage"),
                    req["provider"].as_str().unwrap_or("openai"),
                    req["nowMs"].as_i64().unwrap_or(1795000000000)),
                "candidates"=>json!(w::worker_candidates(adapters,registered,req.get("usage"),
                    req["nowMs"].as_i64().unwrap_or(1795000000000))),
                "satisfies"=>json!(w::satisfies_worker(&req["candidate"],requirements,strict)),
                "eligible"=>json!(w::eligible_worker_candidates(candidates,requirements,strict)),
                "select"=>w::select_worker(candidates,requirements)?,
                _=>return Err("Unknown worker routing API".into()),
            };
            Ok(value.to_string())
        })()),
        "certCliWorkerTask"=>Some((||{
            use agents_relay_rust2::cli_worker_task as t;
            let args=req["args"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let op=req["action"].as_str().unwrap_or("diagnosis");
            let out=match op{
                "diagnosis"=>json!(t::recovery_diagnosis_from_args(&args)?),
                "validity"=>json!(t::dependency_validity_from_args(&args,
                    &req["dependencies"].as_array().into_iter().flatten()
                        .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>())?),
                "create"=>t::worker_task_from_args(Path::new("workflow"),&req["job"],&args,
                    req["now"].as_str().unwrap_or("2026-11-18T20:00:00.000Z"),
                    Path::new(req["storeDir"].as_str().ok_or("storeDir missing")?),None)?,
                _=>return Err("Unsupported CLI worker task operation".into()),
            };
            Ok(out.to_string())
        })()),
        "certModelPublic"=>Some((||{
            use agents_relay_rust2::model_routing as m;
            let result=match req["action"].as_str().unwrap_or(""){
                "choice"=>json!(m::model_choice_id(&req["candidate"])),
                "configured"=>json!(m::configured_codex_default(Path::new(
                    req["home"].as_str().ok_or("home missing")?))),
                "discover"=>json!(m::discover_model_candidates(
                    &req["worker"],req["registered"].as_array().map(Vec::as_slice).unwrap_or(&[]),
                    None,Path::new(req["home"].as_str().ok_or("home missing")?),
                    req["nowMs"].as_i64().unwrap_or(1795000000000))),
                _=>return Err("Invalid model API operation".into()),
            };
            Ok(result.to_string())
        })()),
        "certUnblockFacts"=>Some((||{
            use agents_relay_rust2::unblock as u;
            let job=&req["job"];
            let results=json!({
                "blocked":u::is_effectively_blocked(&req["task"]),
                "trigger":u::unconsumed_unblock_trigger(job),
                "newPlan":u::unblock_needs_new_plan(job)
            });
            Ok(results.to_string())
        })()),
        "certTroubleshooter"=>Some((||{
            use agents_relay_rust2::troubleshooter as t;
            let job=&req["job"];
            let original=&req["original"];
            let mut recovery=req["recovery"].clone();
            let directory=Path::new(req["storeDir"].as_str().ok_or("storeDir missing")?);
            let id=t::troubleshooter_task_id(directory,job,original)?;
            let reopens=t::pending_troubleshooter_reopens(job);
            let retries=t::pending_troubleshooter_retries(job);
            let pending=t::pending_troubleshooter_tasks(
                Path::new("workflow"),directory,job)?;
            let exhausted=t::exhausted_troubleshooter_recoveries(job);
            t::refresh_troubleshooter_input(job,original,&mut recovery);
            Ok(json!({"id":id,"reopens":reopens,"retries":retries,
                "pending":pending,"exhausted":exhausted,"recovery":recovery}).to_string())
        })()),
        "certRelayStoreDiscovery"=>Some((||{
            use agents_relay_rust2::relay_store_discovery as d;
            let directory=Path::new(req["directory"].as_str().ok_or("directory missing")?);
            let value=match req["action"].as_str().unwrap_or("inventory"){
                "path"=>json!(d::relay_unified_store_path(directory).to_string_lossy()),
                "scope"=>json!(d::resolve_unified_job_scope(
                    directory,req["repository"].as_str().unwrap_or(""),
                    req["prNumber"].as_i64().unwrap_or(0),req["hintId"].as_str())?),
                "inventory"=>{
                    let rows=d::discover_local_relay_store_snapshots(directory)?;
                    json!(rows.into_iter().map(|row|json!({
                        "path":row.path,"jobs":row.jobs,"facts":row.facts,
                        "publications":row.publications})).collect::<Vec<_>>())
                },
                _=>return Err("Unknown discovery action".into()),
            };
            Ok(value.to_string())
        })()),
        "certJobActions"=>Some((||{
            use agents_relay_rust2::job_actions as a;
            let job=&req["job"];
            let output=match req["action"].as_str().unwrap_or("activate"){
                "activate"=>a::apply_job_activate_action(Path::new("workflow"),job),
                "cancel"=>a::apply_job_cancel_action(Path::new("workflow"),job,
                    req["reason"].as_str()),
                _=>return Err("Unknown Job action".into()),
            }?;
            Ok(output.to_string())
        })()),
        "certForceRestateValidation"=>Some((||{
            use agents_relay_rust2::force_restate_validation as v;
            let mut job=req["job"].clone();
            let candidates=req["candidates"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let expected=req["expected"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
            let cleanup=req["cleanup"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let result=json!({
                "runnable":v::force_restate_runnable(&job,candidates),
                "waiting":v::force_restate_dependency_waiting(&job,candidates),
                "blocked":v::force_restate_blocked(&job,req["planId"].as_str()),
                "converged":v::force_restate_converged(&job,req["planId"].as_str(),candidates),
                "review":v::objective_satisfied_for_review(&job),
            });
            let cleaned=v::apply_planner_history_cleanup(
                &mut job,&expected,cleanup,req["now"].as_str().unwrap_or("2026-11-18T20:00:00.000Z"),
                Path::new("workflow"))?;
            Ok(json!({"facts":result,"cleanup":cleaned,"job":job}).to_string())
        })()),
        _=>None,
    }
}
