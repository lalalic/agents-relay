// Node provenance: src/relayd-dashboard-actions.ts.
// Server-side overview binding and workspace controls ONLY. The Dashboard
// browser HTML, CSS and JavaScript remain untouched and are not implemented here.
use crate::{
    dashboard_actions::{
        dashboard_job_set_state, dashboard_task_action, dashboard_task_set_state,
    },
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    workflow::lifecycle::dispatch_job_lifecycle_sync,
};
use serde_json::{json, Value};
use std::{collections::HashSet, path::Path};

fn field<'a>(value: &'a Value, name: &str) -> &'a str {
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job: &Value) -> &[Value] {
    job.get("tasks").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[])
}
fn is_terminal(job: &Value) -> bool {
    matches!(field(job, "state"), "COMPLETED" | "CANCELLED")
}
pub fn dashboard_overview(
    overviews: &[Value],
    job_id: &str,
    target: Option<&Value>,
) -> Option<Value> {
    overviews.iter().find(|row| {
        let job = &row["job"];
        if field(job, "id") != job_id { return false; }
        if let Some(repository) = target.and_then(|t|t.get("repository"))
            .and_then(Value::as_str).filter(|s|!s.is_empty()) {
            if field(job, "repository") != repository { return false; }
        }
        if let Some(pr) = target.and_then(|t|t.get("prNumber"))
            .and_then(Value::as_i64).filter(|n|*n!=0) {
            if job.get("prNumber").and_then(Value::as_i64) != Some(pr) { return false; }
        }
        true
    }).cloned()
}
pub fn require_dashboard_job(
    overviews: &[Value], job_id: &str, target: Option<&Value>,
) -> Result<Value, String> {
    dashboard_overview(overviews, job_id, target)
        .ok_or_else(||format!("Managed job {job_id} not found"))
}
/// For daemon dispatch. Actual job execution is always delegated to the
/// existing pool/Reconciler, which refreshes the durable SQLite result.
pub fn workspace_job_action_request(
    overviews: &[Value], job_id: &str, action: &str,
) -> Result<Value, String> {
    require_dashboard_job(overviews, job_id, None)?;
    if !matches!(action, "start" | "reconcile" | "cancel") {
        return Err(format!("Unsupported Job action {action}"));
    }
    if action == "reconcile" {
        return Ok(json!({"kind":"pool.reconcileLocalJob",
            "jobId":job_id,"reason":"control.job.reconcile"}));
    }
    Ok(json!({"kind":"dashboardJobAction","jobId":job_id,"action":action}))
}
/// Scope-check a Job state mutation to the visible immutable Job identity.
pub fn workspace_job_set_state(
    graph_directory: &Path, overviews: &[Value], job: &Value,
    target: Option<&Value>, state: &str,
) -> Result<(Value, bool), String> {
    let id = field(job, "id");
    require_dashboard_job(overviews, id, target)?;
    dashboard_job_set_state(graph_directory, job, state)
}

/// Construct Task-create mutation inside an authoritative SQLite mutateJob
/// transaction. Reserved IDs must come from Relay's native global sequence.
pub fn workspace_task_create_snapshot(
    graph_directory: &Path,
    store_directory: &Path,
    overviews: &[Value],
    current: &Value,
    supplied_task: &Value,
    idempotency_key: Option<&str>,
) -> Result<(Value, String, bool), String> {
    let job_id = field(current, "id").to_owned();
    require_dashboard_job(overviews, &job_id, None)?;
    if supplied_task.get("jobId").and_then(Value::as_str) != Some(&job_id) {
        return Err(format!("Task {} belongs to {}, not {}",
            field(supplied_task, "id"),field(supplied_task, "jobId"),job_id));
    }
    if is_terminal(current) {
        return Err(format!("Cannot create task on terminal job {} ({})",
            job_id,field(current,"state")));
    }
    if !field(supplied_task, "id").is_empty() {
        return Err("Task IDs are allocated by Relay and cannot be supplied".into());
    }
    let repository = field(current, "repository");
    let request_key = idempotency_key.map(|key|format!("{job_id}:{key}"));
    let id = allocate_entity_id(
        store_directory, repository, "task",
        request_key.as_deref(), &HashSet::new(),
    )?;
    let mut job = current.clone();
    if let Some(existing) = tasks(&job).iter().find(|task|field(task,"id")==id) {
        if idempotency_key.is_none()
            || existing.get("input") != supplied_task.get("input")
            || existing.get("output") != supplied_task.get("output") {
            return Err(format!("Task {id} already exists with a different definition or no retry key"));
        }
        return Ok((job, id, true));
    }
    let mut task = supplied_task.clone();
    task["id"] = json!(id);
    job.get_mut("tasks").and_then(Value::as_array_mut)
        .ok_or("Job snapshot missing Task array")?.push(task);
    let timestamp=iso8601_now();
    if field(&job,"state")=="DRAFT" {
        let decision=dispatch_job_lifecycle_sync(graph_directory,&mut job,
            "activate",&json!({}),&timestamp)?;
        if decision.get("accepted")!=Some(&Value::Bool(true)) {
            return Err(format!("Job {job_id} activation rejected"));
        }
    }
    job["updatedAt"] = json!(timestamp);
    Ok((job,id,false))
}
/// All Task mutations return control requests consumed by the existing daemon
/// Task dispatcher; the UI cannot directly write a Task lifecycle state.
pub fn workspace_task_action_request(
    overviews: &[Value], job: &Value, task_id: &str, action: &str,
) -> Result<Value, String> {
    require_dashboard_job(overviews, field(job, "id"), None)?;
    dashboard_task_action(job,task_id,action)
}
pub fn workspace_task_set_state_request(
    overviews: &[Value], job: &Value, task_id: &str,
    state: &str, target: Option<&Value>,
) -> Result<Option<Value>, String> {
    require_dashboard_job(overviews, field(job, "id"), target)?;
    dashboard_task_set_state(job,task_id,state)
}

/// Node src/relayd-dashboard-actions.ts public createDashboardActions factory.
/// The server injects one authoritative SQLite-bound Store/Pool backend;
/// browser-side HTML and Dashboard policy are intentionally not copied here.
/// Every non-pure operation is delegated to the SAME backend after validation.
pub trait DashboardActionPorts {
    fn overviews(&mut self)->Result<Vec<Value>,String>;
    fn require_local_binding(&mut self,job_id:&str)->Result<(),String>;
    fn load_job(&mut self,job_id:&str)->Result<Value,String>;
    fn job_action(&mut self,job_id:&str,action:&str)->Result<Value,String>;
    fn job_set_state(&mut self,job_id:&str,state:&str)->Result<Value,String>;
    fn task_action(&mut self,job_id:&str,task_id:&str,action:&str)->Result<Value,String>;
    fn task_set_state(&mut self,job_id:&str,task_id:&str,state:&str)->Result<Value,String>;
    fn task_id(&mut self,job_id:&str,repository:&str,key:Option<&str>)
        ->Result<String,String>;
    fn mutate_job(&mut self,job_id:&str,
        update:&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>;
    fn append_task(&mut self,job_id:&str,task:&Value)->Result<(),String>;
    fn save_job(&mut self,job:&Value)->Result<(),String>;
    fn apply_job_activate(&mut self,job:&mut Value)->Result<(),String>{
        let decision=dispatch_job_lifecycle_sync(self.workflow_directory(),job,
            "activate",&json!({}),&iso8601_now())?;
        if decision.get("accepted")!=Some(&Value::Bool(true)){
            return Err(format!("Job {} activation rejected",field(job,"id")));
        }
        Ok(())
    }
    fn supports_mutate_job(&self)->bool{true}
    fn reconcile_local_job(&mut self,job_id:&str,reason:&str)->Result<(),String>;
    fn refresh_all(&mut self)->Result<(),String>;
    fn workflow_directory(&self)->&Path;
}
pub struct DashboardActions<Ports:DashboardActionPorts>{
    pub ports:Ports,
}
pub fn create_dashboard_actions<Ports:DashboardActionPorts>(
    ports:Ports,
)->DashboardActions<Ports>{
    DashboardActions{ports}
}
impl<Ports:DashboardActionPorts> DashboardActions<Ports>{
    pub fn dashboard_overview(
        &mut self,job_id:&str,target:Option<&Value>,
    )->Result<Option<Value>,String>{
        Ok(dashboard_overview(&self.ports.overviews()?,job_id,target))
    }
    fn require_visible(&mut self,job_id:&str,target:Option<&Value>)->Result<(),String>{
        require_dashboard_job(&self.ports.overviews()?,job_id,target).map(|_|())
    }
    pub fn workspace_job_action(&mut self,job_id:&str,action:&str)
        ->Result<Value,String>{
        self.require_visible(job_id,None)?;
        self.ports.require_local_binding(job_id)?;
        if action=="reconcile"{
            self.ports.reconcile_local_job(job_id,"control.job.reconcile")?;
            return self.ports.load_job(job_id);
        }
        self.ports.job_action(job_id,action)
    }
    pub fn workspace_job_set_state(&mut self,job_id:&str,state:&str,
        target:Option<&Value>)->Result<Value,String>{
        self.require_visible(job_id,target)?;
        self.ports.require_local_binding(job_id)?;
        let result=self.ports.job_set_state(job_id,state)?;
        self.ports.refresh_all()?;
        Ok(result)
    }
    pub fn workspace_task_create(&mut self,job_id:&str,provided:&Value,
        idempotency_key:Option<&str>)->Result<Value,String>{
        self.require_visible(job_id,None)?;
        if field(provided,"jobId")!=job_id{
            return Err(format!("Task {} belongs to {}, not {}",
                field(provided,"id"),field(provided,"jobId"),job_id));
        }
        self.ports.require_local_binding(job_id)?;
        let job=self.ports.load_job(job_id)?;
        if is_terminal(&job){return Err(format!(
            "Cannot create task on terminal job {} ({})",field(&job,"id"),field(&job,"state")))}
        if !field(provided,"id").is_empty(){
            return Err("Task IDs are allocated by Relay and cannot be supplied".into());
        }
        let key=idempotency_key.map(|value|format!("{job_id}:{value}"));
        let id=self.ports.task_id(job_id,field(&job,"repository"),key.as_deref())?;
        let mut task=provided.clone();task["id"]=json!(id);
        let mut already_created=false;
        if self.ports.supports_mutate_job(){
            let directory=self.ports.workflow_directory().to_path_buf();
            self.ports.mutate_job(job_id,&mut |mut current|{
                if is_terminal(&current){return Err(format!(
                    "Cannot create task on terminal job {}",field(&current,"id")))}
                if let Some(existing)=tasks(&current).iter().find(|candidate|
                    field(candidate,"id")==id){
                    if idempotency_key.is_none()
                        || existing.get("input")!=task.get("input")
                        || existing.get("output")!=task.get("output"){
                        return Err(format!(
                            "Task {id} already exists with a different definition or no retry key"));
                    }
                    already_created=true;
                    return Ok(current);
                }
                current.get_mut("tasks").and_then(Value::as_array_mut)
                    .ok_or("Job snapshot missing Task array")?.push(task.clone());
                if field(&current,"state")=="DRAFT"{
                    let decision=dispatch_job_lifecycle_sync(&directory,&mut current,
                        "activate",&json!({}),&iso8601_now())?;
                    if decision.get("accepted")!=Some(&Value::Bool(true)){
                        return Err(format!("Job {job_id} activation rejected"));
                    }
                }
                current["updatedAt"]=json!(iso8601_now());
                Ok(current)
            })?;
        }else{
            if idempotency_key.is_some(){
                if let Some(existing)=tasks(&job).iter().find(|candidate|
                    field(candidate,"id")==id){
                    if existing.get("input")!=task.get("input")
                        || existing.get("output")!=task.get("output"){
                        return Err(format!(
                            "Task {id} already exists with a different definition"));
                    }
                    let mut reply=job.clone();reply["createdTaskId"]=json!(id);
                    return Ok(reply);
                }
            }
            self.ports.append_task(job_id,&task)?;
            // Mirror Node's compatibility branch exactly: after appendTask,
            // activate the refreshed DRAFT Job and persist that same snapshot.
            // Production backends must still use the atomic mutateJob path.
            let mut refreshed=self.ports.load_job(job_id)?;
            if field(&refreshed,"state")=="DRAFT"{
                self.ports.apply_job_activate(&mut refreshed)?;
                self.ports.save_job(&refreshed)?;
            }
        }
        if !already_created{
            self.ports.reconcile_local_job(job_id,"control.task.create")?;
        }
        let mut reply=self.ports.load_job(job_id)?;
        reply["createdTaskId"]=json!(id);
        Ok(reply)
    }
    pub fn workspace_task_action(&mut self,job_id:&str,task_id:&str,
        action:&str)->Result<Value,String>{
        self.require_visible(job_id,None)?;
        self.ports.require_local_binding(job_id)?;
        self.ports.task_action(job_id,task_id,action)
    }
    pub fn workspace_task_set_state(&mut self,job_id:&str,task_id:&str,
        state:&str,target:Option<&Value>)->Result<Value,String>{
        self.require_visible(job_id,target)?;
        self.ports.require_local_binding(job_id)?;
        let result=self.ports.task_set_state(job_id,task_id,state)?;
        self.ports.refresh_all()?;
        Ok(result)
    }
}
