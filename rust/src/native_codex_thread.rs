//! Persist Codex thread identity and construct turn-scoped Provider/Profile/Model
//! invocations. SQLite remains the only durable binding across Worker restarts.
use crate::{codex_permissions::{exec_args,FULL_ACCESS_NO_APPROVALS},relay_store::SQLiteRelayStore};
use serde_json::{json,Value};
use std::path::Path;

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn build_codex_turn_args(route:&Value,cwd:&str,prompt:&str,thread_id:Option<&str>)->Result<Vec<String>,String>{
    let model=field(route,"model");
    let provider=field(route,"provider");
    if model.is_empty()||provider.is_empty(){return Err("Codex route must include provider and model".into());}
    let mut args=if thread_id.is_some(){
        // Resume has its own option parser; the max-access flag and model go
        // AFTER `resume`, while JSONL and profile remain on `exec`.
        let mut args=vec!["exec".into(),"--json".into()];
        if !field(route,"profile").is_empty(){
            args.extend(["-p".into(),field(route,"profile").into()]);
        }
        args.extend(["-c".into(),format!("model_provider=\"{provider}\"")]);
        args.extend(["resume".into(),FULL_ACCESS_NO_APPROVALS.into()]);
        args
    }else{
        let mut args=exec_args(true);
        if !field(route,"profile").is_empty(){
            args.extend(["-p".into(),field(route,"profile").into()]);
        }
        args.extend(["-c".into(),format!("model_provider=\"{provider}\"")]);
        args
    };
    args.extend(["-m".into(),model.into()]);
    if !field(route,"reasoning").is_empty(){
        args.extend(["-c".into(),format!("model_reasoning_effort={}",field(route,"reasoning"))]);
    }
    if let Some(thread_id)=thread_id{
        if !valid_thread_id(thread_id){return Err("Invalid persisted Codex thread ID".into());}
        args.extend([thread_id.into(),prompt.into()]);
    }else{args.extend(["-C".into(),cwd.into(),"--".into(),prompt.into()]);}
    Ok(args)
}
pub fn valid_thread_id(id:&str)->bool{
    // Codex JSONL emits UUID thread IDs. Never interpret a Task-supplied
    // string as an option or let it select another session implicitly.
    id.len()==36 && id.char_indices().all(|(i,c)|if [8,13,18,23].contains(&i){c=='-'}else{c.is_ascii_hexdigit()})
}
pub fn parse_thread_started(line:&str)->Option<String>{
    let value:Value=serde_json::from_str(line).ok()?;
    if field(&value,"type")!="thread.started"{return None;}
    value.get("thread_id").and_then(Value::as_str)
        .filter(|id|valid_thread_id(id)).map(str::to_owned)
}
/// Only the currently leased execution may attach its observed Codex thread.
/// Preserve the original thread identity; cross-provider rewrites fail closed.
pub fn persist_task_thread(db:&Path,job_id:&str,task_id:&str,execution_id:&str,id:&str)->Result<(),String>{
    if !valid_thread_id(id){return Err("Invalid Codex thread_started ID".into());}
    let store=SQLiteRelayStore::open_without_claim_reset(db,Some(job_id))?;
    let mut committed=false;
    store.mutate_job(job_id,|mut job|{
        let task=job.get_mut("tasks").and_then(Value::as_array_mut)
            .and_then(|tasks|tasks.iter_mut().find(|task|field(task,"id")==task_id))
            .ok_or("Task missing during Codex thread persistence")?;
        if field(task,"executionId")!=execution_id{
            return Err("Stale Codex execution cannot persist thread ID".into());
        }
        let previous=field(task,"threadId");
        if !previous.is_empty() && previous!=id{
            return Err("Codex resume yielded a different Thread ID; fail closed".into());
        }
        if previous.is_empty(){task["threadId"]=json!(id);}
        committed=true;
        Ok(job)
    })?;
    if !committed{return Err("Codex Thread ID was not committed".into());}
    Ok(())
}
/// Automatic provider fallback is allowed only for a *confirmed* quota
/// rejection without any tool/action start in this turn. A malformed or
/// ambiguous failure never authorizes replay of possible side effects.
pub fn quota_failure_without_effects(stdout:&str,stderr:&str)->Option<String>{
    let mut errors=Vec::<String>::new();
    for line in stdout.lines(){
        if line.trim().is_empty(){continue;}
        let Ok(event)=serde_json::from_str::<Value>(line)else{return None};
        let event_type=field(&event,"type");
        if matches!(event_type,"item.started"|"item.updated"|"item.completed"){
            // Covers command execution, file edits, MCP and other tool actions.
            if !matches!(field(&event["item"],"type"),"reasoning"|"message"|"agent_message"){
                return None;
            }
        }
        if event_type=="turn.failed"{
            let value=event.pointer("/error/message").and_then(Value::as_str)
                .or_else(||event.get("message").and_then(Value::as_str));
            if let Some(msg)=value{errors.push(msg.to_owned());}
        }
    }
    // Arbitrary stderr without a recognized turn failure is not sufficient
    // evidence to relaunch a possibly already-mutating Agent.
    let _=stderr;
    let quota=regex::Regex::new(r"(?i)(?:\b429\b|rate[_ -]?limit|quota|usage[_ -]?limit|credits? exhausted|insufficient credits|resource exhausted)").expect("static quota matcher");
    errors.into_iter().find(|message|quota.is_match(message))
        .map(|message|message.chars().take(250).collect())
}

/// A terminal provider rejection can continue a durable Codex thread even
/// after completed tools. This is a continuation, never a fresh replay.
/// Require a complete JSONL stream, a matching thread identity, no outstanding
/// tool item, and a terminal turn.failed (not a transient error or tool text).
pub fn resumable_provider_failure(stdout:&str,thread_id:&str)->Option<(&'static str,String)>{
    if !valid_thread_id(thread_id){return None;}
    let mut thread_seen=false;
    let mut pending=std::collections::HashSet::<String>::new();
    let mut tool_seen=false;
    let mut terminal=None;
    for line in stdout.lines().filter(|line|!line.trim().is_empty()){
        let event:Value=serde_json::from_str(line).ok()?;
        let kind=field(&event,"type");
        if terminal.is_some(){return None;}
        match kind{
            "thread.started"=>{
                if field(&event,"thread_id")!=thread_id{return None;}
                thread_seen=true;
            },
            "item.started"|"item.updated"|"item.completed"=>{
                let item=&event["item"];
                let item_type=field(item,"type");
                if matches!(item_type,"reasoning"|"message"|"agent_message"|"todo_list"){continue;}
                tool_seen=true;
                let id=field(item,"id");
                if id.is_empty()||item_type.is_empty(){return None;}
                if kind=="item.completed"{
                    if matches!(field(item,"status"),"in_progress"|"pending"|"running"){return None;}
                    pending.remove(id);
                }else{
                    pending.insert(id.to_owned());
                }
            },
            "turn.failed"=>{
                terminal=event.pointer("/error/message").and_then(Value::as_str)
                    .map(str::to_owned);
                if terminal.is_none(){return None;}
            },
            "turn.completed"=>return None,
            "turn.started"|"error"=>{},
            // Unknown records must not silently authorize replay of a tool.
            _=>return None,
        }
    }
    if !thread_seen||!pending.is_empty(){return None;}
    let message=terminal?;
    let quota=regex::Regex::new(r"(?i)(?:\b429\b|rate[_ -]?limit[_ -]?exceeded|quota[_ -]?exceeded|usage[_ -]?limit reached|weekly/monthly limit exhausted|insufficient[_ -]?quota|credits? exhausted|insufficient credits|resource exhausted)").expect("static provider quota matcher");
    let incompatible=!tool_seen && message.contains("array_above_max_length")
        && message.contains("input[") && message.contains(".content")
        && message.contains("invalid_request_error");
    let classification=if quota.is_match(&message){"quota_exhausted"}
        else if incompatible{"resume_context_incompatible"}else{return None;};
    Some((classification,message.chars().take(500).collect()))
}
