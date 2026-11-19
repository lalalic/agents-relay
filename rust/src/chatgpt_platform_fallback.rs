// Node provenance: src/chatgpt-platform-fallback.ts. Only the canonical
// routing and Task Graph may authorize pre-start platform fallback.
// The candidate inputs are the original (task, adapters, registered agents,
// usage) shapes; candidate eligibility is the certified Worker Router chain,
// never an invented Codex identity or unverified catalog default.
use crate::events::event_for;
use crate::local_merge_lock::iso8601_now;
use crate::worker_routing::{eligible_worker_candidates,worker_candidates};
use serde_json::{json,Value};
use std::collections::HashSet;
use std::future::Future;

fn js_truthy(value:&Value)->bool{
    match value{
        Value::Null=>false,
        Value::Bool(v)=>*v,
        Value::Number(n)=>n.as_f64().is_some_and(|n|n!=0.0),
        Value::String(s)=>!s.is_empty(),
        Value::Array(_)|Value::Object(_)=>true,
    }
}
fn exclusion_identities(task:&Value)->(HashSet<String>,HashSet<String>){
    let exclusions=task.get("routingExclusions").and_then(Value::as_array);
    let mut workers=HashSet::new();
    let mut adapters=HashSet::new();
    for item in exclusions.into_iter().flatten(){
        if let Some(id)=item.get("workerId").filter(|v|js_truthy(v)).and_then(Value::as_str){
            workers.insert(id.to_string());
        }
        if let Some(adapter)=item.get("adapter").filter(|v|js_truthy(v)).and_then(Value::as_str){
            adapters.insert(adapter.to_string());
        }
    }
    (workers,adapters)
}

/// Original Node signature: codexFallbackRouting(task, adapters, registered,
/// usage). Returns the strict-capability Codex candidates remaining after the
/// Task's recorded routing exclusions, plus the excluded provider/model routes.
pub fn codex_fallback_routing(task:&Value,adapters:&[Value],registered:&[Value],
    usage:Option<&Value>,now_ms:i64)->(Vec<Value>,Vec<Value>){
    let requirements=task.get("workerRequirements").filter(|v|!v.is_null())
        .cloned().unwrap_or_else(||json!({"capabilities":[]}));
    let (excluded_workers,excluded_adapters)=exclusion_identities(task);
    let candidates=eligible_worker_candidates(
        &worker_candidates(adapters,registered,usage,now_ms),&requirements,true)
        .into_iter()
        .filter(|candidate|{
            let adapter=candidate.get("adapter").and_then(Value::as_str).unwrap_or("");
            let worker_id=candidate.get("workerId").and_then(Value::as_str).unwrap_or("");
            adapter=="codex"
                &&!excluded_workers.contains(worker_id)
                &&!excluded_adapters.contains(adapter)
        }).collect();
    let excluded_routes=task.get("routingExclusions").and_then(Value::as_array)
        .into_iter().flatten().map(|item|{
            // Node spreads provider/model as-is, so absent keys stay absent in JSON.
            let mut route=json!({});
            if let Some(value)=item.get("provider").filter(|v|!v.is_null()){
                route["provider"]=value.clone();
            }
            if let Some(value)=item.get("model").filter(|v|!v.is_null()){
                route["model"]=value.clone();
            }
            if let Some(profile)=item.get("profile").and_then(Value::as_str)
                .filter(|text|!text.is_empty()){
                route["profile"]=json!(profile);
            }
            route
        }).collect();
    (candidates,excluded_routes)
}

pub async fn codex_fallback_compatible<Route,Fut>(
    task:&Value,adapters:&[Value],registered:&[Value],usage:Option<&Value>,
    now_ms:i64,route:Route,
)->bool
where Route:FnOnce(Vec<Value>,Vec<Value>,Value)->Fut,
      Fut:Future<Output=Result<Value,String>>,
{
    if val(task,"adapter")!="chatgpt"
        ||task.get("chatgptThreadDelivery").is_some_and(js_truthy)
        ||task.get("workerRequirements").and_then(|r|r.get("runtime"))
            .and_then(Value::as_str)==Some("chatgpt")
    {return false;}
    let requirements=task.get("workerRequirements").filter(|v|!v.is_null())
        .cloned().unwrap_or_else(||json!({"capabilities":[]}));
    let (candidates,excluded_routes)=codex_fallback_routing(
        task,adapters,registered,usage,now_ms);
    if candidates.is_empty(){return false;}
    route(candidates,excluded_routes,requirements).await.is_ok()
}

/// One deterministic, verified configured-default Codex route for an
/// unstarted failed ChatGPT/Z Worker generation. Never use catalog defaults.
pub async fn codex_no_start_fallback_route<Route,Fut>(
    task:&Value,adapters:&[Value],registered:&[Value],usage:Option<&Value>,
    now_ms:i64,configured_default:Option<&Value>,route:Route,
)->Option<Value>
where Route:FnOnce(Vec<Value>,Vec<Value>,Value,Value)->Fut,
      Fut:Future<Output=Result<Value,String>>,
{
    if (!matches!(val(task,"adapter"),"chatgpt"|"z")
        &&!task.get("noStartFallback").is_some_and(js_truthy))
        ||task.get("chatgptThreadDelivery").is_some_and(js_truthy)
    {return None;}
    let configured=configured_default?;
    let provider=configured.get("provider").and_then(Value::as_str)?;
    let model=configured.get("model").and_then(Value::as_str)?;
    let requirements=task.get("workerRequirements").filter(|v|!v.is_null())
        .cloned().unwrap_or_else(||json!({"capabilities":[]}));
    let (candidates,excluded_routes)=codex_fallback_routing(
        task,adapters,registered,usage,now_ms);
    if candidates.is_empty(){return None;}
    let decision=route(candidates,excluded_routes,requirements,
        json!({"provider":provider,"model":model})).await.ok()?;
    if val(&decision["candidate"],"adapter")!="codex"
        ||val(&decision["candidate"]["routing"],"provider")!=provider
        ||val(&decision["candidate"]["routing"],"model")!=model
        ||!decision["model"]["profile"].is_null()
    {return None;}
    Some(decision)
}

/// Preserve the exact failed route as a one-way exclusion: do not retry
/// a quarantined Worker with an identical worker ID and adapter.
pub fn persist_chatgpt_platform_failure(
    task:&mut Value,original:Option<&Value>,execution_id:Option<&str>,
    classification:&str,evidence:&str,safe_to_reroute:bool,
){
    let route=original.and_then(|v|v.get("routing"));
    // Node: route?.provider ?? "unknown" keeps an existing empty string and
    // only substitutes the default for nullish values.
    let route_field=|key:&str|route
        .and_then(|v|v.get(key))
        .filter(|v|!v.is_null())
        .cloned()
        .unwrap_or(json!("unknown"));
    let adapter=if original.is_some_and(|v|val(v,"adapter")=="z"){"z"}else{"chatgpt"};
    let worker_id=original.and_then(|v|v.get("workerSelection"))
        .and_then(|selection|selection.get("workerId"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(||original.and_then(|v|v.get("adapter"))
            .and_then(Value::as_str).map(str::to_string))
        .unwrap_or_else(||"chatgpt".to_string());
    let at=iso8601_now();
    let mut failed=json!({
        "workerId":worker_id,
        "adapter":adapter,
        "provider":route_field("provider"),
        "model":route_field("model"),
    });
    if let Some(profile)=route.and_then(|v|v.get("profile"))
        .and_then(Value::as_str).filter(|value|!value.is_empty()){
        failed["profile"]=json!(profile);
    }
    task["platformFailure"]=json!({
        "classification":classification,
        "executionId":execution_id.unwrap_or("unknown"),
        "route":failed,"evidence":evidence,
        "safeToReroute":safe_to_reroute,"at":at,
    });
    let exclusions=task.get("routingExclusions").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    if !exclusions.iter().any(|item|
        val(item,"workerId")==worker_id&&val(item,"adapter")==adapter){
        let mut next=exclusions;
        failed["reason"]=json!(classification);
        failed["at"]=json!(at);
        next.push(failed);
        task["routingExclusions"]=json!(next);
    }
}

/// The Task Graph controls the fallback failure. This helper only performs
/// its accepted mutation and synthesizes the user-visible terminal event.
pub async fn quarantine_unavailable_codex_fallback<Transition,Fut>(
    job_id:&str,task_id:&str,error:&str,transition:Transition,
)->Result<Option<Value>,String>
where Transition:FnOnce(&str,&str,&str,Value)->Fut,
      Fut:Future<Output=Result<Option<Value>,String>>,
{
    let context=json!({
        "facts":{"platformFallbackSafe":false},
        "eligibleState":"QUEUED","eligibleAdapters":["chatgpt","z"],
        "requiresSafeToReroute":true,
        "error":format!("Codex fallback route became unavailable: {error}")
    });
    let updated=transition(job_id,task_id,"worker.platform_failure",context).await?;
    let Some(task)=updated else{return Ok(None);};
    if task.get("state").and_then(Value::as_str)==Some("QUEUED"){
        return Ok(None);
    }
    Ok(Some(event_for(job_id,task_id,
        task.get("parentTaskId").and_then(Value::as_str),
        "task.failed","failed",
        task.get("error").and_then(Value::as_str)
            .unwrap_or("Codex fallback route unavailable"),Some("user"),
        Some(json!({"reason":task.get("failureReason"),"phase":"fallback-routing"})),None)))
}
fn val<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
