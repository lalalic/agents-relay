// Original browser-worker-routing.ts public API differential: the admission
// boolean and the eligible candidate chain, over a real isolated
// BrowserWorkerPoolManager whose provider health is driven to the requested
// state (HEALTHY default, pre-submission outage or verified recovery).
use agents_relay_rust2::browser_worker_pool::{BrowserPoolOptions,BrowserWorkerPoolManager};
use agents_relay_rust2::browser_worker_routing::has_safe_alternative_worker;
use agents_relay_rust2::worker_routing::{eligible_worker_candidates,worker_candidates};
use serde_json::{json,Value};
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certBrowserWorkerRouting"{return None;}
    Some((||{
        let method=request["method"].as_str().unwrap_or("");
        if method!="route"{
            return Err(format!("Unknown browser-worker-routing public method {method}"));
        }
        let task=request.get("task").filter(|v|!v.is_null());
        let adapters=request["adapters"].as_array()
            .ok_or("adapters must be an array")?;
        let agents=request["agents"].as_array()
            .ok_or("agents must be an array")?;
        let usage=request.get("usage").filter(|v|!v.is_null());
        let now_ms=request["nowMs"].as_i64().unwrap_or(0);
        let clock_now=request["poolClock"].as_i64().unwrap_or(now_ms);
        let pool=BrowserWorkerPoolManager::with_clock(BrowserPoolOptions{
            path:Some(":memory:".into()),..Default::default()
        },move||clock_now).map_err(|e|e.to_string())?;
        let health=request["poolHealth"].as_object()
            .ok_or("poolHealth object required")?;
        for (provider,state) in health.iter(){
            if let Some(duration)=state.get("outageMs").and_then(Value::as_i64){
                pool.report_pre_submission_outage(provider,duration)
                    .map_err(|e|e.to_string())?;
            }else if state.get("healthy")==Some(&Value::Bool(true)){
                pool.report_healthy(provider).map_err(|e|e.to_string())?;
            }
        }
        let requirements=task.and_then(|task|task.get("workerRequirements"))
            .filter(|v|!v.is_null()).cloned()
            .unwrap_or_else(||json!({"capabilities":[]}));
        let eligible=eligible_worker_candidates(
            &worker_candidates(adapters,agents,usage,now_ms),&requirements,true)
            .iter().map(|candidate|
                candidate.get("adapter").and_then(Value::as_str).unwrap_or("").to_string())
            .collect::<Vec<_>>();
        let healthy=has_safe_alternative_worker(task,adapters,agents,usage,now_ms,
            &|provider|pool.snapshot(provider)
                .map(|snapshot|snapshot.health=="HEALTHY").unwrap_or(false));
        Ok(json!({"eligible":eligible,"healthy":healthy}).to_string())
    })())
}
