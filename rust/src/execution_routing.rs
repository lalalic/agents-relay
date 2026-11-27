// Node provenance: src/execution-routing.ts. Native combined Worker + Model
// selection. No worker/model may be fabricated by a decision engine;
// all routes pass an authoritative hard-gate evaluation before selection.
use crate::{
    local_merge_lock::iso8601_now,
    job_routing_preferences,
    model_routing::{discover_model_candidates,codex_profile_candidates,deterministic_model},
    router_rules::{append_agent_model_preference,append_routing_instruction},
    routing_policy::{
        load_execution_router_rules,load_routing_policy,policy_allows,
    },
    worker_routing::DEFAULT_CHATGPT_PREFERRED_CONCURRENCY,
};
use regex::Regex;
use serde_json::{json,Value};
use std::{collections::{HashMap,HashSet},path::Path};

pub const EXECUTION_ROUTING_PRINCIPLES:[&str;4]=[
    "Choose one complete executable route: worker plus provider/model/profile/reasoning.",
    "ChatGPT with MacBridge and Codex have broadly overlapping execution capabilities.",
    "Browser Workspace exhaustion is ChatGPT's primary hard execution constraint.",
    "Codex is the deterministic fallback when Jev fails; no second decision model is invoked.",
];
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn list<'a>(v:&'a Value,key:&str)->&'a [Value]{
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn nonempty(v:Option<&str>)->Option<&str>{v.filter(|s|!s.is_empty())}
fn unique(items:impl Iterator<Item=String>)->Vec<String>{
    let mut seen=HashSet::new();
    items.filter(|item|seen.insert(item.clone())).collect()
}
pub fn execution_task_shape(task_facts:&Value)->Value{
    // Original Node uses `storySize ?? task.storySize`: a null outer
    // override must fall back to the nested Task, unlike object key presence.
    let raw=task_facts.get("storySize").filter(|v|!v.is_null())
        .or_else(||task_facts.pointer("/task/storySize"))
        .and_then(Value::as_str).unwrap_or("M");
    let size=if matches!(raw,"S"|"L"){raw}else{"M"};
    let sustained=size=="L";
    json!({"storySize":size,"sustainedWork":sustained,
        "preferredWorker":if sustained{"codex"}else{"chatgpt"},
        "reason":if sustained{
            "Large/sustained tasks favor Codex."
        }else{
            "Small/medium tasks favor ChatGPT when Browser Workspace capacity is available."
        }
    })
}
pub fn task_capability_facts(task_facts:&Value)->Vec<String>{
    let task=task_facts.get("task")
        .filter(|v|v.is_object()).unwrap_or(task_facts);
    let explicit=task.get("taskCapabilities")
        .or_else(||task.get("task_capabilities"));
    let legacy=task.get("capabilities");
    let mut tags=explicit.and_then(Value::as_array).into_iter().flatten()
        .chain(legacy.and_then(Value::as_array).into_iter().flatten())
        .filter_map(Value::as_str).filter(|s|!s.trim().is_empty())
        .map(str::to_owned).collect::<Vec<_>>();
    if explicit.and_then(Value::as_array).is_some_and(|v|!v.is_empty()){
        return unique(tags.into_iter());
    }
    let description=["input","title","description","role"].into_iter()
        .filter_map(|key|task.get(key).and_then(Value::as_str))
        .collect::<Vec<_>>().join(" ").to_lowercase();
    for (pattern,label) in [
        (r"image generation|generate (an? )?image|生成图片|图片生成|生图",
            "image_generation"),
        (r"final review|final approval review|最终审核|最终审查|终审",
            "final_review"),
        (r"visual review|image review|视觉审核|图片审核|画面审核",
            "visual_review"),
        (r"vision|image understanding|图像理解|图片理解|看图",
            "vision"),
    ]{
        if Regex::new(pattern).expect("static Task hint regex").is_match(&description){
            tags.push(label.into());
        }
    }
    unique(tags.into_iter())
}
pub fn worker_capability_facts(worker:&Value)->Vec<String>{
    let additions: &[&str]=if field(worker,"adapter")=="chatgpt"{
        &["vision","image_generation","visual_review","final_review"]
    }else{
        &["coding","cli","filesystem"]
    };
    unique(list(worker,"capabilities").iter().filter_map(Value::as_str)
        .chain(additions.iter().copied()).map(str::to_owned))
}
pub fn worker_gate_reasons(worker:&Value,requirements:&Value)->Vec<String>{
    let mut reasons=Vec::new();
    if field(worker,"availability")=="offline"{reasons.push("worker_offline".into());}
    if let Some(runtime)=nonempty(requirements.get("runtime").and_then(Value::as_str)){
        if field(worker,"runtime")!=runtime{reasons.push("runtime_constraint".into());}
    }
    if field(worker,"adapter")=="chatgpt"
        && worker.pointer("/browserWorkspaceCapacity/available").and_then(Value::as_i64)==Some(0){
        reasons.push("browser_workspace_exhausted".into());
    }
    reasons
}
fn same_model_route(candidate:&Value,route:&Value)->bool{
    ["provider","model"].into_iter().all(|key|
        route.get(key).and_then(Value::as_str).is_none_or(|raw|
            raw.is_empty()||raw==field(candidate,key)))
        && route.get("profile").is_none_or(|profile|
            candidate.get("profile").unwrap_or(&Value::Null)==profile)
}
pub fn model_gate_reasons(model:&Value,constraints:Option<&Value>,
    excluded:&[Value],policy:&Value)->Vec<String>{
    let mut reasons=Vec::new();
    if model.get("resourceHealthy")==Some(&Value::Bool(false)){
        reasons.push("resource_unhealthy".into());
    }
    if excluded.iter().any(|route|same_model_route(model,route)){
        reasons.push("prior_failed_route".into());
    }
    if !policy_allows(model,policy){
        if list(policy,"disabledProviders").iter()
            .any(|p|p.as_str()==Some(field(model,"provider"))){
            reasons.push("policy_disabled_provider".into());
        }
        if nonempty(model.get("profile").and_then(Value::as_str))
            .is_some_and(|profile|list(policy,"disabledProfiles").iter()
                .any(|p|p.as_str()==Some(profile))){
            reasons.push("policy_disabled_profile".into());
        }
    }
    if let Some(constraints)=constraints {
        for (key,reason) in [
            ("provider","provider_constraint"),("model","model_constraint"),
            ("profile","profile_constraint"),
        ] {
            if let Some(required)=nonempty(constraints.get(key).and_then(Value::as_str)){
                if field(model,key)!=required{reasons.push(reason.into());}
            }
        }
        if let Some(required)=nonempty(constraints.get("reasoning").and_then(Value::as_str)){
            if let Some(effort)=nonempty(model.get("reasoning").and_then(Value::as_str)){
                if effort!=required{reasons.push("reasoning_constraint".into());}
            }
        }
    }
    reasons
}
fn code_plan(model:&Value)->Value{
    let convert=|window:Option<&Value>|->Value{
        let Some(window)=window else{return Value::Null;};
        json!({"remaining_percent":window.get("remainingPercent"),
            "reset_at":window.get("resetAt"),
            "reset_in_minutes":window.get("resetInMinutes")})
    };
    json!({
        "five_hour":convert(model.pointer("/resourceWindows/fiveHour")),
        "weekly":convert(model.pointer("/resourceWindows/weekly"))
    })
}
pub fn worker_provider_facts(routes:&[Value])->Vec<Value>{
    let mut ordered:Vec<(String,Vec<Value>)>=Vec::new();
    for route in routes{
        let id=route.pointer("/worker/workerId").and_then(Value::as_str)
            .unwrap_or("").to_owned();
        if let Some((_,list))=ordered.iter_mut().find(|(key,_)|key==&id){
            list.push(route.clone());
        }else{ordered.push((id,vec![route.clone()]));}
    }
    ordered.into_iter().map(|(id,routes)|{
        let mut provider_order=Vec::<String>::new();
        let mut providers=serde_json::Map::new();
        for route in &routes{
            let provider=route.pointer("/model/provider")
                .and_then(Value::as_str).unwrap_or("").to_owned();
            if !provider_order.contains(&provider){provider_order.push(provider);}
        }
        for provider in provider_order{
            let variants:Vec<&Value>=routes.iter().filter(|r|
                r.pointer("/model/provider").and_then(Value::as_str)
                    ==Some(provider.as_str())).collect();
            let configured=variants.iter().find(|r|
                !r.pointer("/model/id").and_then(Value::as_str)
                    .unwrap_or("").starts_with("catalog:"))
                .copied().unwrap_or(variants[0]);
            let plan=code_plan(&configured["model"]);
            providers.insert(provider,json!({
                "default":{"model":configured["model"].get("model"),
                    "reasoning":configured["model"].get("reasoning")},
                "code_plan":plan
            }));
        }
        json!({"id":id,"adapter":routes[0]["worker"].get("adapter"),
            "providers":providers})
    }).collect()
}
fn route_id(worker:&Value,model:&Value)->String{
    let worker_id=field(worker,"workerId");
    let id=field(model,"id");
    let reasoning=field(model,"reasoning");
    if reasoning.is_empty(){format!("{worker_id}::{id}")}
    else{format!("{worker_id}::{id}@{reasoning}")}
}
pub fn fallback_route(routes:&[Value])->Option<Value>{
    let codex:Vec<&Value>=routes.iter().filter(|route|
        route.pointer("/worker/adapter").and_then(Value::as_str)==Some("codex")).collect();
    codex.iter().find(|route|
        route.pointer("/model/id").and_then(Value::as_str)
            .unwrap_or("").starts_with("default:"))
        .copied().or_else(||codex.first().copied())
        .or_else(||routes.first()).cloned()
}
fn same_model_key(candidate:&Value,other:&Value)->bool{
    candidate.get("id")==other.get("id")
        && candidate.get("reasoning")==other.get("reasoning")
}
fn profile_defaults(candidates:&[Value])->Vec<Value>{
    candidates.iter().filter(|item|!field(item,"id").starts_with("catalog:"))
        .cloned().collect()
}
fn resolve_explicit_model(choice:&Value,pool:&[Value])->Option<String>{
    let model=field(choice,"model").to_ascii_lowercase();
    if model.is_empty(){return None;}
    if let Some(exact)=pool.iter().find(|item|field(item,"model")
        .eq_ignore_ascii_case(&model)){
        return Some(field(exact,"model").into());
    }
    let suffix=format!("-{model}");
    let matching=unique(pool.iter().map(|item|field(item,"model"))
        .filter(|name|name.to_ascii_lowercase().ends_with(&suffix))
        .map(str::to_owned));
    if matching.len()==1{return Some(matching[0].clone());}
    let hint=Regex::new(r"(?i)^(gpt-\d+(?:\.\d+)?)-[a-z0-9.-]+$")
        .expect("static GPT family matcher");
    if let Some(family)=hint.captures(field(choice,"model")){
        let guess=format!("{}-{model}",&family[1]);
        if let Some(candidate)=pool.iter().find(|item|
            field(item,"model").eq_ignore_ascii_case(&guess)){
            return Some(field(candidate,"model").into());
        }
    }
    None
}
pub fn resolve_explicit_choices(choices:&[Value],pool:&[Value])->Vec<Value>{
    let mut result=Vec::new();
    let mut seen=HashSet::new();
    for choice in choices{
        let provider=field(choice,"provider");
        let available:Vec<Value>=pool.iter().filter(|model|
            field(model,"provider").eq_ignore_ascii_case(provider))
            .cloned().collect();
        let Some(model)=resolve_explicit_model(choice,&available)else{continue;};
        let effort=nonempty(choice.get("reasoning").and_then(Value::as_str));
        let mut matches=available.iter().filter(|candidate|
            field(candidate,"model")==model &&
            effort.is_none_or(|reason|field(candidate,"reasoning")
                .eq_ignore_ascii_case(reason))).cloned().collect::<Vec<_>>();
        matches.sort_by_key(|item|field(item,"id").starts_with("catalog:"));
        if let Some(candidate)=matches.first(){
            let key=format!("{}@{}",field(candidate,"id"),field(candidate,"reasoning"));
            if seen.insert(key){result.push(candidate.clone());}
        }
    }
    result
}
fn merge_candidates(lists:&[Vec<Value>])->Vec<Value>{
    let mut result=Vec::new();
    let mut seen=HashSet::new();
    for list in lists{
        for candidate in list{
            let key=format!("{}@{}",field(candidate,"id"),field(candidate,"reasoning"));
            if seen.insert(key){result.push(candidate.clone());}
        }
    }
    result
}
pub fn execution_choice_label(route:&Value,is_default:bool)->String{
    let label=format!("worker={} provider={} model={} reasoning={} default={}",
        route.pointer("/worker/workerId").and_then(Value::as_str).unwrap_or(""),
        route.pointer("/model/provider").and_then(Value::as_str).unwrap_or(""),
        route.pointer("/model/model").and_then(Value::as_str).unwrap_or(""),
        route.pointer("/model/reasoning").and_then(Value::as_str)
            .unwrap_or("provider-default"),
        is_default);
    match route.pointer("/model/profile").and_then(Value::as_str).filter(|s|!s.is_empty()){
        Some(profile)=>format!("{label} profile={profile}"),
        None=>label,
    }
}
#[derive(Clone,Debug)]
pub struct ExecutionRouteDiscovery{
    pub routes:Vec<Value>,
    pub evaluations:Vec<Value>,
    pub worker_gate_evaluations:Vec<Value>,
    pub policy:Value,
    pub choices:Vec<Value>,
    pub routing_instruction:String,
    pub configured_defaults:HashMap<String,Vec<Value>>,
}
pub fn discover_execution_routes(
    workers:&[Value],requirements:&Value,options:&Value,
    home:&Path,policy_path:&Path,rules_path:&Path,now_ms:i64,
)->Result<ExecutionRouteDiscovery,String>{
    let policy=load_routing_policy(&policy_path.to_string_lossy(),
        &rules_path.to_string_lossy());
    let rules=load_execution_router_rules(&rules_path.to_string_lossy());
    let registered=list(options,"registered");
    let usage=options.get("usage");
    let constraints=options.get("routingConstraints");
    let exclusions=list(options,"excludedRoutes");
    let worker_gate_evaluations:Vec<Value>=workers.iter().map(|worker|{
        let reasons=worker_gate_reasons(worker,requirements);
        json!({"workerId":worker.get("workerId"),
            "eligible":reasons.is_empty(),"rejectionReasons":reasons})
    }).collect();
    let mut evaluations=Vec::new();
    let mut configured_defaults=HashMap::new();
    for worker in workers{
        let reasons=worker_gate_reasons(worker,requirements);
        let discovered=if field(worker,"adapter")=="codex" {
            codex_profile_candidates(home,usage,now_ms)
        }else{discover_model_candidates(worker,registered,usage,home,now_ms)};
        let defaults=profile_defaults(&discovered);
        configured_defaults.insert(field(worker,"workerId").into(),defaults.clone());
        let choices:Vec<Value>=list(&rules["parsed"],"choices").iter()
            .filter(|choice|{
                let bound=field(choice,"worker");
                bound.is_empty() || bound==field(worker,"workerId")
                    || bound==field(worker,"adapter")
            }).cloned().collect();
        let explicit=resolve_explicit_choices(&choices,&discovered);
        let merged=merge_candidates(&[defaults,explicit]);
        for model in merged{
            let mut rejections=reasons.clone();
            rejections.extend(model_gate_reasons(&model,constraints,exclusions,
                &policy["policy"]));
            // A detached caller may further restrict execution to its verified
            // profiles (e.g. visual capability). This cannot add a route.
            if let Some(profiles)=options.get("eligibleProfiles").and_then(Value::as_array){
                let profile=model.get("profile").and_then(Value::as_str).unwrap_or("default");
                if !profiles.iter().any(|value|value.as_str()==Some(profile)){
                    rejections.push("caller_profile_constraint".into());
                }
            }
            let route=json!({"id":route_id(worker,&model),
                "worker":worker,"model":model});
            evaluations.push(json!({"route":route,"eligible":rejections.is_empty(),
                "rejectionReasons":rejections}));
        }
    }
    let routes=evaluations.iter()
        .filter(|record|record.get("eligible")==Some(&Value::Bool(true)))
        .filter_map(|record|record.get("route").cloned()).collect();
    let parsed=&rules["parsed"];
    Ok(ExecutionRouteDiscovery{
        routes,evaluations,worker_gate_evaluations,policy,
        choices:list(parsed,"choices").to_vec(),
        routing_instruction:field(parsed,"routingInstruction").into(),
        configured_defaults,
    })
}
fn worker_selection(worker:&Value,by:&str,evidence:&Value)->Value{
    let mut selected=json!({"workerId":worker.get("workerId"),
        "adapter":worker.get("adapter"),"capabilities":worker.get("capabilities"),
        "selectedBy":by,"selectedAt":iso8601_now(),
        "decisionEvidence":evidence});
    for key in ["resourceHealthy","resourceProvider","resourceUsedPercent",
        "resourceRemainingPercent","resourceResetAt","resourceResetInMinutes",
        "resourceWindows","browserWorkspaceCapacity"]{
        if let Some(v)=worker.get(key).filter(|v|!v.is_null()){
            selected[key]=v.clone();
        }
    }
    selected
}
pub fn execution_routing_facts(
    discovery:&ExecutionRouteDiscovery,workers:&[Value],task_facts:&Value,
    chatgpt_running:u64,preferred_concurrency:u64,recent_outcomes:&[Value],
)->Value{
    let shape=execution_task_shape(task_facts);
    let mut capabilities=serde_json::Map::new();
    for worker in workers{
        capabilities.insert(field(worker,"workerId").into(),
            json!(worker_capability_facts(worker)));
    }
    let mut usage=serde_json::Map::new();
    for route in &discovery.routes{
        let key=format!("{}::{}",
            route.pointer("/worker/workerId").and_then(Value::as_str).unwrap_or(""),
            route.pointer("/model/provider").and_then(Value::as_str).unwrap_or(""));
        if !usage.contains_key(&key){
            let mut record=json!({"worker":route.pointer("/worker/workerId"),
                "provider":route.pointer("/model/provider")});
            if let Some(map)=code_plan(&route["model"]).as_object(){
                for (key,value) in map{record[key]=value.clone();}
            }
            usage.insert(key,record);
        }
    }
    let review=if task_facts.get("reviewer_diversity").is_some_and(|v|!v.is_null()){
        json!({"role":task_facts.get("role"),
            "reviewer_diversity":task_facts.get("reviewer_diversity")})
    }else{Value::Null};
    let task=task_facts.get("task").filter(|v|v.is_object())
        .unwrap_or(task_facts);
    json!({
        "context":{"task_shape":{
            "story_size":shape.get("storySize"),
            "sustained_work":shape.get("sustainedWork"),
            "preferred_worker":shape.get("preferredWorker"),
            "reason":shape.get("reason")
        },"reviewer":review},
        "task_capabilities":task_capability_facts(task_facts),
        "task_worker_capabilities":task.get("workerCapabilities")
            .and_then(Value::as_array).cloned().unwrap_or_default(),
        "worker_capabilities":capabilities,
        "usage_by_provider":usage,
        "runtime":{"chatgpt_running":chatgpt_running,
            "preferred_chatgpt_concurrency":preferred_concurrency},
        "recent_route_results":recent_outcomes
    })
}
pub fn execution_routing_question(
    routing_instruction:&str,model_preference:Option<&Value>
)->String{
    let question=format!(
        "Global routing instructions have priority over default preferences, task size, runtime and resource signals unless an explicit Job routing preference below conflicts. Candidate order is arbitrary and conveys no priority, ranking or preference. Do not favor earlier choices. Select an offered route that obeys the user instructions.\nGlobal routing instructions:\n{routing_instruction}"
    );
    let instructions="Use recent_route_results (up to the last 10 confirmed execution outcomes) to weigh route reliability, including success, failure and the recorded reason. Distinguish provider/runtime faults from task-specific failures and cancellations; historical failures are evidence, not automatic hard exclusions. For vision, image generation, visual review, and final review tasks, prefer ChatGPT Worker when available and within capacity; for coding, CLI and filesystem tasks, prefer Codex. These are soft preferences subordinate to user rules. Choose exactly one listed route; do not invent routes.";
    append_agent_model_preference(
        &append_routing_instruction(&question,instructions),
        model_preference)
}
/// Explicit Job hints outrank global routing guidance, not hard eligibility.
fn append_job_routing_instruction(question:&str,preferences:Option<&Value>)->String{
    let Some(prefs)=preferences.filter(|v|v.as_object().is_some_and(|m|!m.is_empty()))else{
        return question.to_owned();
    };
    let instruction=format!(
        "Job routing preferences (highest-priority advisory routing instructions for this Job; override conflicting global routing instructions and Agent/default preferences):\n{}\nPrefer an eligible offered route matching these exact identifiers. If no eligible route matches all preferences, choose the best available match; if none matches, follow the remaining routing instructions. Never invent a route or bypass explicit Task constraints, availability, authorization or other hard gates. The Decision Engine retains the final choice among eligible routes.",
        prefs);
    append_routing_instruction(question,&instruction)
}
fn route_choice_labels(discovery:&ExecutionRouteDiscovery)->Vec<String>{
    discovery.routes.iter().map(|route|{
        let defaults=discovery.configured_defaults.get(field(&route["worker"],"workerId"))
            .map(Vec::as_slice).unwrap_or(&[]);
        execution_choice_label(route,defaults.iter().any(|c|same_model_key(c,&route["model"])))
    }).collect()
}

/// Invoke the configured engine only at an explicitly authorized live boundary.
/// The same hard-gated selector validates its response and provides fallback.
pub fn route_execution_decide_with(
    discovery:&ExecutionRouteDiscovery,requirements:&Value,workers:&[Value],
    options:&Value,recent_outcomes:&[Value],
    decide:impl FnOnce(&Value,&Value)->Result<Value,String>,
)->Result<Value,String>{
    let mode=options.get("decisionMode").and_then(Value::as_str).unwrap_or("off");
    if mode=="off" || discovery.routes.is_empty(){
        return route_execution_with_choice(discovery,requirements,workers,options,None,None,recent_outcomes,None);
    }
    let choices=route_choice_labels(discovery);
    let mut facts=execution_routing_facts(discovery,workers,
        options.get("taskFacts").unwrap_or(&Value::Null),
        options.get("chatgptRunning").and_then(Value::as_u64).unwrap_or(0),
        options.get("preferredChatgptConcurrency").and_then(Value::as_u64)
            .unwrap_or(DEFAULT_CHATGPT_PREFERRED_CONCURRENCY),recent_outcomes);
    // Only bounded capability facts and explicit routing hints are sent.
    if let Some(prefs)=options.pointer("/taskFacts/routingPreferences").filter(|v|v.is_object()){
        facts["job_routing_preferences"]=prefs.clone();
    }
    let mut question=append_job_routing_instruction(
        &execution_routing_question(&discovery.routing_instruction,options.get("modelPreference")),
        options.pointer("/taskFacts/routingPreferences"));
    if let Some(instruction)=options.get("routingInstruction").and_then(Value::as_str)
        .filter(|s|!s.trim().is_empty()){
        facts["caller_routing_instruction"]=json!(instruction);
        facts["routing_instruction"]=json!(discovery.routing_instruction);
        question=append_routing_instruction(&question,&format!(
            "Caller routing instructions (highest-priority advisory routing instructions for this call; override conflicting global routing instructions, structured routing preferences and default preferences):\n{instruction}\nChoose only among offered eligible routes. Never invent or enable a route or bypass availability, authorization or hard constraints."));
    }
    let contract=json!({"type":"choice","question":question,"choices":choices});
    let engine=crate::decision::JevDecisionEngine::NAME;
    let result=crate::decision::decide_choice_with(&json!({"facts":facts}),&contract,decide);
    let (choice,evidence,stage)=match result{
        Ok(answer)=>{
            let choice=answer["choice"].as_str().ok_or("Decision choice missing")?.to_owned();
            let bypassed=answer["bypassed"]==true;
            let mut evidence=json!({"mode":mode,"engine":engine,"proposed":choice,
                "fallback":mode=="shadow","bypassed":bypassed});
            for key in ["probabilities","usage","latencyMs","model"]{
                if let Some(value)=answer.get(key){evidence[key]=value.clone();}
            }
            let stage=json!({"name":"route","facts":facts,"contract":contract,"result":answer});
            (if mode=="shadow"{None}else{Some(choice)},evidence,stage)
        }
        Err(error)=>(None,json!({"mode":mode,"engine":engine,"fallback":true,
            "error":crate::decision_audit::route_reason(&error)}),
            json!({"name":"route","facts":facts,"contract":contract,
                "result":{"error":crate::decision_audit::route_reason(&error)}}))
    };
    let mut routed=route_execution_with_choice(discovery,requirements,workers,options,
        choice.as_deref(),Some(evidence),recent_outcomes,None)?;
    if routed["audit"].is_object(){
        routed["audit"]["decision_input"]["stages"]=json!([stage]);
    }
    Ok(routed)
}

pub fn route_execution_decide(
    discovery:&ExecutionRouteDiscovery,requirements:&Value,workers:&[Value],
    options:&Value,recent_outcomes:&[Value],
)->Result<Value,String>{
    route_execution_decide_with(discovery,requirements,workers,options,recent_outcomes,
        |request,contract|crate::decision::execution_decision_engine().decide(request,contract))
}

pub fn route_execution_with_choice(
    discovery:&ExecutionRouteDiscovery,requirements:&Value,workers:&[Value],
    options:&Value,model_choice:Option<&str>,mut evidence:Option<Value>,
    recent_outcomes:&[Value],audit:Option<Value>,
)->Result<Value,String>{
    if discovery.routes.is_empty(){
        return Err("No executable worker+model route satisfies authoritative constraints".into());
    }
    let fallback=if discovery.routes.iter().all(|r|
        r.pointer("/worker/adapter").and_then(Value::as_str)==Some("codex")){
        let models:Vec<Value>=discovery.routes.iter().map(|r|r["model"].clone()).collect();
        let chosen=deterministic_model(&models,
            options.pointer("/taskFacts/task/kind").and_then(Value::as_str),
            &discovery.policy["policy"]);
        discovery.routes.iter().find(|r|r["model"]==chosen)
            .cloned().expect("ranked route must be eligible")
    }else{fallback_route(&discovery.routes).expect("routes checked non-empty")};
    let mode=options.get("decisionMode").and_then(Value::as_str).unwrap_or("off");
    // Rank existing *eligible* routes only: no new model, runtime, or provider
    // is enabled by a preference. An authenticated typed choice wins below.
    let preferences=options.pointer("/taskFacts/routingPreferences")
        .filter(|value|value.as_object().is_some_and(|m|!m.is_empty()))
        .or_else(||options.get("fallbackRoutingPreferences").filter(|v|v.is_object()));
    let preferred=preferences.and_then(|prefs|{
        // Keep the canonical deterministic fallback on ties; hints only
        // change the selection when another route is a better match.
        let fallback_score=job_routing_preferences::match_score(prefs,
            field(&fallback["worker"],"adapter"),&fallback["model"]);
        let mut best_score=fallback_score;
        let mut best=None;
        for route in &discovery.routes {
            let score=job_routing_preferences::match_score(prefs,
                field(&route["worker"],"adapter"),&route["model"]);
            if score>best_score {
                best_score=score;
                best=Some(route.clone());
            }
        }
        best
    });
    let preferred_used=preferred.is_some() && model_choice.is_none();
    let mut selected=preferred.unwrap_or(fallback.clone());
    if let Some(choice)=model_choice {
        let choices=route_choice_labels(discovery);
        if let Some(index)=choices.iter().position(|label|label==choice){
            selected=discovery.routes[index].clone();
        }else{
            return Err("Decision engine selected a route outside the merged choice list".into());
        }
    }
    let default_evidence=if preferred_used{
        json!({"mode":mode,"fallback":true,"reason":"job-routing-preference",
            "routingPreferences":preferences})
    }else{json!({"mode":mode,"fallback":true})};
    if evidence.is_none(){evidence=Some(default_evidence);}
    let mut evidence=evidence.expect("fallback evidence");
    // Jev chooses the route identity. Reasoning is a deterministic turn option,
    // independent of the chosen profile's default. Hard constraints stay first.
    let effort_sources=[
        ("task",options.pointer("/routingConstraints/reasoning")),
        ("job",preferences.and_then(|p|p.get("reasoning"))),
        ("agent",options.pointer("/modelPreference/reasoning")),
        ("selected",selected["model"].get("reasoning")),
    ];
    let effort=effort_sources.into_iter().find_map(|(source,value)|
        value.and_then(Value::as_str).filter(|s|!s.is_empty()).map(|s|(source,s.to_owned())));
    if let Some((source,requested))=effort {
        let previous=selected["model"].get("reasoning").cloned();
        if field(&selected["worker"],"adapter")=="codex" {
            // Use the same executable argument contract as actual fresh/resume turns.
            let probe=json!({"provider":selected["model"]["provider"],"model":selected["model"]["model"],"reasoning":requested});
            crate::native_codex_thread::codex_route_flags(&probe)?;
            if let Some(levels)=selected["model"].get("supportedReasoningLevels").and_then(Value::as_array){
                if !levels.iter().any(|level|level.as_str()==Some(requested.as_str())) {
                    return Err(format!("Selected model {}/{} does not support requested reasoning {requested}",field(&selected["model"],"provider"),field(&selected["model"],"model")));
                }
            }
        }
        if source!="selected" {
            let verified=selected["model"].get("supportedReasoningLevels").is_some();
            evidence["reasoningResolution"]=json!({"source":source,"selected":previous,"effective":requested,
                "catalogVerified":verified});
        }
        selected["model"]["reasoning"]=json!(requested);
    }
    let powered=evidence.get("engine").is_some_and(|v|!v.is_null())
        && evidence.get("fallback")==Some(&Value::Bool(false));
    let by=if powered && evidence.get("engine").and_then(Value::as_str)==Some(crate::decision::JevDecisionEngine::NAME){
        if evidence["bypassed"]==true{"execution-router:single-choice"}else{"execution-router:jev"}
    }else if powered{"execution-router:laya"}
        else if preferred_used{"execution-router:job-preference"}
        else{"execution-router:fallback"};
    let mut routing=json!({
        "provider":selected["model"].get("provider"),
        "model":selected["model"].get("model"),
        "decidedBy":by,"decidedAt":iso8601_now(),
        "decisionEvidence":evidence
    });
    if let Some(profile)=selected["model"].get("profile"){
        routing["profile"]=profile.clone();
    }
    if let Some(reasoning)=selected["model"].get("reasoning"){
        routing["reasoning"]=reasoning.clone();
    }
    let audit=if audit.is_none() && options.get("recordDecisionAudit")==Some(&Value::Bool(true)){
        Some(crate::decision_audit::make_execution_decision_audit(
            options.pointer("/taskFacts/task"),workers,requirements,
            &discovery.evaluations,&discovery.worker_gate_evaluations,&selected,
            &json!({"question":"worker-model-selection","choices":discovery.choices}),
            &discovery.policy,&routing,&[]))
    }else{audit};
    if let Some(audit)=&audit{
        routing["decisionId"]=audit.get("decision_id").cloned().unwrap_or(Value::Null);
    }
    let mut candidate=selected["worker"].clone();
    candidate["routing"]=routing.clone();
    let selection=worker_selection(&candidate,by,&evidence);
    let facts=execution_routing_facts(
        discovery,workers,options.get("taskFacts").unwrap_or(&json!({})),
        options.get("chatgptRunning").and_then(Value::as_u64).unwrap_or(0),
        options.get("preferredChatgptConcurrency").and_then(Value::as_u64)
            .unwrap_or(DEFAULT_CHATGPT_PREFERRED_CONCURRENCY),recent_outcomes
    );
    Ok(json!({"candidate":candidate,"selection":selection,
        "model":selected["model"],"routing":routing,"audit":audit,
        "facts":facts,"workerRequirements":requirements}))
}

/// Canonical route discovery and selection for detached CLI calls and managed
/// Model Agents. The caller controls whether a Decision Engine is authorized;
/// both paths use the same eligibility gates, policy, fallback and result.
/// The injected decision function makes this boundary deterministic in tests.
pub fn select_execution_route_with<Decide>(
    workers:&[Value],requirements:&Value,options:&Value,
    home:&Path,policy_path:&Path,rules_path:&Path,now_ms:i64,
    recent_outcomes:&[Value],use_decision_engine:bool,decide:Decide,
)->Result<Value,String>
where Decide:FnOnce(&Value,&Value)->Result<Value,String>{
    let discovery=discover_execution_routes(workers,requirements,options,
        home,policy_path,rules_path,now_ms)?;
    if use_decision_engine{
        route_execution_decide_with(&discovery,requirements,workers,options,
            recent_outcomes,decide)
    }else{
        route_execution_with_choice(&discovery,requirements,workers,options,
            None,None,recent_outcomes,None)
    }
}

pub fn select_execution_route(
    workers:&[Value],requirements:&Value,options:&Value,
    home:&Path,policy_path:&Path,rules_path:&Path,now_ms:i64,
    recent_outcomes:&[Value],use_decision_engine:bool,
)->Result<Value,String>{
    select_execution_route_with(workers,requirements,options,
        home,policy_path,rules_path,now_ms,recent_outcomes,use_decision_engine,
        |request,contract|crate::decision::execution_decision_engine().decide(request,contract))
}

/// Node routeExecution entrypoint. Model/Worker eligibility comes from one
/// validated route discovery; only the decision choice is passed back by
/// a caller-provided Decision Engine. No second routing policy is invented.
pub fn route_execution(
    workers:&[Value],requirements:&Value,options:&Value,
    home:&Path,policy_path:&Path,rules_path:&Path,now_ms:i64,
    proposed_choice:Option<&str>,evidence:Option<Value>,
    recent_outcomes:&[Value],audit:Option<Value>,
)->Result<Value,String>{
    let mut result=if proposed_choice.is_none() && evidence.is_none() && audit.is_none(){
        select_execution_route(workers,requirements,options,
            home,policy_path,rules_path,now_ms,recent_outcomes,
            options["useDecisionEngine"]==true)?
    }else{
        let discovery=discover_execution_routes(workers,requirements,options,
            home,policy_path,rules_path,now_ms)?;
        route_execution_with_choice(&discovery,requirements,workers,options,
            proposed_choice,evidence,recent_outcomes,audit)?
    };
    // Public Node routeExecution returns the chosen candidate, selection,
    // model, routing and audit. The extra eligibility facts stay internal.
    if let Some(map)=result.as_object_mut(){
        map.remove("facts");map.remove("workerRequirements");
        map.remove("routing");
    }
    Ok(result)
}
