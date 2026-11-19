// Original chatgpt-platform-fallback.ts public API differential over the real
// certified Worker Router candidates, real execution routing (engine off) and
// the real CODEX_HOME config.toml parsing. No durable transition here.
use agents_relay_rust2::chatgpt_platform_fallback::{
    codex_fallback_compatible,codex_fallback_routing,codex_no_start_fallback_route,
    persist_chatgpt_platform_failure,
};
use agents_relay_rust2::execution_routing::route_execution;
use agents_relay_rust2::model_routing::configured_codex_default;
use serde_json::{json,Value};
use std::future::Future;
use std::path::PathBuf;
use std::pin::pin;
use std::task::{Context,Poll,Waker};

/// The certified routeFacade convention: timestamps normalize, the audit
/// object normalizes away, and decisionId normalizes only when present.
fn normalize_decision(decision:&mut Value){
    for path in ["/routing","/candidate/routing"]{
        if let Some(route)=decision.pointer_mut(path){
            if route.get("decidedAt").is_some(){route["decidedAt"]=json!("NORMALIZED");}
            // Node derives decisionId from its internal audit; with no audit
            // fixture the certified routeFacade convention drops the key.
            if let Some(object)=route.as_object_mut(){
                object.remove("decisionId");
            }
        }
    }
    if decision.pointer("/selection/selectedAt").is_some(){
        decision["selection"]["selectedAt"]=json!("NORMALIZED");
    }
    if decision.get("audit").is_some(){decision["audit"]=Value::Null;}
}
fn drive<T>(future:impl Future<Output=T>)->T{
    let mut context=Context::from_waker(Waker::noop());
    let mut pinned=pin!(future);
    match pinned.as_mut().poll(&mut context){
        Poll::Ready(value)=>value,
        Poll::Pending=>panic!("fallback differential future must be immediately ready"),
    }
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certChatgptPlatformFallback"{return None;}
    Some((||{
        let method=request["method"].as_str().unwrap_or("").to_string();
        let task=request["task"].clone();
        let adapters=request["adapters"].as_array()
            .ok_or("adapters array required")?.clone();
        let agents=request["agents"].as_array()
            .ok_or("agents array required")?.clone();
        let usage=request.get("usage").filter(|v|!v.is_null()).cloned();
        let now_ms=request["nowMs"].as_i64().unwrap_or(0);
        let codex_home=PathBuf::from(request["codexHome"].as_str()
            .ok_or("codexHome required")?);
        let missing=PathBuf::from(request["missingPath"].as_str()
            .ok_or("missingPath required")?);
        let result=match method.as_str(){
            "routing"=>{
                let (candidates,excluded_routes)=codex_fallback_routing(
                    &task,&adapters,&agents,usage.as_ref(),now_ms);
                json!({"candidates":candidates,"excludedRoutes":excluded_routes})
            },
            "persist"=>{
                let mut task=task.clone();
                persist_chatgpt_platform_failure(&mut task,
                    request.get("original").filter(|v|!v.is_null()),
                    request["executionId"].as_str(),
                    request["classification"].as_str().unwrap_or(""),
                    request["evidence"].as_str().unwrap_or(""),
                    request["safeToReroute"].as_bool().unwrap_or(false));
                task
            },
            "compatible"|"noStart"=>{
                let agents_for_options=agents.clone();
                let task_for_options=task.clone();
                let usage_for_options=usage.clone();
                let missing_for_options=missing.clone();
                if method=="compatible"{
                    let future=codex_fallback_compatible(&task,&adapters,&agents,
                        usage.as_ref(),now_ms,
                        move|candidates,excluded_routes,requirements|async move{
                            let mut options=json!({
                                "registered":agents_for_options,
                                "taskFacts":{"task":task_for_options},
                                "rulesPath":missing_for_options,
                                "policyPath":missing_for_options,
                            });
                            if let Some(snapshot)=usage_for_options.as_ref(){
                                options["usage"]=snapshot.clone();
                            }
                            options["excludedRoutes"]=json!(excluded_routes);
                            route_execution(&candidates,&requirements,&options,
                                &codex_home,&missing,&missing,now_ms,None,None,
                                &[],None)
                        });
                    json!(drive(future))
                }else{
                    let configured=configured_codex_default(&codex_home);
                    let future=codex_no_start_fallback_route(&task,&adapters,&agents,
                        usage.as_ref(),now_ms,configured.as_ref(),
                        move|candidates,excluded_routes,requirements,constraints|
                            async move{
                                let mut options=json!({
                                    "registered":agents_for_options,
                                    "decisionMode":"off",
                                    "taskFacts":{"task":{
                                        "id":task_for_options.get("id"),
                                        "fallback":"no-start"}},
                                    "rulesPath":missing_for_options,
                                    "policyPath":missing_for_options,
                                });
                                if let Some(snapshot)=usage_for_options.as_ref(){
                                    options["usage"]=snapshot.clone();
                                }
                                options["excludedRoutes"]=json!(excluded_routes);
                                options["routingConstraints"]=constraints;
                                route_execution(&candidates,&requirements,&options,
                                    &codex_home,&missing,&missing,now_ms,None,None,
                                    &[],None)
                            });
                    match drive(future){
                        Some(mut decision)=>{
                            normalize_decision(&mut decision);
                            decision
                        },
                        None=>Value::Null,
                    }
                }
            },
            value=>return Err(format!("Unknown chatgpt-platform-fallback method {value}")),
        };
        Ok(result.to_string())
    })())
}
