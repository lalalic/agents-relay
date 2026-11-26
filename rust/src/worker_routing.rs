// Node provenance: src/worker-routing.ts. One authoritative Worker
// Router; Model Router runs only after this selection is persisted.
use crate::local_merge_lock::iso8601_now;
use serde_json::{json,Value};
pub const DEFAULT_CHATGPT_PREFERRED_CONCURRENCY:u64=10;
pub const DEFAULT_WORKER_ROUTER_PRINCIPLES:&str=concat!(
    "User-provided routing instructions are higher-priority guidance than these built-in defaults. Follow that guidance when it conflicts with a default unless doing so would violate an authoritative hard constraint.\n",
    "Worker Router chooses only the execution worker. Model Router chooses provider/model/profile after worker selection.\n",
    "Prefer ChatGPT when both workers can execute the task because it does not consume Codex coding-plan tokens and normally has access to a stronger ChatGPT Sol model.\n",
    "Prefer Codex when the task requires native/local execution or computer-use abilities that are unavailable through ChatGPT plus MacBridge.\n",
    "Treat coding-plan/provider quota as decision context, not worker legality. Codex may still use another provider selected later by Model Router.\n",
    "When Codex/OpenAI coding quota is scarce, prefer ChatGPT unless the Codex execution environment is necessary.\n",
    "When current ChatGPT running load reaches the preferred ChatGPT concurrency, strongly prefer Codex unless ChatGPT is materially required or better suited for the task."
);
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn as_number(v:Option<&Value>)->Option<f64> {v.and_then(Value::as_f64)}
fn window_usage(window:Option<&Value>,now_ms:i64)->Option<Value>{
    let window=window?;
    // Node: resourceWindow(null) returns undefined for an explicit null window.
    if window.is_null(){return None;}
    let used=window.get("usedPercent").and_then(Value::as_f64).unwrap_or(0.0);
    let reset=window.get("resetsAt").filter(|v|!v.is_null());
    let reset_in=reset.and_then(Value::as_i64)
        .map(|seconds|((seconds.saturating_mul(1_000)-now_ms) as f64/60_000.0)
            .ceil().max(0.0) as i64);
    Some(json!({"remainingPercent":100.0-used,
        "resetAt":reset,"resetInMinutes":reset_in}))
}
pub fn usage_for_provider(
    snapshot:Option<&Value>,provider:&str,now_ms:i64
)->Value{
    let Some(snapshot)=snapshot else{return json!({});};
    let usage=snapshot.get("providers").and_then(Value::as_array)
        .into_iter().flatten().find(|item|field(item,"id")==provider)
        .and_then(|item|item.get("usage"));
    if let Some(usage)=usage.filter(|v|v.get("available")==Some(&Value::Bool(true))){
        let five=usage.get("fiveHour");
        let weekly=usage.get("weekly");
        let used=five.and_then(|v|as_number(v.get("usedPercent"))).unwrap_or(0.0)
            .max(weekly.and_then(|v|as_number(v.get("usedPercent"))).unwrap_or(0.0));
        // Node builds windows with resourceWindow(): a null/absent window is
        // undefined, which JSON serialization omits entirely.
        let mut windows=json!({});
        if let Some(window)=window_usage(five,now_ms){
            windows["fiveHour"]=window;
        }
        if let Some(window)=window_usage(weekly,now_ms){
            windows["weekly"]=window;
        }
        let reset=[five,weekly].into_iter().flatten()
            .filter_map(|window|{
                let at=window.get("resetsAt").and_then(Value::as_i64)?;
                (at.saturating_mul(1000)>now_ms).then_some((at,window))
            }).min_by_key(|(at,_)|*at);
        let mut result=json!({
            "healthy":used<100.0,
            "usedPercent":used,
            "windows":windows
        });
        if let Some((at,window))=reset {
            let remaining=100.0-window.get("usedPercent")
                .and_then(Value::as_f64).unwrap_or(0.0);
            result["remainingPercent"]=json!(remaining);
            result["resetAt"]=json!(at);
            result["resetInMinutes"]=json!(((
                at.saturating_mul(1_000)-now_ms) as f64/60_000.0).ceil().max(0.0) as i64);
        }
        return result;
    }
    let credits=snapshot.get("credits").and_then(Value::as_array)
        .into_iter().flatten().find(|item|field(item,"id")==provider)
        .and_then(|item|item.get("credits"));
    if let Some(balances)=credits.and_then(|c|c.get("balances")).and_then(Value::as_array){
        let known:Vec<f64>=balances.iter().filter_map(|item|
            item.get("remaining").and_then(Value::as_f64)
                .filter(|value|value.is_finite())).collect();
        if !known.is_empty(){
            return json!({"healthy":known.iter().any(|value|*value>0.0)});
        }
    }
    json!({})
}
/// Canonical local native Model Worker descriptor, used by both the daemon
/// and the detached route CLI once a Codex executable is available.
pub fn native_codex_worker()->Value{
    json!({"workerId":"codex","id":"codex","name":"codex",
        "adapter":"codex","runtime":"codex",
        "capabilities":["model","codex","local_repo","iterative_tools"]})
}
pub fn worker_candidates(adapters:&[Value],registered:&[Value],
    usage:Option<&Value>,now_ms:i64)->Vec<Value>{
    let mut result=Vec::new();
    for adapter in adapters {
        let adapter_name=field(adapter,"name");
        let matching:Vec<&Value>=registered.iter().filter(|agent|
            agent.pointer("/runtime/adapter").and_then(Value::as_str)
                ==Some(adapter_name)).collect();
        let list:Vec<Option<&Value>>=if matching.is_empty(){vec![None]}
            else{matching.into_iter().map(Some).collect()};
        for agent in list {
            let provider=agent.and_then(|v|v.pointer("/runtime/provider"))
                .and_then(Value::as_str).or(match adapter_name{
                    "chatgpt"=>Some("chatgpt"),"z"=>Some("z"),_=>None
                });
            let resource=provider.map(|provider|
                usage_for_provider(usage,provider,now_ms)).unwrap_or(json!({}));
            let capabilities=agent.and_then(|v|v.get("capabilities"))
                .or_else(||adapter.get("capabilities"))
                .cloned().unwrap_or(json!([]));
            let worker_id=agent.and_then(|v|v.get("id"))
                .and_then(Value::as_str)
                .unwrap_or_else(||field(adapter,"id"));
            let mut candidate=json!({
                "workerId":worker_id,
                "adapter":adapter_name,
                "capabilities":capabilities,
                "runtime":agent.and_then(|v|v.pointer("/runtime/adapter"))
                    .and_then(Value::as_str).unwrap_or(adapter_name)
            });
            for (key,v) in [
                ("trustDomains",agent.and_then(|v|v.pointer("/routing/trustDomains"))),
                ("region",agent.and_then(|v|v.pointer("/routing/regions/0"))),
                ("labels",agent.and_then(|v|v.pointer("/routing/labels"))),
                ("availability",agent.and_then(|v|v.get("availability"))),
                ("resourceHealthy",resource.get("healthy")),
                ("resourceUsedPercent",resource.get("usedPercent")),
                ("resourceRemainingPercent",resource.get("remainingPercent")),
                ("resourceResetAt",resource.get("resetAt")),
                ("resourceResetInMinutes",resource.get("resetInMinutes")),
                ("resourceWindows",resource.get("windows")),
                ("browserWorkspaceCapacity",if adapter_name=="chatgpt"{
                    usage.and_then(|v|v.get("browserWorkspace"))
                }else{None})
            ] {
                if let Some(v)=v.filter(|v|!v.is_null()){
                    candidate[key]=v.clone();
                }
            }
            if let Some(provider)=provider{candidate["resourceProvider"]=json!(provider);}
            result.push(candidate);
        }
    }
    result
}
pub fn satisfies_worker(candidate:&Value,requirements:&Value,strict_capabilities:bool)->bool{
    if field(candidate,"availability")=="offline"{return false;}
    if let Some(runtime)=requirements.get("runtime").and_then(Value::as_str)
        .filter(|s|!s.is_empty()){
        if field(candidate,"runtime")!=runtime{return false;}
    }
    if strict_capabilities{
        let required=requirements.get("capabilities").and_then(Value::as_array);
        if required.is_some_and(|reqs|reqs.iter().any(|requirement|{
            !candidate.get("capabilities").and_then(Value::as_array)
                .is_some_and(|caps|caps.contains(requirement))
        })){return false;}
    }
    if field(candidate,"adapter")=="chatgpt"
        && candidate.pointer("/browserWorkspaceCapacity/available")
            .and_then(Value::as_i64)==Some(0){return false;}
    true
}
pub fn eligible_worker_candidates(
    candidates:&[Value],requirements:&Value,strict_capabilities:bool
)->Vec<Value>{
    candidates.iter().filter(|candidate|
        satisfies_worker(candidate,requirements,strict_capabilities))
        .cloned().collect()
}
fn no_eligible_reason(candidates:&[Value])->&'static str{
    if candidates.iter().any(|item|field(item,"adapter")=="chatgpt"
        && item.pointer("/browserWorkspaceCapacity/available")
            .and_then(Value::as_i64)==Some(0)){
        "No eligible worker: ChatGPT Browser Workspace has no allocatable capacity."
    }else{"No eligible worker satisfies the authoritative worker constraints"}
}
fn deterministic_worker(eligible:&[Value])->&Value{
    eligible.iter().find(|v|field(v,"adapter")=="codex")
        .unwrap_or(&eligible[0])
}
fn selection(candidate:&Value,by:&str,evidence:Option<&Value>)->Value{
    let mut selected=json!({
        "workerId":candidate.get("workerId"),
        "adapter":candidate.get("adapter"),
        "capabilities":candidate.get("capabilities"),
        "selectedBy":by,
        "selectedAt":iso8601_now()
    });
    for key in ["resourceHealthy","resourceProvider","resourceUsedPercent",
        "resourceRemainingPercent","resourceResetAt","resourceResetInMinutes",
        "resourceWindows","browserWorkspaceCapacity"]{
        if let Some(value)=candidate.get(key).filter(|v|!v.is_null()){
            selected[key]=value.clone();
        }
    }
    if let Some(evidence)=evidence{selected["decisionEvidence"]=evidence.clone();}
    selected
}
pub fn select_worker(candidates:&[Value],requirements:&Value)->Result<Value,String>{
    let eligible=eligible_worker_candidates(candidates,requirements,false);
    if eligible.is_empty(){return Err(no_eligible_reason(candidates).into());}
    let chosen=deterministic_worker(&eligible);
    Ok(json!({"candidate":chosen,
        "selection":selection(chosen,"worker-router:fallback",None)}))
}
pub fn routing_decision_facts(
    eligible:&[Value],requirements:&Value,usage:Option<&Value>,
    task_facts:Option<&Value>,running:u64,preferred:u64,
)->Value{
    let options:Vec<Value>=eligible.iter().map(|candidate|json!({
        "id":candidate.get("workerId"),
        "adapter":candidate.get("adapter"),
        "runtime":candidate.get("runtime"),
        "availability":candidate.get("availability"),
        "declaredCapabilities":candidate.get("capabilities"),
        "resourceProvider":candidate.get("resourceProvider"),
        "resourceHealthy":candidate.get("resourceHealthy"),
        "resourceUsedPercent":candidate.get("resourceUsedPercent"),
        "resourceRemainingPercent":candidate.get("resourceRemainingPercent"),
        "resourceResetAt":candidate.get("resourceResetAt"),
        "resourceResetInMinutes":candidate.get("resourceResetInMinutes"),
        "resourceWindows":candidate.get("resourceWindows"),
        "browserWorkspaceCapacity":candidate.get("browserWorkspaceCapacity")
    })).collect();
    json!({
        "task":task_facts.cloned().unwrap_or(json!({})),
        "explicit_constraints":{
            "runtime":requirements.get("runtime")
        },
        "decision_precedence":[
            "authoritative_hard_constraints",
            "routing_instruction",
            "routing_principles",
            "resource_and_runtime_preferences"
        ],
        "routing_principles":DEFAULT_WORKER_ROUTER_PRINCIPLES,
        "usage_snapshot":usage,
        "runtime_load":{
            "chatgpt_running":running,
            "preferred_chatgpt_concurrency":preferred
        },
        "candidates":options
    })
}
/// The decision engine port may choose among these IDs, but cannot add a
/// worker or override a hard capability/runtime/capacity constraint.
pub fn route_worker_with_choice(
    candidates:&[Value],requirements:&Value,
    decision_mode:&str,proposed_choice:Option<&str>,evidence:Option<&Value>,
)->Result<Value,String>{
    let eligible=eligible_worker_candidates(candidates,requirements,false);
    if eligible.is_empty(){return Err(no_eligible_reason(candidates).into());}
    let deterministic=deterministic_worker(&eligible);
    if eligible.len()==1 {
        return Ok(json!({
            "candidate":deterministic,
            "selection":selection(deterministic,"worker-router:constraint",
                Some(&json!({"mode":decision_mode,"fallback":true})))
        }));
    }
    let selected=proposed_choice.and_then(|id|
        eligible.iter().find(|candidate|field(candidate,"workerId")==id))
        .unwrap_or(deterministic);
    let model_chosen=evidence.is_some_and(|e|e.get("engine").is_some_and(|v|!v.is_null())
        && e.get("fallback")!=Some(&Value::Bool(true)));
    let by=if model_chosen{"worker-router:laya"}else{"worker-router:fallback"};
    Ok(json!({"candidate":selected,
        "selection":selection(selected,by,evidence)}))
}

/// Node routeWorker entrypoint. Graph/decision engine owns the requested
/// choice; route_worker_with_choice enforces hard constraints and fallback.
/// The host supplies only a validated, signed choice/evidence when available.
pub fn route_worker(
    candidates:&[Value],requirements:&Value,options:&Value,
    proposed_choice:Option<&str>,evidence:Option<&Value>,
)->Result<Value,String>{
    let mode=options.get("decisionMode").and_then(Value::as_str).unwrap_or("off");
    let fallback=json!({"mode":mode,"fallback":true});
    route_worker_with_choice(candidates,requirements,mode,proposed_choice,
        Some(evidence.unwrap_or(&fallback)))
}
