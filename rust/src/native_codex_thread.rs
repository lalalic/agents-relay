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
/// Incremental facts from the owned Codex stdout stream. Never retain
/// conversation history or tool output. The Graph still owns retry policy.
#[derive(Default)]
pub struct CodexTurnFacts {
    thread_id:Option<String>,
    quota_valid:bool,
    resume_valid:bool,
    tool_seen:bool,
    pending:std::collections::HashSet<String>,
    terminal_seen:bool,
    terminal_failure:Option<String>,
    quota_without_effects:Option<String>,
    continuation:Option<(&'static str,String)>,
}
impl CodexTurnFacts {
    pub fn new()->Self{
        Self{quota_valid:true,resume_valid:true,..Self::default()}
    }
    pub fn observe(&mut self,line:&str)->Option<String>{
        if line.trim().is_empty(){return None;}
        let Ok(event)=serde_json::from_str::<Value>(line)else{
            self.quota_valid=false;
            self.resume_valid=false;
            self.pending.clear();
            return None;
        };
        let kind=field(&event,"type");
        if self.terminal_seen{self.resume_valid=false;}
        match kind{
            "thread.started"=>{
                let id=field(&event,"thread_id");
                if !valid_thread_id(id)||self.thread_id.as_deref().is_some_and(|prior|prior!=id){
                    self.resume_valid=false;
                }else{self.thread_id=Some(id.to_owned());}
            },
            "item.started"|"item.updated"|"item.completed"=>{
                let item=&event["item"];
                let item_type=field(item,"type");
                if !matches!(item_type,"reasoning"|"message"|"agent_message"){
                    self.quota_valid=false;
                }
                if !matches!(item_type,"reasoning"|"message"|"agent_message"|"todo_list"){
                    self.tool_seen=true;
                    if self.resume_valid{
                        let id=field(item,"id");
                        if id.is_empty()||item_type.is_empty(){
                            self.resume_valid=false;
                        }else if kind=="item.completed"{
                            if matches!(field(item,"status"),"in_progress"|"pending"|"running"){
                                self.resume_valid=false;
                            }else{self.pending.remove(id);}
                        }else{
                            self.pending.insert(id.to_owned());
                        }
                    }
                }
            },
            "turn.failed"=>{
                self.terminal_seen=true;
                let message=event.pointer("/error/message").and_then(Value::as_str);
                self.terminal_failure=Some(message.unwrap_or("Codex turn failed").chars().take(1500).collect());
                if self.quota_valid&&self.quota_without_effects.is_none(){
                    if let Some(msg)=message.or_else(||event.get("message").and_then(Value::as_str)){
                        let quota=regex::Regex::new(r"(?i)(?:\b429\b|rate[_ -]?limit|quota|usage[_ -]?limit|credits? exhausted|insufficient credits|resource exhausted)").expect("static quota matcher");
                        if quota.is_match(msg){self.quota_without_effects=Some(msg.chars().take(250).collect());}
                    }
                }
                if let Some(msg)=message{
                    let quota=regex::Regex::new(r"(?i)(?:\b429\b|rate[_ -]?limit[_ -]?exceeded|quota[_ -]?exceeded|usage[_ -]?limit reached|weekly/monthly limit exhausted|insufficient[_ -]?quota|credits? exhausted|insufficient credits|resource exhausted)").expect("static provider quota matcher");
                    let incompatible=!self.tool_seen&&msg.contains("array_above_max_length")
                        &&msg.contains("input[")&&msg.contains(".content")
                        &&msg.contains("invalid_request_error");
                    let classification=if quota.is_match(msg){Some("quota_exhausted")}
                        else if incompatible{Some("resume_context_incompatible")}else{None};
                    self.continuation=classification.map(|kind|(kind,msg.chars().take(500).collect()));
                }else{self.resume_valid=false;}
            },
            "turn.completed"=>self.resume_valid=false,
            "turn.started"|"error"=>{},
            _=>self.resume_valid=false,
        }
        if !self.resume_valid{self.pending.clear();}
        if kind=="thread.started"{
            let id=field(&event,"thread_id");
            if valid_thread_id(id){return Some(id.to_owned());}
        }
        None
    }
    pub fn terminal_failure(&self)->Option<&str>{self.terminal_failure.as_deref()}
    pub fn quota_failure_without_effects(&self)->Option<String>{
        if self.quota_valid{self.quota_without_effects.clone()}else{None}
    }
    pub fn resumable_provider_failure(&self,thread_id:&str)->Option<(&'static str,String)>{
        if self.resume_valid&&self.thread_id.as_deref()==Some(thread_id)
            &&self.pending.is_empty(){self.continuation.clone()}else{None}
    }
}

/// Compatibility helpers for callers with a complete in-memory test transcript.
/// The native Worker feeds the same parser incrementally from its owned pipe.
pub fn quota_failure_without_effects(stdout:&str,_stderr:&str)->Option<String>{
    let mut facts=CodexTurnFacts::new();
    for line in stdout.lines(){facts.observe(line);}
    facts.quota_failure_without_effects()
}
pub fn resumable_provider_failure(stdout:&str,thread_id:&str)->Option<(&'static str,String)>{
    let mut facts=CodexTurnFacts::new();
    for line in stdout.lines(){facts.observe(line);}
    facts.resumable_provider_failure(thread_id)
}
