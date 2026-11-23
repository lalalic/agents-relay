// Node provenance: src/model-routing.ts. Native discovery of an actually
// configured Codex model/profile; policies and explicit constraints are
// hard gates, decision engines never create models or bypass exclusions.
use crate::{
    local_merge_lock::iso8601_now,
    router_rules::append_routing_instruction,
    routing_policy::{load_routing_policy,policy_allows,policy_rank},
    worker_routing::usage_for_provider,
};
use serde_json::{json,Value};
use std::{collections::HashSet,fs,path::{Path,PathBuf}};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn model_choice_id(candidate:&Value)->String{
    let id=field(candidate,"id");
    let effort=field(candidate,"reasoning");
    if effort.is_empty(){id.to_owned()}else{format!("{id}@{effort}")}
}
pub fn default_codex_home()->PathBuf{
    std::env::var("CODEX_HOME").map(PathBuf::from).unwrap_or_else(|_|
        std::env::var("HOME").map(|home|PathBuf::from(home).join(".codex"))
            .unwrap_or_else(|_|PathBuf::from(".codex")))
}
pub fn top_level_codex_config(raw:&str)->Value{
    let mut output=json!({});
    let mut in_section=false;
    for raw_line in raw.lines(){
        let line=raw_line.trim();
        if line.is_empty()||line.starts_with('#'){continue;}
        if line.starts_with('['){in_section=true;continue;}
        if in_section {continue;}
        let Some((key,value))=line.split_once('=') else{continue;};
        let key=key.trim();
        let value=value.trim();
        if !value.starts_with('"'){continue;}
        let Some(end)=value[1..].find('"') else{continue;};
        let content=&value[1..end+1];
        let dest=match key{
            "model"=>"model","model_provider"=>"provider",
            "model_reasoning_effort"=>"reasoning",_=>continue,
        };
        if !content.is_empty(){output[dest]=json!(content);}
    }
    output
}
fn read_config(path:&Path)->Option<Value>{
    fs::read_to_string(path).ok().map(|s|top_level_codex_config(&s))
}
pub fn configured_codex_default(home:&Path)->Option<Value>{
    let config=read_config(&home.join("config.toml"))?;
    let model=config.get("model").and_then(Value::as_str)?;
    let mut result=json!({
        "provider":config.get("provider").and_then(Value::as_str).unwrap_or("openai"),
        "model":model
    });
    if let Some(reasoning)=config.get("reasoning"){
        result["reasoning"]=reasoning.clone();
    }
    Some(result)
}
fn add_resource(candidate:&mut Value,usage:Option<&Value>,now:i64) {
    let provider=field(candidate,"provider").to_owned();
    let resource=usage_for_provider(usage,&provider,now);
    for (source,target) in [
        ("healthy","resourceHealthy"),("usedPercent","resourceUsedPercent"),
        ("remainingPercent","resourceRemainingPercent"),
        ("resetAt","resourceResetAt"),("resetInMinutes","resourceResetInMinutes"),
        ("windows","resourceWindows")
    ] {
        if let Some(v)=resource.get(source).filter(|v|!v.is_null()){
            candidate[target]=v.clone();
        }
    }
}
fn catalog_candidates(home:&Path,usage:Option<&Value>,now:i64)->Vec<Value>{
    let Ok(raw)=fs::read_to_string(home.join("models_cache.json"))
        else{return Vec::new();};
    let Ok(parsed)=serde_json::from_str::<Value>(&raw)else{return Vec::new();};
    let Some(models)=parsed.get("models").and_then(Value::as_array)
        else{return Vec::new();};
    let mut visible:Vec<Value>=models.iter()
        .filter(|m|m.get("slug").and_then(Value::as_str).is_some()
            && field(m,"visibility")=="list"
            && m.get("supported_in_api")!=Some(&Value::Bool(false)))
        .cloned().collect();
    visible.sort_by_key(|m|m.get("priority").and_then(Value::as_i64).unwrap_or(999));
    let mut result=Vec::new();
    for model in visible{
        let slug=field(&model,"slug");
        let efforts:Vec<String>=model.get("supported_reasoning_levels")
            .and_then(Value::as_array).into_iter().flatten()
            .filter_map(|level|level.get("effort").and_then(Value::as_str))
            .filter(|s|!s.is_empty()).map(str::to_owned).collect();
        let reasoning:Vec<Option<String>>=if !efforts.is_empty(){
            efforts.into_iter().map(Some).collect()
        }else{vec![model.get("default_reasoning_level")
            .and_then(Value::as_str).map(str::to_owned)]};
        for effort in reasoning {
            let mut candidate=json!({
                "id":format!("catalog:openai/{slug}"),"provider":"openai","model":slug
            });
            if let Some(effort)=effort{candidate["reasoning"]=json!(effort);}
            add_resource(&mut candidate,usage,now);
            result.push(candidate);
        }
    }
    result
}
pub fn discover_model_candidates(
    worker:&Value,registered:&[Value],usage:Option<&Value>,
    home:&Path,now:i64,
)->Vec<Value>{
    let registration=registered.iter().find(|agent|
        agent.get("id")==worker.get("workerId"));
    if let Some(agent)=registration{
        if let (Some(provider),Some(model))=(
            agent.pointer("/runtime/provider").and_then(Value::as_str),
            agent.pointer("/runtime/model").and_then(Value::as_str)
        ){
            let mut candidate=json!({
                "id":format!("{provider}/{model}"),"provider":provider,"model":model
            });
            add_resource(&mut candidate,usage,now);
            return vec![candidate];
        }
    }
    let adapter=field(worker,"adapter");
    if adapter=="z" || adapter=="chatgpt"{
        let (id,provider,model)=if adapter=="z"{
            ("z/GLM-5.3-Flash","z","GLM-5.3-Flash")
        }else{("chatgpt/account-defaults","chatgpt","account-defaults")};
        let mut candidate=json!({"id":id,"provider":provider,"model":model});
        add_resource(&mut candidate,usage,now);
        return vec![candidate];
    }
    let base=read_config(&home.join("config.toml")).unwrap_or(json!({}));
    let mut candidates=Vec::new();
    let default_provider=base.get("provider").and_then(Value::as_str).unwrap_or("openai");
    let default_model=base.get("model").and_then(Value::as_str);
    let base_reason=base.get("reasoning").and_then(Value::as_str);
    if let Some(model)=default_model{
        let mut candidate=json!({
            "id":format!("default:{default_provider}/{model}"),
            "provider":default_provider,"model":model
        });
        if let Some(reason)=base_reason{candidate["reasoning"]=json!(reason);}
        add_resource(&mut candidate,usage,now);
        candidates.push(candidate);
    }
    if default_provider=="openai"{
        for item in catalog_candidates(home,usage,now){
            if item.get("model").and_then(Value::as_str)==default_model
                && item.get("reasoning").and_then(Value::as_str)==base_reason {
                continue;
            }
            candidates.push(item);
        }
    }
    let mut files=fs::read_dir(home).ok().into_iter().flatten()
        .filter_map(Result::ok)
        .filter_map(|entry|entry.file_name().to_str().map(str::to_owned))
        .filter(|file|file.ends_with(".config.toml")).collect::<Vec<_>>();
    files.sort();
    for file in files {
        let Some(config)=read_config(&home.join(&file))else{continue;};
        let Some(model)=config.get("model").and_then(Value::as_str)else{continue;};
        let profile=file.trim_end_matches(".config.toml");
        let provider=config.get("provider").and_then(Value::as_str)
            .unwrap_or(default_provider);
        let mut candidate=json!({
            "id":format!("{profile}:{provider}/{model}"),
            "provider":provider,"model":model,"profile":profile
        });
        if let Some(reason)=config.get("reasoning").and_then(Value::as_str).or(base_reason){
            candidate["reasoning"]=json!(reason);
        }
        add_resource(&mut candidate,usage,now);
        candidates.push(candidate);
    }
    if candidates.is_empty(){
        let mut candidate=json!({
            "id":"default:openai/gpt-5.6-luna",
            "provider":"openai","model":"gpt-5.6-luna"
        });
        add_resource(&mut candidate,usage,now);
        candidates.push(candidate);
    }
    let mut seen=HashSet::new();
    candidates.retain(|c|seen.insert(model_choice_id(c)));
    candidates
}
/// One configured model per Codex profile: the base config is the implicit
/// `default` profile, and each `<name>.config.toml` defines exactly one model.
/// Catalog models are deliberately NOT fallback profiles.
pub fn codex_profile_candidates(home:&Path,usage:Option<&Value>,now_ms:i64)->Vec<Value>{
    let mut used=HashSet::new();
    discover_model_candidates(&json!({"adapter":"codex","workerId":"codex"}),
        &[],usage,home,now_ms).into_iter().filter(|candidate|{
        field(candidate,"id").starts_with("default:")
            ||candidate.get("profile").and_then(Value::as_str)
                .is_some_and(|v|!v.is_empty())
    }).filter(|candidate|{
        let profile=candidate.get("profile").and_then(Value::as_str)
            .unwrap_or("default");
        used.insert(profile.to_string())
    }).collect()
}

fn same_route(candidate:&Value,route:&Value)->bool{
    ["provider","model"].iter().all(|key|
        route.get(*key).and_then(Value::as_str)
            .is_none_or(|v|v.is_empty()||v==field(candidate,key)))
        && route.get("profile").is_none_or(|profile|
            candidate.get("profile").unwrap_or(&Value::Null)==profile)
}
pub fn eligible_models(
    candidates:&[Value],constraints:Option<&Value>,
    policy:&Value,excluded:&[Value],
)->Vec<Value>{
    candidates.iter().filter(|model|{
        if model.get("resourceHealthy")==Some(&Value::Bool(false)){return false;}
        if excluded.iter().any(|route|same_route(model,route)){return false;}
        if !policy_allows(model,policy){return false;}
        if let Some(constraints)=constraints {
            for key in ["provider","model","profile"] {
                if let Some(require)=constraints.get(key).and_then(Value::as_str)
                    .filter(|s|!s.is_empty()){
                    if field(model,key)!=require{return false;}
                }
            }
            if let Some(require)=constraints.get("reasoning").and_then(Value::as_str)
                .filter(|s|!s.is_empty()){
                let effort=field(model,"reasoning");
                if !effort.is_empty()&&effort!=require{return false;}
            }
        }
        true
    }).cloned().collect()
}
fn pressure(model:&Value)->u8 {
    match model.get("resourceUsedPercent").and_then(Value::as_f64){
        None=>1,
        Some(value) if value>=90.0=>2,
        Some(_)=>0,
    }
}
pub fn deterministic_model(candidates:&[Value],task_kind:Option<&str>,policy:&Value)->Value{
    let mut ordered:Vec<(usize,&Value)>=candidates.iter().enumerate().collect();
    ordered.sort_by(|(left_index,left),(right_index,right)|{
        pressure(left).cmp(&pressure(right))
        .then_with(||policy_rank(right,task_kind,policy)
            .cmp(&policy_rank(left,task_kind,policy)))
        .then_with(||left_index.cmp(right_index))
    });
    ordered[0].1.clone()
}
pub fn model_selection_contract(
    worker:&Value,eligible:&[Value],task:Option<&Value>,
    policy:&Value,prior_decision_id:Option<&str>,
    prior_failure:Option<&Value>,
)->Value{
    json!({
        "facts":{
            "task":task.cloned().unwrap_or(json!({})),
            "structured_policy":policy.get("snapshot"),
            "prior_decision_id":prior_decision_id,
            "prior_failure":prior_failure,
            "worker":{"id":worker.get("workerId"),
                "adapter":worker.get("adapter"),
                "capabilities":worker.get("capabilities")},
            "candidates":eligible.iter().map(|model|json!({
                "id":model.get("id"),"provider":model.get("provider"),
                "model":model.get("model"),"profile":model.get("profile"),
                "reasoning":model.get("reasoning"),
                "resourceHealthy":model.get("resourceHealthy"),
                "resourceUsedPercent":model.get("resourceUsedPercent"),
                "resourceRemainingPercent":model.get("resourceRemainingPercent"),
                "resourceResetAt":model.get("resourceResetAt"),
                "resourceResetInMinutes":model.get("resourceResetInMinutes"),
                "resourceWindows":model.get("resourceWindows")
            })).collect::<Vec<_>>()
        },
        "type":"choice",
        "question":append_routing_instruction(
            "Which eligible model profile is best suited to execute this task? Apply hard gates first, then explicit task constraints, then structured policy; consider every quota window and never violate task fit or continuity.",
            policy.pointer("/rules/parsed/routingInstruction")
                .and_then(Value::as_str).unwrap_or("")),
        "choices":eligible.iter().map(model_choice_id).collect::<Vec<_>>()
    })
}
/// A complete Model Router result. Caller optionally passes an authenticated
/// model decision and audit receipt; missing/invalid decision falls back to
/// the deterministic configured profile without inventing a provider.
pub fn route_model_with_choice(
    worker:&Value,candidates:&[Value],
    options:&Value,policy:&Value,
    model_choice:Option<&str>,evidence:Option<&Value>,
    audit:Option<Value>,
)->Result<Value,String>{
    let excluded=options.get("excludedRoutes").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[]);
    let eligible=eligible_models(candidates,options.get("constraints"),
        &policy["policy"],excluded);
    if eligible.is_empty(){
        return Err(format!("No eligible model profile is usable by worker {}",
            field(worker,"workerId")));
    }
    let task_kind=options.pointer("/taskFacts/kind").and_then(Value::as_str);
    let deterministic=deterministic_model(&eligible,task_kind,&policy["policy"]);
    let selected=model_choice.and_then(|choice|eligible.iter()
        .find(|model|model_choice_id(model)==choice))
        .cloned().unwrap_or(deterministic);
    let mode=options.get("decisionMode").and_then(Value::as_str).unwrap_or("off");
    let mut evidence=evidence.cloned().unwrap_or(json!({
        "mode":mode,"fallback":true
    }));
    if eligible.len()==1{
        evidence=json!({"mode":mode,"fallback":true});
    }
    let powered=evidence.get("engine").is_some_and(|v|!v.is_null())
        && evidence.get("fallback")!=Some(&Value::Bool(true));
    let mut routing=json!({
        "provider":selected.get("provider"),
        "model":selected.get("model"),
        "decidedBy":if powered{"model-router:laya"}else{"model-router"},
        "decidedAt":iso8601_now(),"decisionEvidence":evidence
    });
    if let Some(profile)=selected.get("profile"){routing["profile"]=profile.clone();}
    if let Some(reasoning)=options.pointer("/constraints/reasoning")
        .filter(|v|!v.is_null()).or_else(||selected.get("reasoning")){
        routing["reasoning"]=reasoning.clone();
    }
    if let Some(audit)=&audit{
        routing["decisionId"]=audit.get("decision_id").cloned().unwrap_or(Value::Null);
    }
    Ok(json!({"candidate":selected,"routing":routing,"audit":audit}))
}

/// Node routeModel entrypoint. Policy is read from explicit paths. Provider
/// decision evidence is injected and the shared native selection contract
/// checks eligibility; no unconfigured LLM, CLI or account reader is run.
pub fn route_model(
    worker:&Value,candidates:&[Value],options:&Value,
    policy_path:&str,rules_path:&str,
    proposed_choice:Option<&str>,evidence:Option<&Value>,audit:Option<Value>,
)->Result<Value,String>{
    let policy=crate::routing_policy::load_routing_policy(policy_path,rules_path);
    route_model_with_choice(worker,candidates,options,&policy,
        proposed_choice,evidence,audit)
}
