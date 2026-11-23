// Node provenance: src/cli-job-create.ts. SQLite-authoritative local Job
// creation, globally numeric IDs and immutable repository binding. A
// Graph Coordinator is an ordinary first Task in the same Job lifecycle.
use crate::{
    agent_graph::parse_agent_graph,
    job_task_id_sequence::{allocate_entity_id,is_generated_entity_id},
    local_git_merge::git,
    local_merge_lock::iso8601_now,
    reviewer_thread::normalize_thread_id,
    workflow::entity_creation::{create_job_entity,create_task_entity},
};
use serde_json::{json,Value};
use std::{collections::HashSet,path::{Path,PathBuf}};
/// This is a caller attestation, not proof of reviewer execution. Never
/// persist it in Job/Task/Plan/Review state; the creator owns the preflight.
pub const JOB_PREFLIGHT_REQUIRED:&str="ERROR [JOB_PREFLIGHT_REQUIRED]\n\nJob creation requires --preflight=true.\n\nBefore creating a Job, the orchestrator must:\n1. Complete Spec Kit Specify and Clarify.\n2. Pass independent Preflight Review.\n3. Explicitly acknowledge completion with --preflight=true.\n\nNo Job was created.";

/// CLI accepts exactly one spelling. Do not treat `--preflight false` or
/// duplicate/unknown variants as a successful attestation.
pub fn require_preflight_cli(args:&[String])->Result<(),String>{
    let flags=args.iter().filter(|v|v.starts_with("--preflight")).collect::<Vec<_>>();
    if flags.len()==1&&flags[0].as_str()=="--preflight=true"{
        Ok(())
    }else{
        Err(JOB_PREFLIGHT_REQUIRED.into())
    }
}
/// Direct JSON/daemon callers must also explicitly assert the boolean; a
/// CLI-only check would allow an HTTP client to bypass the contract.
pub fn require_preflight_options(options:&Value)->Result<(),String>{
    if options.get("preflight")==Some(&Value::Bool(true)){
        Ok(())
    }else{
        Err(JOB_PREFLIGHT_REQUIRED.into())
    }
}

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn optional<'a>(v:&'a Value,key:&str)->Option<&'a str>{
    v.get(key).and_then(Value::as_str).filter(|s|!s.is_empty())
}
fn validate_project_root(root:&Path,repository:&str)->Result<PathBuf,String>{
    let canonical=std::fs::canonicalize(root).map_err(|e|e.to_string())?;
    if !canonical.is_dir(){
        return Err("Project root must be an accessible directory".into());
    }
    if canonical.file_name().and_then(|f|f.to_str())!=Some(repository){
        return Err("Project root must be the independent repository Git root".into());
    }
    if !canonical.join(".git").is_dir(){
        return Err("Project root must be an independent Git repository, not a linked worktree".into());
    }
    let reported=git(&canonical,&["rev-parse","--show-toplevel"])?;
    let actual=std::fs::canonicalize(reported).map_err(|e|e.to_string())?;
    if actual!=canonical {
        return Err("Project root must be the top-level Git repository directory".into());
    }
    Ok(canonical)
}
fn require_coordinator(coordinator:&Value)->Result<(),String>{
    let graph=field(coordinator,"graph");
    if graph.trim().is_empty() || field(coordinator,"input").trim().is_empty(){
        return Err("Coordinator requires nonempty graph and input".into());
    }
    parse_agent_graph(graph)?;
    for key in ["outputPath","projectRoot","workspaceRoot"]{
        if !Path::new(field(coordinator,key)).is_absolute(){
            return Err("Coordinator paths must be absolute".into());
        }
    }
    for key in ["globalRoot"]{
        if let Some(value)=optional(coordinator,key){
            if !Path::new(value).is_absolute(){
                return Err("Coordinator paths must be absolute".into());
            }
        }
    }
    Ok(())
}
fn same_coordinator(existing:&Value,requested:&Value)->bool{
    existing.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|field(task,"title")=="Coordinator"
            && task.get("agentGraph").is_some_and(|v|!v.is_null()))
        .is_some_and(|task|task.get("agentGraph")==requested.get("graph")
            && task.get("input")==requested.get("input")
            && task.pointer("/output/kind").and_then(Value::as_str)==Some("file")
            && task.pointer("/output/path")==requested.get("outputPath")
            && existing.pointer("/graphStartContext/projectRoot")==requested.get("projectRoot"))
}
fn normalize_thread(value:Option<&Value>,label:&str)->Result<Option<String>,String>{
    match value{
        None=>Ok(None),
        Some(value)=>normalize_thread_id(value,label),
    }
}
/// `known_jobs` must be obtained from the unified SQLite read-only inventory,
/// not from any remote registry. `load_job` and `persist` are authoritative
/// Store ports, which enforce idempotent job creation under BEGIN IMMEDIATE.
pub fn ensure_managed_local_job<Load,Persist>(
    graph_dir:&Path,store_dir:&Path,repository:&str,
    project_root:&Path,options:&Value,known_jobs:&[Value],
    mut load_job:Load,mut persist:Persist,
)->Result<Value,String>
where
    Load:FnMut(&str)->Result<Option<Value>,String>,
    Persist:FnMut(&Value)->Result<Value,String>,
{
    require_preflight_options(options)?;
    let requested=optional(options,"id");
    if requested.is_some_and(|id|id.starts_with('0')
        || !id.bytes().all(|b|b.is_ascii_digit())){
        return Err("Job ID must be a positive decimal integer".into());
    }
    if let Some(coordinator)=options.get("coordinator").filter(|v|!v.is_null()){
        require_coordinator(coordinator)?;
    }
    let path=validate_project_root(project_root,repository)?;
    let path=path.to_string_lossy().to_string();
    if let Some(bound)=known_jobs.iter().find(|job|
        field(job,"repository")==repository && !field(job,"projectRoot").is_empty()
            && field(job,"projectRoot")!=path){
        return Err(format!("Local repository identity collision {repository}: Job {} binds {}, requested {path}",
            field(bound,"id"),field(bound,"projectRoot")));
    }
    let occupied:HashSet<String>=known_jobs.iter().map(|job|field(job,"id").into()).collect();
    let id=requested.map(str::to_owned).map(Ok).unwrap_or_else(||
        allocate_entity_id(store_dir,repository,"job",
            options.get("idempotencyKey").and_then(Value::as_str),&occupied))?;
    let matching:Vec<&Value>=known_jobs.iter()
        .filter(|job|field(job,"id")==id).collect();
    if matching.len()>1{
        return Err(format!("Duplicate immutable Job ID across SQLite stores: {id}"));
    }
    if let Some(existing)=matching.first(){
        if field(existing,"repository")!=repository
            || field(existing,"projectRoot")!=path
{
            return Err("Immutable Job ID is bound to a different local Git repository or project root".into());
        }
        if requested.is_none() && optional(options,"idempotencyKey").is_none(){
            return Err("Automatically allocated Job ID unexpectedly belongs to an existing Job".into());
        }
        if optional(options,"idempotencyKey").is_some()
            && (optional(options,"objective").is_some_and(|v|v!=field(existing,"objective"))
                || optional(options,"title").is_some_and(|v|v!=field(existing,"title"))){
            return Err("Job idempotency key reused for a different Job definition".into());
        }
        if options.get("coordinator").is_some_and(|v|!v.is_null())
            && !same_coordinator(existing,&options["coordinator"]){
            return Err("Coordinator idempotency key reused for a different Graph or Run".into());
        }
        return Ok(json!({"job":existing}));
    }
    if requested.is_some() && is_generated_entity_id(&id,repository,"job"){
        return Err("Reserved auto-generated Job ID cannot be assigned manually".into());
    }
    if let Some(existing)=load_job(&id)?{
        return Ok(json!({"job":existing}));
    }
    if optional(options,"localMergeTarget").is_some_and(|t|t!="refs/heads/main"){
        return Err("Local merge target must always be main".into());
    }
    let now=iso8601_now();
    let local_source=optional(options,"localMergeSource").map(str::to_owned);
    let mut job=json!({
        "id":id,"title":optional(options,"title").unwrap_or(&id),
        "objective":optional(options,"objective"),
        "projectRoot":path,
        "description":optional(options,"description"),
        "priority":optional(options,"priority").unwrap_or("P2"),
        "autoMerge":options.get("autoMerge").and_then(Value::as_bool).unwrap_or(true),
        "reviewEnabled":options.get("reviewEnabled").and_then(Value::as_bool).unwrap_or(true),
        "repository":repository,
        "continuation":options.get("continuation"),"createdAt":now,
        "updatedAt":now,"tasks":[]
    });
    if let Some(source)=local_source{
        job["localMerge"]=json!({"sourceRef":source,"targetRef":"refs/heads/main",
            "status":"pending"});
    }
    if let Some(tag)=options.get("tag"){job["tag"]=tag.clone();}
    for (field,label) in [
        ("reviewerThreadId","reviewer thread ID"),
        ("creatorThreadId","creator thread ID"),
        ("implementationThreadId","implementation thread ID"),
    ]{
        if let Some(id)=normalize_thread(options.get(field),label)?{
            job[field]=json!(id);
        }
    }
    if let Some(coordinator)=options.get("coordinator").filter(|v|!v.is_null()){
        let mut graph=json!({
            "projectRoot":coordinator.get("projectRoot"),
            "workspaceRoot":coordinator.get("workspaceRoot")
        });
        for key in ["globalRoot"]{
            if let Some(value)=coordinator.get(key).filter(|v|!v.is_null()){
                graph[key]=value.clone();
            }
        }
        job["graphStartContext"]=graph;
    }
    job=create_job_entity(graph_dir,&job,false,&now)?;
    if let Some(coordinator)=options.get("coordinator").filter(|v|!v.is_null()){
        let id=allocate_entity_id(store_dir,repository,"task",
            Some(&format!("coordinator:{}",field(&job,"id"))),
            &HashSet::new())?;
        let input=json!({
            "jobId":job.get("id"),"id":id,"title":"Coordinator",
            "parentTaskId":null,"kind":"work",
            "agentGraph":coordinator.get("graph"),"input":coordinator.get("input"),
            "output":{"kind":"file","path":coordinator.get("outputPath")},
            "adapter":"codex","capabilities":[],"dependencies":[],
            "attempt":0,"maxAttempts":3,
            "executionId":null,
            "threadId":null,"result":null,"error":null,
            "timeoutMs":crate::types::task_overall_timeout_ms(crate::types::StorySize::L,None),
            "createdAt":now,"updatedAt":now
        });
        let task=create_task_entity(graph_dir,&job,&input,false,&now)?;
        job["tasks"].as_array_mut().ok_or("Job tasks missing")?.push(task);
    }
    let persisted=if options.get("persist")==Some(&Value::Bool(false)){
        job
    }else{
        // Original LocalAuthorityDurableStore.load decorates the newly
        // persisted snapshot with an empty plan array for the API response,
        // while the raw SQLite Job snapshot omits the absent property.
        let mut loaded=persist(&job)?;
        if loaded.get("plans").is_none(){loaded["plans"]=json!([]);}
        loaded
    };
    Ok(json!({"job":persisted}))
}
