// Node provenance: src/cli-support.ts. Public Relay CLI options, immutable
// Job binding and HTTP control transport. No Dashboard browser code.
use crate::{
    events_bus_runtime::resolve_events_bus_runtime,
    local_job_registry::find_job_id_snapshot,
    relay_job_snapshot_reads::normalize_relay_job,
};
use regex::Regex;
use serde_json::{json,Value};
pub use crate::cli_core_support::{arg,has_arg,text_option};
pub use crate::cli_support_events::{
    ServiceEventBus,ServiceEventBusPort,ServiceSubscription,
    publish_wake,publish_task_unblocked,publish_task_blocked,
    publish_dependent_unblocked,request_managed_reconciliation,
};
use std::{fs,path::Path};
use url::Url;

pub const SERVICE_PORT:u16=8787;
pub const SERVICE_WATCHDOG_MS:u64=300_000;
pub const SERVICE_WEBHOOK_WATCHDOG_MS:u64=300_000;
pub const SERVICE_DASHBOARD_REFRESH_MS:u64=300_000;
pub const SERVICE_PROJECTION_FLUSH_MS:u64=1_000;

// Exact Node SERVICE_DEFAULTS public shape, without a mutable singleton.
#[derive(Clone,Copy,Debug,serde::Serialize)]
#[serde(rename_all="camelCase")]
pub struct ServiceDefaults {
    pub port:u16,
    pub watchdog_ms:u64,
    pub webhook_watchdog_ms:u64,
    pub dashboard_refresh_ms:u64,
    pub projection_flush_ms:u64,
}
pub const SERVICE_DEFAULTS:ServiceDefaults=ServiceDefaults{
    port:SERVICE_PORT,watchdog_ms:SERVICE_WATCHDOG_MS,
    webhook_watchdog_ms:SERVICE_WEBHOOK_WATCHDOG_MS,
    dashboard_refresh_ms:SERVICE_DASHBOARD_REFRESH_MS,
    projection_flush_ms:SERVICE_PROJECTION_FLUSH_MS,
};

// All options below are mechanical CLI parsing. Workflow decisions remain
// in Graph and the durable SQLite Reconciler.
pub fn priority(args:&[String],fallback:&str)->Result<String,String>{
    let value=arg(args,"--priority",fallback);
    if matches!(value,"P0"|"P1"|"P2"|"P3") {Ok(value.into())}
    else{Err("--priority must be P0, P1, P2, or P3".into())}
}
pub fn story_size(args:&[String],fallback:&str)->Result<String,String>{
    let value=arg(args,"--story-size",fallback).to_uppercase();
    if matches!(value.as_str(),"S"|"M"|"L") {Ok(value)}
    else{Err("--story-size must be S, M, or L".into())}
}
pub fn chatgpt_tab_close_policy(args:&[String],env:Option<&str>)
    ->Result<String,String>{
    let fallback=env.filter(|s|!s.is_empty()).unwrap_or("after-terminal");
    let value=arg(args,"--chatgpt-tab-close-policy",fallback);
    if matches!(value,"after-start"|"never"|"after-terminal"){
        Ok(value.into())
    }else{Err("--chatgpt-tab-close-policy must be after-start, never, or after-terminal".into())}
}
pub fn job_tag_from_args(args:&[String])->Result<Value,String>{
    crate::task_tag::parse_job_tag_json(arg(args,"--tag",""))
}
pub fn continuation(args:&[String])->Value{
    let kind=arg(args,"--continue-kind","");
    let target=arg(args,"--continue-target","");
    if kind.is_empty()||target.is_empty(){return Value::Null;}
    let input=arg(args,"--continue-input","");
    let mut item=json!({"kind":kind,"target":target});
    if !input.is_empty(){item["input"]=json!(input);}
    item
}
pub fn reject_removed_job_options(args:&[String])->Result<(),String>{
    let obsolete=["--mode","--execution-mode","--schedule",
        "--schedule-next-run","--schedule-timezone","--missed-run-policy",
        "--schedule-concurrency","--cron","--schedule-cron"];
    if let Some(flag)=obsolete.into_iter().find(|flag|has_arg(args,flag)){
        return Err(format!("Unsupported Job option {flag}: every Job replans to objective satisfaction and scheduling is unavailable"));
    }
    Ok(())
}
pub fn reject_remote_lifecycle_options(args:&[String])->Result<(),String>{
    let obsolete=["--github-repo","--pr","--no-github","--dependent-pr",
        "--head","--base","--body","--github-app-id",
        "--github-app-installation-id","--github-app-private-key-file",
        "--github-webhook-secret","--github-webhook-secret-file",
        "--github-token","--github-token-file","--projection-ms"];
    if let Some(flag)=obsolete.into_iter().find(|flag|args.iter().any(|arg|
        arg==flag||arg.starts_with(&format!("{flag}=")))){
        return Err(format!("Unsupported option {flag}: Jobs use local Git identity and SQLite lifecycle state"));
    }
    Ok(())
}

// JS Number(value) accepts blank/whitespace and 0x/0b/0o literals;
// from_str::<u64> silently diverges for valid Node CLI options.
fn js_number(raw:&str)->f64{
    let text=raw.trim_matches(|c:char|c.is_whitespace()||c=='\u{feff}');
    if text.is_empty(){return 0.0;}
    for (prefix,radix) in [("0x",16),("0X",16),("0b",2),("0B",2),("0o",8),("0O",8)]{
        if let Some(value)=text.strip_prefix(prefix){
            return u128::from_str_radix(value,radix)
                .map(|n|n as f64).unwrap_or(f64::NAN);
        }
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}
fn number_is_integer(n:f64)->bool{n.is_finite()&&n.fract()==0.0}
fn number_is_safe_positive_integer(n:f64)->bool{
    number_is_integer(n)&&n>0.0&&n<=9_007_199_254_740_991.0
}
pub fn integer_arg(args:&[String],flag:&str,default:u64)->Result<u64,String>{
    if !has_arg(args,flag){return Ok(default);}
    let number=js_number(arg(args,flag,""));
    if !number_is_integer(number)||number<0.0||number>u64::MAX as f64{
        return Err(format!("{flag} must be a non-negative integer"));
    }
    Ok(number as u64)
}
pub fn repository(args:&[String])->Result<&str,String>{
    let repo=arg(args,"--repo","");
    if repo.is_empty(){return Err("--repo must name the local Git root directory".into());}
    Ok(repo)
}
pub fn new_local_repository(args:&[String])->Result<&str,String>{
    let repository=repository(args)?;
    let legal=Regex::new(r"^[A-Za-z0-9_.-]+$").expect("static repository regex");
    if !legal.is_match(repository)||matches!(repository,"."|".."){
        return Err("--repo must be a local Git root basename, not a path or remote owner/repo".into());
    }
    Ok(repository)
}
pub fn pull_request(args:&[String])->Result<u64,String>{
    let raw=arg(args,"--pr","");
    let pr=js_number(raw);
    if !number_is_integer(pr)||pr<=0.0||pr>u64::MAX as f64{
        return Err("--pr is required for GitHub-backed operation".into());
    }
    Ok(pr as u64)
}
pub fn validate_read_only_job_binding(args:&[String])->Result<(),String>{
    for flag in [
        "--id","--repo","--pr","--file","--store-dir",
        "--task-id","--plan-id","--execution-id"
    ]{
        let count=args.iter().filter(|item|item.as_str()==flag).count();
        if count>1{return Err(format!("{flag} may not be repeated"));}
        if count==1{
            let value=arg(args,flag,"");
            if value.is_empty()||value.starts_with("--"){
                return Err(format!("{flag} requires a value"));
            }
        }
    }
    if !has_arg(args,"--id"){
        return Err("--id is required for read-only Relay commands".into());
    }
    if has_arg(args,"--pr"){
        let pr=js_number(arg(args,"--pr",""));
        if !number_is_safe_positive_integer(pr){
            return Err("--pr must be a positive integer".into());
        }
    }
    Ok(())
}
/// Read-only binding never initializes a write-enabled SQLiteRelayStore.
pub fn readonly_job_for(
    args:&[String],store_directory:&Path,allow_id_only:bool,
    optional_repo:bool,
)->Result<(Value,Option<String>),String>{
    if allow_id_only{validate_read_only_job_binding(args)?;}
    let file=arg(args,"--file","");
    if !file.is_empty(){
        let source=fs::read_to_string(file).map_err(|e|e.to_string())?;
        let job:Value=serde_json::from_str(&source).map_err(|e|e.to_string())?;
        if allow_id_only||optional_repo{
            if arg(args,"--id","")!=job.get("id").and_then(Value::as_str)
                .unwrap_or(""){
                return Err("Local --file Job ID binding mismatch".into());
            }
            let repository=arg(args,"--repo","");
            if !repository.is_empty()
                &&job.get("repository").and_then(Value::as_str)!=Some(repository){
                return Err("Local --file repository binding mismatch".into());
            }
            let bound_pr=job.get("prNumber").and_then(Value::as_i64).unwrap_or(0).max(0);
            if has_arg(args,"--pr")
                &&bound_pr.to_string()!=arg(args,"--pr",""){
                return Err("Local --file PR binding mismatch".into());
            }
        }
        return Ok((job,Some(file.into())));
    }
    let id=arg(args,"--id","");
    let repo=arg(args,"--repo","");
    if id.is_empty()||(!allow_id_only&&!optional_repo&&repo.is_empty()){
        return Err("Local Job requires --id and, for this operation, --repo (or explicit --file)".into());
    }
    let directory=arg(args,"--store-dir","");
    let directory=if directory.is_empty(){store_directory}
        else{Path::new(directory)};
    let selected=find_job_id_snapshot(directory,id)?
        .ok_or_else(||format!("Immutable local Job not found for repository: {id}"))?;
    let job=normalize_relay_job(&selected.job.to_string())?;
    if !repo.is_empty() &&job.get("repository").and_then(Value::as_str)!=Some(repo){
        return Err(format!("Immutable local Job not found for repository: {id}"));
    }
    if has_arg(args,"--pr"){
        let supplied=arg(args,"--pr","");
        let bound_pr=job.get("prNumber").and_then(Value::as_i64).unwrap_or(0).max(0);
        if supplied!=bound_pr.to_string(){
            return Err("Local Job/PR binding mismatch".into());
        }
    }
    Ok((job,None))
}
pub fn save_local(file:Option<&Path>,job:&Value)->Result<(),String>{
    if let Some(path)=file{
        fs::write(path,serde_json::to_string_pretty(job)
            .map_err(|e|e.to_string())?).map_err(|e|e.to_string())?;
    }
    Ok(())
}
pub fn optional_legacy_pr(args:&[String])->Result<Option<u64>,String>{
    if !has_arg(args,"--pr"){return Ok(None);}
    let value=js_number(arg(args,"--pr",""));
    if !number_is_safe_positive_integer(value){
        return Err("--pr must be a positive integer (deprecated; use --id for normal operations)".into());
    }
    Ok(Some(value as u64))
}
pub fn endpoint(args:&[String])->Result<(String,u16),String>{
    let host=arg(args,"--host","127.0.0.1");
    let port=arg(args,"--port","8787").parse::<u16>()
        .map_err(|_|"--port must be an integer between 1 and 65535")?;
    if port==0{return Err("--port must be an integer between 1 and 65535".into());}
    Ok((host.into(),port))
}
fn url_for(args:&[String],path:&str,params:&[(&str,String)])
    ->Result<Url,String>{
    let (host,port)=endpoint(args)?;
    let mut url=Url::parse(&format!("http://{host}:{port}{path}"))
        .map_err(|e|e.to_string())?;
    url.query_pairs_mut().extend_pairs(params.iter().map(|(k,v)|(*k,v.as_str())));
    Ok(url)
}
fn http(args:&[String],path:&str,method:&str,params:&[(&str,String)],
    body:Option<&Value>,description:&str)->Result<Value,String>{
    let url=url_for(args,path,params)?;
    let (host,port)=endpoint(args)?;
    let client=ureq::Agent::new_with_defaults();
    let response=if method=="POST"{
        let request=client.post(url.as_str());
        if let Some(body)=body{request.send_json(body)}
        else{request.send_empty()}
    }else{client.get(url.as_str()).call()};
    let mut response=response.map_err(|e|format!(
        "Agents Relay service unavailable at {host}:{port}: {e}"))?;
    if !(200..300).contains(&response.status().as_u16()){
        let status=response.status().as_u16();
        let text=response.body_mut().read_to_string()
            .unwrap_or_else(|_|format!("HTTP {status}"));
        return Err(format!("Agents Relay {description} failed: {}",if text.is_empty(){
            format!("HTTP {status}")
        }else{text}));
    }
    response.body_mut().read_json::<Value>()
        .map_err(|e|e.to_string())
}
fn job_params(args:&[String],id:&str)->Result<Vec<(&'static str,String)>,String>{
    let mut params=vec![("id",id.into())];
    let repo=arg(args,"--repo","");
    if !repo.is_empty(){params.push(("repo",repo.into()));}
    if let Some(pr)=optional_legacy_pr(args)?{params.push(("pr",pr.to_string()));}
    Ok(params)
}
pub fn relay_control_job(args:&[String],id:&str)->Result<Value,String>{
    http(args,"/api/job","GET",&job_params(args,id)?,None,"job request")
}
pub fn relay_control_command(args:&[String],body:&Value)->Result<Value,String>{
    http(args,"/api/control","POST",&[],Some(body),"control command")
}
pub fn relay_job_list(args:&[String])->Result<Vec<Value>,String>{
    let mut params=vec![("inventory","1".into())];
    let repo=arg(args,"--repo","");
    if !repo.is_empty(){params.push(("repo",repo.into()));}
    let response=http(args,"/api/jobs","GET",&params,None,"jobs request")?;
    let jobs=response.as_array().or_else(||response.get("jobs").and_then(Value::as_array))
        .ok_or("Invalid Relay jobs response: expected an array of Job summaries")?;
    if jobs.iter().any(|row|!row.is_object()
        ||row.get("repository").and_then(Value::as_str).is_none()
        ||row.get("id").and_then(Value::as_str).is_none()){
        return Err("Invalid Relay jobs response: expected an array of Job summaries".into());
    }
    Ok(jobs.iter().filter(|job|
        repo.is_empty()||job.get("repository").and_then(Value::as_str)==Some(repo))
        .cloned().collect())
}
pub fn relay_job_state_command(args:&[String],id:&str,state:&str)
    ->Result<Value,String>{
    let mut params=job_params(args,id)?;
    params.push(("state",state.into()));
    http(args,"/api/job-state","POST",&params,None,"job state command")
}
pub fn relay_task_command(args:&[String],body:&Value)->Result<Value,String>{
    http(args,"/api/task-command","POST",&[],Some(body),"task command")
}
pub fn resolve_event_bus(args:&[String],environment:&Value,
    reachable:bool)->Result<Value,String>{
    let explicit=has_arg(args,"--events");
    let mode=arg(args,"--events","");
    let runtime=resolve_events_bus_runtime(environment)?;
    let nats=arg(args,"--nats-url",
        runtime.get("natsUrl").and_then(Value::as_str).unwrap_or(""));
    if !explicit&&has_arg(args,"--file"){
        return Ok(json!({"transport":"none","source":"local","natsUrl":nats}));
    }
    if explicit&&mode!="nats"{
        return Ok(json!({"transport":"none","source":"explicit","natsUrl":nats}));
    }
    let source=if explicit{"explicit"}else if reachable{"auto"}else{"unavailable"};
    Ok(json!({"transport":if explicit||reachable{"nats"}else{"none"},
        "source":source,"natsUrl":nats,
        "subjectPrefix":arg(args,"--subject-prefix",
            runtime.get("subjectPrefix").and_then(Value::as_str).unwrap_or(""))
    }))
}
pub fn event_bus_resolution_message(resolution:&Value)->String{
    if resolution.get("transport").and_then(Value::as_str)==Some("nats"){
        return format!("event transport: nats ({})",
            if resolution.get("source").and_then(Value::as_str)==Some("auto"){
                "auto-detected"
            }else{"explicit"});
    }
    match resolution.get("source").and_then(Value::as_str){
        Some("explicit")=>"event transport: none (explicit)".into(),
        Some("local")=>"event transport: none (local mode)".into(),
        _=>"event transport: none (NATS unavailable)".into()
    }
}
