// Node provenance: src/decision-audit.ts. Decision outcomes are private
// JSONL data; only bounded, content-free reason CODES may enter later
// cross-Job model routing prompts. Never copy raw worker errors into facts.
use crate::{
    audit_tail::read_jsonl_newest_first,
    events::random_uuid,
    local_merge_lock::iso8601_now,
    model_routing::model_choice_id,
};
use regex::Regex;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::{HashMap,HashSet},fs::{self,OpenOptions},
    io::Write,path::{Path,PathBuf}};

pub const DECISION_AUDIT_SCHEMA_VERSION:u64=5;
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn nonempty(v:Option<&Value>)->Option<&str> {
    v.and_then(Value::as_str).filter(|s|!s.trim().is_empty())
}
pub fn route_reason(message:&str)->String{
    let normalized=Regex::new(r"\s+").expect("regex").replace_all(message," ");
    let bearer=Regex::new(r"(?i)\b(Bearer\s+)[A-Za-z0-9._~-]+")
        .expect("regex").replace_all(&normalized,r"${1}[redacted]");
    let secret=Regex::new(
        r"(?i)\b((?:api[_ -]?key|secret|password|access[_ -]?token|token|credential|authorization)\s*[:=]\s*)[^\s,;]+"
    ).expect("regex").replace_all(&bearer,r"${1}[redacted]");
    secret.encode_utf16().take(240)
        .collect::<Vec<_>>().windows(1).map(|one|one[0])
        .collect::<Vec<u16>>()
        .chunks(240).next().map(String::from_utf16_lossy)
        .unwrap_or_default()
}
pub fn router_reason_code(kind:&str,summary:&str)->&'static str{
    match kind{
        "success"=>"task_completed",
        "cancelled"=>"task_cancelled",
        "blocked"=>"task_blocked",
        "outcome_unknown"=>"execution_outcome_unknown",
        "auth_config_failure"=>"authentication_rejected",
        "timeout"=>"worker_timeout",
        "launch_failure"=>"worker_launch_failed",
        "provider_failure"=>{
            let pattern=|raw:&str|Regex::new(raw).expect("static outcome regex")
                .is_match(summary);
            if pattern(r"(?i)stream disconnected|response\.completed") {
                "provider_stream_disconnected"
            }else if pattern(r"(?i)rate[_ .-]?limit(?:[_ .-]?exceeded)?|HTTP 429"){
                "provider_rate_limited"
            }else if pattern(r"(?i)quota|credits? exhausted"){
                "provider_quota_exhausted"
            }else{"provider_failure"}
        },
        "runtime_failure"=>"worker_runtime_failure",
        "semantic_failure"=>"task_semantic_failure",
        _=>"task_reported_failure",
    }
}
pub fn route_result(record:&Value,route:&Value)->Option<Value>{
    for key in ["worker","adapter","provider","model"]{
        if nonempty(route.get(key)).is_none(){return None;}
    }
    let kind=field(record,"kind");
    let result=match kind{
        "success"=>"success","cancelled"=>"cancelled",
        "blocked"=>"blocked","outcome_unknown"=>"unknown",_=>"failure"
    };
    let failure=if matches!(kind,"success"|"cancelled"|"blocked"|"outcome_unknown"){
        Value::Null
    }else{json!(kind)};
    // Node's RouterRouteResult passes profile/reasoning through textField():
    // a non-blank string survives, anything else (empty, whitespace-only,
    // null, objects, arrays) becomes null.
    let text_field=|value:Option<&Value>|nonempty(value)
        .map(|s|json!(s)).unwrap_or(Value::Null);
    Ok::<Value,()>(json!({
        "timestamp":record.get("timestamp"),"worker":route.get("worker"),
        "adapter":route.get("adapter"),"provider":route.get("provider"),
        "model":route.get("model"),
        "profile":text_field(route.get("profile")),
        "reasoning":text_field(route.get("reasoning")),
        "result":result,
        "failure_kind":failure,"reason":router_reason_code(kind,field(record,"summary"))
    })).ok()
}
fn outcome_attempt_key(record:&Value)->String{
    let evidence=&record["evidence"];
    let attempt=evidence.get("attempt").and_then(Value::as_i64)
        .map(|value|format!("attempt:{value}"));
    let execution=nonempty(evidence.get("execution_id"))
        .map(str::to_owned).or(attempt)
        .unwrap_or_else(||"legacy".into());
    json!([record.get("decision_id"),execution]).to_string()
}
pub fn recent_execution_route_results(records:&[Value],limit:usize)->Vec<Value>{
    let mut decisions=HashMap::<String,Value>::new();
    let mut outcomes=HashMap::<String,(Value,usize)>::new();
    for (order,record) in records.iter().enumerate(){
        if field(record,"record_type")=="decision"{
            decisions.insert(field(record,"decision_id").into(),record.clone());
        }else if field(record,"record_type")=="outcome"
            && field(record,"kind")!="task_started"{
            let key=outcome_attempt_key(record);
            let replace=outcomes.get(&key).is_none_or(|(saved,old)|
                field(record,"timestamp")>field(saved,"timestamp")
                    || (field(record,"timestamp")==field(saved,"timestamp") && order>*old));
            if replace{outcomes.insert(key,(record.clone(),order));}
        }
    }
    let mut results=Vec::<(Value,usize)>::new();
    for (record,order) in outcomes.into_values(){
        let Some(decision)=decisions.get(field(&record,"decision_id"))else{continue;};
        let route=&decision["selected"];
        let mapped=json!({
            "worker":route.pointer("/worker/id"),
            "adapter":route.pointer("/worker/adapter"),
            "provider":route.pointer("/model/provider"),
            "model":route.pointer("/model/model"),
            "profile":route.pointer("/model/profile"),
            "reasoning":route.pointer("/model/reasoning")
        });
        if let Some(result)=route_result(&record,&mapped){results.push((result,order));}
    }
    results.sort_by(|(a,a_order),(b,b_order)|
        field(b,"timestamp").cmp(field(a,"timestamp"))
            .then_with(||b_order.cmp(a_order)));
    results.into_iter().take(limit.min(10)).map(|(item,_)|item).collect()
}
pub fn sanitize(value:&Value,key:&str)->Value{
    if Regex::new(r"(?i)token|secret|password|credential|authorization|api.?key")
        .expect("fixed audit secret pattern").is_match(key){
        return json!("[redacted]");
    }
    match value{
        Value::Array(items)=>json!(items.iter().map(|v|sanitize(v,""))
            .collect::<Vec<_>>()),
        Value::Object(items)=>{
            let mut filtered=serde_json::Map::new();
            for (key,value) in items{
                filtered.insert(key.clone(),sanitize(value,key));
            }
            Value::Object(filtered)
        },
        _=>value.clone(),
    }
}
#[derive(Clone,Debug)]
pub struct JsonlDecisionAuditStore{pub path:PathBuf}
impl JsonlDecisionAuditStore {
    pub fn new(path:impl Into<PathBuf>)->Self{Self{path:path.into()}}
    pub fn append(&self,record:&Value)->Result<(),String>{
        if let Some(parent)=self.path.parent(){
            fs::create_dir_all(parent).map_err(|error|error.to_string())?;
        }
        let mut file=OpenOptions::new().create(true).append(true)
            .open(&self.path).map_err(|error|error.to_string())?;
        writeln!(file,"{}",sanitize(record,"")).map_err(|error|error.to_string())
    }
    pub fn read(&self)->Vec<Value>{
        let Ok(raw)=fs::read_to_string(&self.path)else{return Vec::new();};
        // Node splits on /\r?\n/, filters empty strings and JSON.parses each
        // line inside one try/catch: a single malformed line fails the whole
        // read to []. Empty segments (blank lines) are skipped, CRLF lines
        // parse because the \r is consumed by the split.
        let mut records=Vec::new();
        for line in raw.split("\r\n").flat_map(|chunk|chunk.split('\n')){
            if line.is_empty(){continue;}
            match serde_json::from_str(line){
                Ok(value)=>records.push(value),
                Err(_)=>return Vec::new(),
            }
        }
        records
    }
    pub fn read_recent_routes(&self,limit:usize)->Vec<Value>{
        let cap=limit.min(10);
        if cap==0{return Vec::new();}
        let records=read_jsonl_newest_first(&self.path).unwrap_or_default();
        let mut selected=Vec::new();
        let mut seen=HashSet::new();
        let mut needs_legacy=false;
        for record in &records{
            if field(record,"record_type")!="outcome"
                || field(record,"kind")=="task_started"{continue;}
            let key=outcome_attempt_key(record);
            if !seen.insert(key){continue;}
            let route=record.pointer("/evidence/route");
            if let Some(route)=route{
                if let Some(result)=route_result(record,route){
                    selected.push(result);
                }else{needs_legacy=true;}
            }else{needs_legacy=true;}
            if seen.len()>=cap{break;}
        }
        if needs_legacy{return recent_execution_route_results(&self.read(),cap);}
        selected.sort_by(|a,b|field(b,"timestamp").cmp(field(a,"timestamp")));
        selected.truncate(cap);
        selected
    }
}
pub fn decision_audit_id()->String{random_uuid()}
pub fn audit_input_hash(record:&Value)->String{
    format!("{:x}",Sha256::digest(record.to_string().as_bytes()))
}
pub fn outcome_for_decision(
    decision_id:&str,kind:&str,summary:&str,evidence:Option<&Value>,
)->Value{
    let mut value=json!({"record_type":"outcome",
        "schema_version":DECISION_AUDIT_SCHEMA_VERSION,
        "outcome_id":random_uuid(),"decision_id":decision_id,
        "timestamp":iso8601_now(),"kind":kind,"summary":route_reason(summary)});
    if let Some(evidence)=evidence{value["evidence"]=evidence.clone();}
    value
}
pub fn task_audit_facts(task:Option<&Value>)->Value{
    let Some(task)=task else{return json!({});};
    let input=field(task,"input");
    let input_class=input.encode_utf16().take(80).collect::<Vec<_>>();
    let bounded=String::from_utf16_lossy(&input_class);
    // Node copies task.jobId/id/attempt/executionId verbatim: JSON.stringify
    // drops keys whose value is undefined, so absent IDs must stay absent
    // while explicit nulls are kept.
    let mut facts=serde_json::Map::new();
    for (source,target) in [("jobId","job_id"),("id","task_id"),
        ("attempt","attempt"),("executionId","execution_id")].into_iter(){
        if let Some(value)=task.get(source){
            facts.insert(target.into(),value.clone());
        }
    }
    facts.insert("capabilities".into(),task.get("capabilities")
        .cloned().unwrap_or_else(||json!([])));
    facts.insert("input_class".into(),json!(
        Regex::new(r"\s+").expect("fixed whitespace")
            .replace_all(&bounded," ").to_string()));
    Value::Object(facts)
}
/// correlation mirrors the JS object literal { job_id: task?.jobId, ... }:
/// when task is null/undefined every field is undefined and JSON.stringify
/// drops the whole set of keys ({}), while present-but-null fields stay.
fn audit_correlation(task:Option<&Value>)->Value{
    let mut map=serde_json::Map::new();
    if let Some(task)=task{
        for (source,target) in [("jobId","job_id"),("id","task_id"),
            ("executionId","execution_id"),("attempt","attempt")]{
            if let Some(value)=task.get(source){
                map.insert(target.into(),value.clone());
            }
        }
    }
    Value::Object(map)
}
fn policy_audit(policy:&Value)->Value{
    json!({"path":policy.get("path"),"hash":policy.get("hash"),
        "snapshot":policy.get("snapshot"),"rules":policy.get("rules")})
}
fn model_candidate(candidate:&Value)->Value{
    json!({"id":model_choice_id(candidate),
        "provider":candidate.get("provider"),"model":candidate.get("model"),
        "profile":candidate.get("profile"),"reasoning":candidate.get("reasoning"),
        "resourceHealthy":candidate.get("resourceHealthy"),
        "resourceUsedPercent":candidate.get("resourceUsedPercent"),
        "resourceRemainingPercent":candidate.get("resourceRemainingPercent"),
        "resourceResetAt":candidate.get("resourceResetAt"),
        "resourceResetInMinutes":candidate.get("resourceResetInMinutes"),
        "resourceWindows":candidate.get("resourceWindows")})
}
pub fn make_decision_audit(
    task:Option<&Value>,worker:&Value,contract:&Value,policy:&Value,
    candidates:&[Value],eligible:&[Value],selected:&Value,
    routing:&Value,prior_decision:Option<&str>,prior_failure:Option<&Value>,
)->Value{
    let eligible_ids:HashSet<String>=eligible.iter()
        .map(model_choice_id).collect();
    let excluded=contract.get("excludedRoutes").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[]);
    let constraints=&contract["constraints"];
    let gates:Vec<Value>=candidates.iter().map(|candidate|{
        let mut reasons=Vec::<&str>::new();
        if candidate.get("resourceHealthy")==Some(&Value::Bool(false)){
            reasons.push("resource_unhealthy");
        }
        if excluded.iter().any(|route|["provider","model"].into_iter().all(|key|
            route.get(key).and_then(Value::as_str).is_none_or(|s|
                s==field(candidate,key))) && route.get("profile").is_none_or(|p|
                candidate.get("profile")==Some(p))) {
            reasons.push("prior_failed_route");
        }
        for (key,reason) in [
            ("provider","provider_constraint"),("model","model_constraint"),
            ("profile","profile_constraint")
        ] {
            if let Some(required)=constraints.get(key).and_then(Value::as_str){
                if field(candidate,key)!=required{reasons.push(reason);}
            }
        }
        let p=&policy["policy"];
        if p.get("disabledProviders").and_then(Value::as_array).is_some_and(
            |items|items.iter().any(|v|v.as_str()==Some(field(candidate,"provider")))){
            reasons.push("policy_disabled_provider");
        }
        if !field(candidate,"profile").is_empty()
            && p.get("disabledProfiles").and_then(Value::as_array)
                .is_some_and(|items|items.iter()
                    .any(|v|v.as_str()==Some(field(candidate,"profile")))){
            reasons.push("policy_disabled_profile");
        }
        json!({"candidate_id":model_choice_id(candidate),
            "eligible":eligible_ids.contains(&model_choice_id(candidate)),
            "rejection_reasons":reasons})
    }).collect();
    let evidence=&routing["decisionEvidence"];
    let mut map=serde_json::Map::new();
    map.insert("record_type".into(),json!("decision"));
    map.insert("schema_version".into(),json!(DECISION_AUDIT_SCHEMA_VERSION));
    map.insert("decision_id".into(),json!(decision_audit_id()));
    if let Some(previous)=prior_decision{
        map.insert("prior_decision_id".into(),json!(previous));
    }
    if let Some(timestamp)=routing.get("decidedAt"){
        map.insert("timestamp".into(),timestamp.clone());
    }
    map.insert("correlation".into(),audit_correlation(task));
    map.insert("task".into(),task_audit_facts(task));
    map.insert("worker".into(),worker.clone());
    map.insert("contract".into(),contract.clone());
    map.insert("policy".into(),policy_audit(policy));
    map.insert("candidates".into(),json!(candidates.iter()
        .map(model_candidate).collect::<Vec<_>>()));
    map.insert("gate_results".into(),json!(gates));
    map.insert("eligible_candidates".into(),json!(eligible.iter()
        .map(model_candidate).collect::<Vec<_>>()));
    map.insert("selected".into(),model_candidate(selected));
    if let Some(engine)=routing.get("decidedBy"){
        map.insert("engine".into(),engine.clone());
    }
    // fallback: { used, reason? } — reason only survives when
    // decisionEvidence.error is defined (null stays null, undefined omits).
    let mut fallback=serde_json::Map::new();
    fallback.insert("used".into(),json!(
        evidence.get("fallback")==Some(&Value::Bool(true))));
    if let Some(reason)=evidence.get("error"){
        fallback.insert("reason".into(),reason.clone());
    }
    map.insert("fallback".into(),Value::Object(fallback));
    if evidence.is_object(){
        map.insert("decision_evidence".into(),evidence.clone());
    }
    if let Some(failure)=prior_failure{
        map.insert("prior_failure".into(),failure.clone());
    }
    Value::Object(map)
}
fn worker_audit_candidate(worker:&Value)->Value{
    // Node applies ?? coalescing after the spread: trustDomains defaults to
    // [] and labels to {} for both missing and null values.
    let trust=worker.get("trustDomains").cloned()
        .filter(|v|!v.is_null()).unwrap_or_else(||json!([]));
    let labels=worker.get("labels").cloned()
        .filter(|v|!v.is_null()).unwrap_or_else(||json!({}));
    json!({"id":worker.get("workerId"),"adapter":worker.get("adapter"),
        "runtime":worker.get("runtime"),"availability":worker.get("availability"),
        "capabilities":worker.get("capabilities"),
        "trustDomains":trust,"region":worker.get("region"),
        "labels":labels,
        "resourceProvider":worker.get("resourceProvider"),
        "resourceHealthy":worker.get("resourceHealthy"),
        "resourceUsedPercent":worker.get("resourceUsedPercent"),
        "resourceRemainingPercent":worker.get("resourceRemainingPercent"),
        "resourceResetAt":worker.get("resourceResetAt"),
        "resourceResetInMinutes":worker.get("resourceResetInMinutes"),
        "resourceWindows":worker.get("resourceWindows"),
        "browserWorkspaceCapacity":worker.get("browserWorkspaceCapacity")})
}
fn execution_route_audit_candidate(route:&Value)->Value{
    let mut result=json!({"id":route.get("id"),
        "worker":worker_audit_candidate(&route["worker"]),
        "model":model_candidate(&route["model"])});
    // Execution audit records retain the exact route candidate ID; Model
    // audit IDs may include an optional reasoning suffix.
    result["model"]["id"]=route["model"].get("id").cloned().unwrap_or(Value::Null);
    result
}
pub fn make_execution_decision_audit(
    task:Option<&Value>,workers:&[Value],requirements:&Value,
    evaluations:&[Value],worker_gates:&[Value],selected:&Value,
    contract:&Value,policy:&Value,routing:&Value,stages:&[Value],
)->Value{
    let evidence=&routing["decisionEvidence"];
    let eligible:Vec<Value>=evaluations.iter()
        .filter(|entry|entry.get("eligible")==Some(&Value::Bool(true)))
        .map(|entry|execution_route_audit_candidate(&entry["route"]))
        .collect();
    let stage_details=stages.iter().map(|stage|json!({
        "name":stage.get("name"),"facts":stage.get("facts"),
        "contract":stage.get("contract"),
        "result":{"choice":stage.pointer("/result/choice"),
            "probabilities":stage.pointer("/result/probabilities"),
            "bypassed":stage.pointer("/result/bypassed")
                .and_then(Value::as_bool).unwrap_or(false)}
    })).collect::<Vec<_>>();
    let _=requirements;
    let mut map=serde_json::Map::new();
    map.insert("record_type".into(),json!("decision"));
    map.insert("schema_version".into(),json!(DECISION_AUDIT_SCHEMA_VERSION));
    map.insert("decision_id".into(),json!(decision_audit_id()));
    if let Some(timestamp)=routing.get("decidedAt"){
        map.insert("timestamp".into(),timestamp.clone());
    }
    map.insert("correlation".into(),audit_correlation(task));
    map.insert("task".into(),task_audit_facts(task));
    map.insert("worker".into(),worker_audit_candidate(&selected["worker"]));
    map.insert("contract".into(),contract.clone());
    map.insert("policy".into(),policy_audit(policy));
    map.insert("candidates".into(),json!(evaluations.iter()
        .map(|e|execution_route_audit_candidate(&e["route"]))
        .collect::<Vec<_>>()));
    map.insert("gate_results".into(),json!(evaluations.iter().map(|e|json!({
        "candidate_id":e.pointer("/route/id"),
        "eligible":e.get("eligible"),
        "rejection_reasons":e.get("rejectionReasons")
    })).collect::<Vec<_>>()));
    map.insert("eligible_candidates".into(),json!(eligible));
    map.insert("selected".into(),execution_route_audit_candidate(selected));
    if let Some(engine)=routing.get("decidedBy"){
        map.insert("engine".into(),engine.clone());
    }
    let mut fallback=serde_json::Map::new();
    fallback.insert("used".into(),json!(
        evidence.get("fallback")==Some(&Value::Bool(true))));
    if let Some(reason)=evidence.get("error"){
        fallback.insert("reason".into(),reason.clone());
    }
    map.insert("fallback".into(),Value::Object(fallback));
    if evidence.is_object(){
        map.insert("decision_evidence".into(),evidence.clone());
    }
    map.insert("decision_input".into(),json!({
        "type":"merged_choice_decision","stages":stage_details}));
    map.insert("worker_candidates".into(),json!(workers.iter()
        .map(worker_audit_candidate).collect::<Vec<_>>()));
    map.insert("worker_gate_results".into(),json!(worker_gates.iter()
        .map(|entry|json!({
            "worker_id":entry.get("workerId"),"eligible":entry.get("eligible"),
            "rejection_reasons":entry.get("rejectionReasons")
        })).collect::<Vec<_>>()));
    Value::Object(map)
}

/// The canonical audit file is adjacent to the stores directory.
pub fn audit_path(store_directory: &std::path::Path) -> PathBuf {
    let root = if store_directory.file_name().is_some_and(|name| name == "stores") {
        store_directory.parent().unwrap_or(store_directory)
    } else { store_directory };
    root.join("decision-audit.jsonl")
}

/// Dashboard service contract expects chronological order; its API reverses it.
pub fn dashboard_records(store_directory: &std::path::Path) -> Result<Vec<Value>, String> {
    let mut records = crate::audit_tail::read_jsonl_latest(audit_path(store_directory), 30)?;
    records.reverse();
    Ok(records)
}
