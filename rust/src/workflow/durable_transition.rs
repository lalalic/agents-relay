// Direct port of src/workflow/durable-transition.ts.
//
// The primitive owns per-Task serialization and durable persistence. Policy is
// not repeated here: the canonical Task Mermaid Graph selects every transition.
// Caller supplied Store ports keep SQLite authoritative and avoid a new queue.
use crate::{
    local_merge_lock::iso8601_now,
    observability::observability,
    task_transitions::try_transition_task_event,
};
use chrono::{DateTime,SecondsFormat,Utc};
use serde_json::{json,Value};
use std::{
    collections::HashMap, future::Future, path::{Path,PathBuf},
    sync::{Arc,Mutex},
};

fn field<'a>(value:&'a Value,key:&str)->&'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn millis(raw: &str)->Option<i64>{
    DateTime::parse_from_rfc3339(raw).ok().map(|time|time.timestamp_millis())
}
fn at_ms(value:i64)->Result<String,String>{
    DateTime::<Utc>::from_timestamp_millis(value)
        .map(|date|date.to_rfc3339_opts(SecondsFormat::Millis,true))
        .ok_or_else(||"Invalid monotonic Task timestamp".into())
}
fn monotonic_timestamp(previous:&str,proposed:&str)->Result<String,String>{
    let Some(prior)=millis(previous) else{return Ok(proposed.to_owned());};
    let next=millis(proposed).unwrap_or(0);
    if next<=prior{at_ms(prior.saturating_add(1))}
    else{Ok(proposed.to_owned())}
}
fn task_index(job:&Value,task_id:&str)->Option<usize>{
    job.get("tasks").and_then(Value::as_array)
        .and_then(|tasks|tasks.iter().position(|task|field(task,"id")==task_id))
}
pub struct DurableTaskTransitionRuntime {
    graph_directory:PathBuf,
    locks:Mutex<HashMap<String,Arc<Mutex<()>>>>,
}
impl DurableTaskTransitionRuntime {
    pub fn new(graph_directory:impl Into<PathBuf>)->Self{
        Self{graph_directory:graph_directory.into(),locks:Mutex::new(HashMap::new())}
    }
    pub fn graph_directory(&self)->&Path{&self.graph_directory}
    fn lock(&self,job_id:&str,task_id:&str)->Result<Arc<Mutex<()>>,String>{
        let mut locked=self.locks.lock().map_err(|_|"Transition lock poisoned")?;
        Ok(Arc::clone(locked.entry(format!("{job_id}/{task_id}"))
            .or_insert_with(||Arc::new(Mutex::new(())))))
    }
    /// Exposes an atomic Store boundary as two ports. If a SQLite writer
    /// detects a stale Task version, the transition is rejected, not retried
    /// under a guessed state.
    pub async fn apply<Load,LoadFuture,Save,SaveFuture,Eligible,Facts,Mutate>(
        &self,job_id:&str,task_id:&str,event:&str,
        mut load:Load,mut save:Save,eligible:Eligible,
        facts:Facts,mutate:Mutate,
    )->Result<Option<Value>,String>
    where
        Load: FnMut(&str)->LoadFuture,
        LoadFuture:Future<Output=Result<Value,String>>,
        Save:FnMut(&str,&Value)->SaveFuture,
        SaveFuture:Future<Output=Result<(),String>>,
        Eligible:Fn(&Value,&Value)->bool,
        Facts:Fn(&Value,&Value)->Value,
        Mutate:Fn(&mut Value,&mut Value,&Value)->Result<(),String>,
    {
        let lock=self.lock(job_id,task_id)?;
        let _serial=lock.lock().map_err(|_|"Task transition lock poisoned")?;
        let mut job=load(job_id).await?;
        let idx=task_index(&job,task_id);
        if idx.is_none_or(|index|{
            !eligible(&job,&job["tasks"][index])
        }){
            let state=idx.and_then(|index|job["tasks"][index].get("state"));
            observability().record(&json!({
                "stage":"transition","event":event,"level":"debug",
                "outcome":"skipped",
                "message":format!("Task {task_id} transition {event} not eligible"),
                "correlation":{"repository":job.get("repository"),
                    "prNumber":job.get("prNumber"),"jobId":job_id,"taskId":task_id},
                "transition":{"graph":"task-lifecycle","from":state,"to":null}
            }));
            return Ok(None);
        }
        let idx=idx.expect("eligible index");
        let from=field(&job["tasks"][idx],"state").to_owned();
        let previous_at=field(&job["tasks"][idx],"updatedAt").to_owned();
        // The native Graph function writes the mutable Task snapshot only
        // when the Graph selected an accepted lifecycle target.
        let facts=facts(&job,&job["tasks"][idx]);
        let mut task=job["tasks"][idx].clone();
        let now=iso8601_now();
        let decision=try_transition_task_event(
            &self.graph_directory,&mut task,event,&facts,&now)?;
        if decision.get("accepted")!=Some(&Value::Bool(true))
            || decision.get("target").is_none_or(Value::is_null) {
            return Ok(Some(json!({
                "job":job,"task":task,"from":from,"decision":decision
            })));
        }
        // The Node mutation port receives the shared Job snapshot and
        // mutable Task. The caller can inspect authoritative sibling Tasks.
        mutate(&mut job,&mut task,&decision)?;
        let timestamp=monotonic_timestamp(&previous_at,
            field(&task,"updatedAt"))?;
        task["updatedAt"]=json!(timestamp);
        // Persist before acknowledging an accepted transition.
        save(job_id,&task).await?;
        job["tasks"][idx]=task.clone();
        observability().record(&json!({
            "stage":"transition","event":event,"outcome":"succeeded",
            "message":format!("Task {task_id} {from} -> {}",
                field(&decision,"target")),
            "correlation":{"repository":job.get("repository"),
                "prNumber":job.get("prNumber"),"jobId":job_id,
                "taskId":task_id,"executionId":task.get("executionId")},
            "transition":{"graph":"task-lifecycle","from":from,
                "to":decision.get("target"),"actions":decision.get("actions")}
        }));
        Ok(Some(json!({
            "job":job,"task":task,"from":from,"decision":decision
        })))
    }

    /// Non-lifecycle fact updates use the same lock and strictly increasing
    /// updatedAt. Commit may atomically compare the Task snapshot version.
    pub async fn update_fact<Load,LFut,Save,SFut,Eligible,Mutate>(
        &self,job_id:&str,task_id:&str,
        mut load:Load,mut save:Save,eligible:Eligible,mutate:Mutate,
    )->Result<Option<Value>,String>
    where
        Load: FnMut(&str)->LFut,
        LFut:Future<Output=Result<Value,String>>,
        Save:FnMut(&str,&Value)->SFut,
        SFut:Future<Output=Result<(),String>>,
        Eligible:Fn(&Value)->bool,
        Mutate:Fn(&mut Value),
    {
        let lock=self.lock(job_id,task_id)?;
        let _serial=lock.lock().map_err(|_|"Task transition lock poisoned")?;
        let mut job=load(job_id).await?;
        let Some(idx)=task_index(&job,task_id) else{return Ok(None);};
        let mut task=job["tasks"][idx].clone();
        if !eligible(&task){return Ok(None);}
        let previous=field(&task,"updatedAt").to_string();
        mutate(&mut task);
        let timestamp=monotonic_timestamp(&previous,&iso8601_now())?;
        task["updatedAt"]=json!(timestamp);
        save(job_id,&task).await?;
        job["tasks"][idx]=task.clone();
        Ok(Some(task))
    }
}
