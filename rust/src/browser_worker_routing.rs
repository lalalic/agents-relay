// Node provenance: src/browser-worker-routing.ts. Graph-authorized
// pre-submission admission checks, never workflow scheduling policy.
// The candidate inputs are the original (task, adapters, registered agents,
// usage) shapes; candidates are produced by the certified Worker Router and
// browser-backed adapters are admitted only with a HEALTHY pool snapshot.
use crate::worker_routing::{eligible_worker_candidates,worker_candidates};
use serde_json::{json,Value};

/// Original Node signature: hasSafeAlternativeWorker(task, adapters, agents,
/// usage). The pool health resolver is injected so the daemon can bind its
/// real BrowserWorkerPoolManager; Node reads the global singleton snapshot.
pub fn has_safe_alternative_worker(
    task:Option<&Value>,adapters:&[Value],agents:&[Value],usage:Option<&Value>,
    now_ms:i64,pool_healthy:&dyn Fn(&str)->bool,
)->bool{
    let Some(task)=task else{return false;};
    let adapter=task.get("adapter").and_then(Value::as_str);
    if adapter==Some("orchestrator")
        ||task.get("chatgptThreadDelivery").is_some_and(js_truthy)
    {return false;}
    // Node: task.workerRequirements?.runtime === task.adapter, where both
    // sides may be undefined; the equality must keep that undefined===undefined
    // early rejection (null requirements collapse to the Node default object).
    let requirements=task.get("workerRequirements").filter(|v|!v.is_null())
        .cloned().unwrap_or_else(||json!({"capabilities":[]}));
    let required_runtime=requirements.get("runtime").and_then(Value::as_str);
    if required_runtime==adapter {return false;}
    let candidates=worker_candidates(adapters,agents,usage,now_ms);
    eligible_worker_candidates(&candidates,&requirements,true).iter().any(|candidate|{
        let candidate_adapter=candidate.get("adapter").and_then(Value::as_str);
        if candidate_adapter==adapter && candidate_adapter.is_some(){return false;}
        let candidate_adapter=candidate_adapter.unwrap_or("");
        if candidate_adapter!="chatgpt"&&candidate_adapter!="z"{return true;}
        pool_healthy(candidate_adapter)
    })
}

/// Production binding over the real daemon pool manager. A snapshot failure
/// fails closed (no safe alternative), matching the fail-closed requirement
/// for unavailable providers.
pub fn has_safe_alternative_worker_with_pool(
    task:Option<&Value>,adapters:&[Value],agents:&[Value],usage:Option<&Value>,
    now_ms:i64,pool:&crate::browser_worker_pool::BrowserWorkerPoolManager,
)->bool{
    has_safe_alternative_worker(task,adapters,agents,usage,now_ms,&|provider|{
        pool.snapshot(provider).map(|s|s.health=="HEALTHY").unwrap_or(false)
    })
}
fn js_truthy(value:&Value)->bool{
    match value{
        Value::Null=>false,
        Value::Bool(v)=>*v,
        Value::Number(n)=>n.as_f64().is_some_and(|n|n!=0.0),
        Value::String(s)=>!s.is_empty(),
        Value::Array(_)|Value::Object(_)=>true,
    }
}
