//! Independent original Node public API differential adapters for Rust2
//! certification. No live service, provider or persistent Job store.
use serde_json::{json,Value};
use std::path::Path;

pub fn invoke(req:&Value)->Option<Result<String,String>>{
    match req["op"].as_str()?{
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
