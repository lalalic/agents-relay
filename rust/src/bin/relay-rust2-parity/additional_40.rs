//! Independent original Node public API differential adapters for Rust2
//! certification. No live service, provider or persistent Job store.
use serde_json::{json,Value};
use std::path::Path;

pub fn invoke(req:&Value)->Option<Result<String,String>>{
    match req["op"].as_str()?{
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
