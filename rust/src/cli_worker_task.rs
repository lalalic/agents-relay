// Node provenance: src/cli-worker-task.ts. Parse public CLI Task input,
// reserve a global SQLite numeric ID and apply the canonical Task creation Graph.
use crate::{
    cli_core_support::{arg,has_arg,text_option},
    dependency_validity::validate_dependency_validity,
    job_task_id_sequence::allocate_entity_id,
    workflow::entity_creation::create_task_entity,
};
use serde_json::{json,Value};
use std::{collections::HashSet,path::Path};

pub fn recovery_diagnosis_from_args(args:&[String])->Result<Option<Value>,String> {
    let kind=arg(args,"--failure-kind","");
    if kind.is_empty(){return Ok(None);}
    let reason=arg(args,"--reason","");
    if reason.trim().is_empty(){return Err("--failure-kind requires --reason".into());}
    if !matches!(kind,"adapter_failure"|"model_failure"|"provider_failure"|"task_failure"|"unknown") {
        return Err("Invalid --failure-kind".into());
    }
    let mut value=json!({
        "failureKind":kind,"reason":reason,
        "reroute":has_arg(args,"--reroute"),
        "excludeCurrentRoute":has_arg(args,"--exclude-current-route")
    });
    let evidence=arg(args,"--evidence","");
    if !evidence.is_empty(){value["evidence"]=json!(evidence);}
    Ok(Some(value))
}
pub fn dependency_validity_from_args(args:&[String],dependencies:&[String])
    ->Result<Option<Value>,String> {
    if !has_arg(args,"--dependency-validity"){return Ok(None);}
    let raw=arg(args,"--dependency-validity","");
    let parsed:Value=serde_json::from_str(raw)
        .map_err(|_|"--dependency-validity must be valid JSON")?;
    let validated=validate_dependency_validity(dependencies,&parsed,"--dependency-validity")?;
    Ok(validated.map(Value::Object))
}
fn timeout_ms(size:&str,reasoning:Option<&str>)->u64 {
    let standard=match size{"S"=>300_000,"L"=>2_700_000,_=>900_000};
    standard*if reasoning.is_some_and(|v|v.eq_ignore_ascii_case("high")){2}else{1}
}
fn text_array(args:&[String],flag:&str)->Vec<String> {
    arg(args,flag,"").split(',').filter(|v|!v.is_empty())
        .map(str::to_owned).collect()
}
fn nonempty<'a>(v:&'a str)->Option<&'a str> {(!v.is_empty()).then_some(v)}
pub fn worker_task_from_args(
    graph_directory:&Path,job:&Value,args:&[String],now:&str,
    store_directory:&Path,stdin:Option<&str>,
)->Result<Value,String> {
    task_from_args_inner(graph_directory,job,args,now,store_directory,stdin,true)
}
/// For the managed daemon front door, the authoritative SQLite transaction
/// allocates the global Task ID AFTER Graph validation. Do not allocate a
/// competing local ID or write a second unowned .agents-relay store.
pub fn managed_worker_task_from_args(
    graph_directory:&Path,job:&Value,args:&[String],now:&str,
    stdin:Option<&str>,
)->Result<Value,String> {
    task_from_args_inner(graph_directory,job,args,now,
        Path::new(".agents-relay"),stdin,false)
}
fn task_from_args_inner(
    graph_directory:&Path,job:&Value,args:&[String],now:&str,
    store_directory:&Path,stdin:Option<&str>,allocate_id:bool,
)->Result<Value,String> {
    let model=arg(args,"--model","");
    let adapter_value=arg(args,"--adapter","");
    let adapter=if adapter_value.is_empty(){"codex"}else{adapter_value};
    let output_kind=arg(args,"--output","");
    let output_path=arg(args,"--output-path","");
    let input=text_option(args,"--input","--input-file",stdin)?;
    if has_arg(args,"--agent-graph") || has_arg(args,"--agent-graph-file") {
        return Err("Task Graphs are only supported by a declared Neo Project Coordinator".into());
    }
    if input.trim().is_empty(){
        return Err("task create requires --input-file PATH|- or --input MARKDOWN".into());
    }
    if !matches!(adapter,"codex"|"chatgpt"|"z"){
        return Err("task create --adapter must be codex, chatgpt, or z; orchestrator is reserved for legacy recovery only".into());
    }
    if !matches!(output_kind,"local-git"|"file"){
        return Err("task create requires --output local-git|file".into());
    }
    if output_kind=="file" && output_path.is_empty() {
        return Err("--output file requires --output-path".into());
    }
    if ["--provider","--profile","--reasoning","--cwd","--chatgpt-project"]
        .iter().any(|flag|has_arg(args,flag)) && model.is_empty() {
        return Err("task create explicit routing requires --model".into());
    }
    let mut routing=if model.is_empty(){Value::Null}else{
        json!({"provider":arg(args,"--provider","openai"),"model":model,
            "decidedBy":"cli","decidedAt":now})
    };
    if !model.is_empty(){
        for (flag,field) in [
            ("--profile","profile"),("--reasoning","reasoning"),
            ("--cwd","cwd"),("--chatgpt-project","projectId")
        ] {
            if let Some(value)=nonempty(arg(args,flag,"")){routing[field]=json!(value);}
        }
    }
    let mut requirements=if model.is_empty(){json!({"capabilities":[]})}
        else{Value::Null};
    if requirements.is_object() && !adapter_value.is_empty(){
        requirements["runtime"]=json!(adapter);
    }
    let tab_close_policy=if has_arg(args,"--chatgpt-tab-close-policy"){
        let policy=arg(args,"--chatgpt-tab-close-policy","");
        if !matches!(policy,"after-start"|"never"|"after-terminal"){
            return Err("--chatgpt-tab-close-policy must be after-start, never, or after-terminal".into());
        }
        Some(policy)
    }else{None};
    let size=arg(args,"--story-size","M").to_ascii_uppercase();
    if !matches!(size.as_str(),"S"|"M"|"L"){
        return Err("--story-size must be S, M, or L".into());
    }
    let priority=arg(args,"--priority",job.get("priority").and_then(Value::as_str).unwrap_or("P2"));
    if !matches!(priority,"P0"|"P1"|"P2"|"P3"){
        return Err("--priority must be P0, P1, P2, or P3".into());
    }
    let dependencies=text_array(args,"--deps");
    let validity=dependency_validity_from_args(args,&dependencies)?;
    let reasoning=routing.get("reasoning").and_then(Value::as_str);
    let timeout=if has_arg(args,"--timeout"){
        let raw=arg(args,"--timeout","");
        raw.parse::<u64>().map_err(|_|"--timeout must be a non-negative integer")?
    }else if model.is_empty(){0}else{timeout_ms(&size,reasoning)};
    if has_arg(args,"--task-id"){
        return Err("Task IDs are allocated by Relay and cannot be supplied".into());
    }
    let repo=job.get("repository").and_then(Value::as_str)
        .ok_or("Task ID allocation requires a repository context")?;
    let id=if allocate_id{
        let directory=if let Some(location)=nonempty(arg(args,"--store-dir","")){
            Path::new(location)
        }else{store_directory};
        allocate_entity_id(directory,repo,"task",None,&HashSet::new())?
    }else{
        String::new()
    };
    let output=if output_kind=="file"{
        json!({"kind":"file","path":output_path})
    }else{json!({"kind":"task_pr"})};
    let continuation=match (
        nonempty(arg(args,"--continue-kind","")),
        nonempty(arg(args,"--continue-target",""))
    ){
        (Some(kind),Some(target))=>{
            let mut value=json!({"kind":kind,"target":target});
            if let Some(input)=nonempty(arg(args,"--continue-input","")){
                value["input"]=json!(input);
            }
            value
        },
        _=>Value::Null
    };
    let max_attempts=arg(args,"--max-attempts","3").parse::<u64>().unwrap_or(3);
    let mut fields=json!({
        "jobId":job.get("id"),"id":id,
        "priority":priority,"storySize":size,"dependencies":dependencies,
        "capabilities":text_array(args,"--capabilities"),
        "workerRequirements":requirements,
        "adapter":adapter,"input":input,"output":output,
        "attachments":text_array(args,"--attachments"),
        "routing":routing,"continuation":continuation,"continuationDeliveredAt":null,
        "attempt":0,"maxAttempts":max_attempts,
        "executionId":null,
        "threadId":null,"result":null,"error":null,"timeoutMs":timeout,
        "createdAt":now,"updatedAt":now
    });
    // Original Node omits an unspecified optional routing field; serializing
    // it as null changes the public Task API and future routing facts.
    if routing.is_null(){fields.as_object_mut().expect("Task fields").remove("routing");}
    if requirements.is_null(){fields.as_object_mut().expect("Task fields").remove("workerRequirements");}
    if let Some(policy)=tab_close_policy{fields["chatgptTabClosePolicy"]=json!(policy);}
    if let Some(validity)=validity{fields["dependencyValidity"]=validity;}
    for (flag,key) in [("--title","title"),("--project","projectName"),
        ("--agent","agentName"),("--parent","parentTaskId")] {
        if let Some(value)=nonempty(arg(args,flag,"")){
            fields[key]=json!(value);
        }
    }
    if fields.get("parentTaskId").is_none(){fields["parentTaskId"]=Value::Null;}
    create_task_entity(graph_directory,job,&fields,has_arg(args,"--draft"),now)
}
