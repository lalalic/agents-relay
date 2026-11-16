//! Private same-user control socket for mutations owned by the native daemon.
//! Requests are deliberately typed and allowlisted; the daemon is the only
//! process that opens RelayAuthority for these production CLI mutations.
use crate::authority::{NativeObjectiveJobSpec, RelayAuthority, TroubleshooterEscalationRequest};
use crate::dispatch::ActionPorts;
use crate::graph::{Decision, Graph, GraphInput};
use crate::lifecycle::apply_pure_task_actions;
use crate::native_daemon::isolated_store_root;
use crate::supervised_script::after_time;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::time::Duration;

const SOCKET_NAME: &str = ".rc.sock";
const MAX_REQUEST: usize = 64 * 1024;
const IO_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ControlRequest {
    pub version: u8,
    pub operation: String,
    pub repository: String,
    pub id: String,
    pub title: String,
    pub objective: String,
    pub project_root: String,
    pub project_path: Option<String>,
    pub priority: String,
    pub review_enabled: bool,
    pub auto_merge: bool,
    /// Only Job update supports this allowlisted patch; absent in legacy create requests.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub changes: Option<Value>,
    /// Optional reason for safe Job cancellation.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Exact Task identity for daemon-owned, append-only task.comment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    /// Supplementary text only; never a Task lifecycle or human Review decision.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Exact currently leased Troubleshooter recovery identity, not a new Task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recovery_task_id: Option<String>,
    /// Optional diagnosis; its route flags are only valid with a failureKind.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub diagnosis: Option<Value>,
    /// Graph-governed FAILED Task classification with evidence and target.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub classification: Option<Value>,
    /// Structured Troubleshooter human-escalation request, not human approval.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalation: Option<Value>,
}
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlResponse {
    ok: bool,
    result: Option<Value>,
    error: Option<String>,
}

fn socket_path(db: &Path) -> Result<PathBuf, String> {
    let root = isolated_store_root(db)?;
    #[cfg(unix)]
    {
        let meta = fs::metadata(&root).map_err(|e| e.to_string())?;
        if meta.uid() != unsafe { libc::geteuid() } || meta.permissions().mode() & 0o777 != 0o700 {
            return Err("control socket root must be user-owned and mode 0700".into());
        }
    }
    Ok(root.join(SOCKET_NAME))
}
fn peer_uid(stream: &UnixStream) -> Result<u32, String> {
    #[cfg(target_os = "linux")]
    {
        let mut credentials: libc::ucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_SOCKET,
                libc::SO_PEERCRED,
                (&mut credentials as *mut libc::ucred).cast(),
                &mut length,
            )
        };
        if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
            return Err("unable to authenticate control socket peer".into());
        }
        Ok(credentials.uid)
    }
    #[cfg(target_os = "macos")]
    {
        let mut credentials: libc::xucred = unsafe { std::mem::zeroed() };
        let mut length = std::mem::size_of::<libc::xucred>() as libc::socklen_t;
        let result = unsafe {
            libc::getsockopt(
                stream.as_raw_fd(),
                libc::SOL_LOCAL,
                libc::LOCAL_PEERCRED,
                (&mut credentials as *mut libc::xucred).cast(),
                &mut length,
            )
        };
        if result != 0 || length as usize != std::mem::size_of::<libc::xucred>() {
            return Err("unable to authenticate control socket peer".into());
        }
        Ok(credentials.cr_uid)
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    {
        let _ = stream;
        Err("same-user Unix peer credentials are unsupported on this platform".into())
    }
}
fn peer_is_authorized(peer: u32, expected: u32) -> bool {
    peer == expected
}
fn read_request(stream: &mut UnixStream) -> Result<ControlRequest, String> {
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut data = Vec::with_capacity(1024);
    let mut byte = [0u8; 1];
    loop {
        match stream.read(&mut byte) {
            Ok(0) => return Err("incomplete control request".into()),
            Ok(_) if byte[0] == b'\n' => break,
            Ok(_) => {
                if data.len() == MAX_REQUEST {
                    return Err("control request exceeds 64 KiB".into());
                }
                data.push(byte[0]);
            }
            Err(e) => return Err(format!("control request read failed: {e}")),
        }
    }
    serde_json::from_slice(&data).map_err(|e| format!("invalid control request: {e}"))
}
fn write_response(stream: &mut UnixStream, response: ControlResponse) -> Result<(), String> {
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut data = serde_json::to_vec(&response).map_err(|e| e.to_string())?;
    data.push(b'\n');
    stream
        .write_all(&data)
        .map_err(|e| format!("control response write failed: {e}"))
}

/// Called ONLY in the daemon's serialized control loop, after acquiring its
/// lifetime single-writer lock. The Graph remains the authority for cancel;
/// active Task/Planner leases are never cleared by a control request.
/// Job-wide unblock uses the same authoritative Mermaid Graph gates as Node:
/// only effectively BLOCKED Troubleshooter tasks with no pending human response.
/// A single SQLite IMMEDIATE transaction unblocks all or none.
fn dispatch_job_unblock(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.changes.is_some() {
        return Err("job.unblock does not accept update fields".into());
    }
    let reason = request
        .reason
        .as_deref()
        .ok_or("job unblock requires --reason")?;
    if reason.trim().is_empty() || reason.len() > 2048 {
        return Err("job unblock requires nonempty --reason of at most 2048 bytes".into());
    }
    let mut authority = RelayAuthority::open_existing(db)?;
    let previous = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if previous["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("Local Job/PR binding mismatch".into());
    }
    let at = after_time(
        previous["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let unblock = Graph::parse(include_str!("../../workflow/authoritative-unblock.mmd"))?;
    let lifecycle = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let mut facts = HashMap::new();
    facts.insert("blockedTroubleshooter".into(), true);
    let validated = unblock.decide(
        "blocked",
        GraphInput {
            transport: "event".into(),
            id: "task.authoritative_unblock".into(),
            payload: json!({}),
        },
        &facts,
    )?;
    let Decision::Accepted {
        target, actions, ..
    } = validated
    else {
        return Err("authoritative Unblock Graph rejected blocked Troubleshooter".into());
    };
    if target != "troubleshooter_queued" || !actions.iter().any(|a| a.id == "unblock.retry") {
        return Err("unexpected Unblock Graph target or action".into());
    }
    facts.clear();
    facts.insert("troubleshooterTask".into(), true);
    let task_decision = lifecycle.decide(
        "BLOCKED",
        GraphInput {
            transport: "event".into(),
            id: "task.unblocked".into(),
            payload: json!({}),
        },
        &facts,
    )?;
    let Decision::Accepted {
        target,
        actions: task_actions,
        ..
    } = task_decision
    else {
        return Err("canonical Task Graph rejected Troubleshooter unblock".into());
    };
    if target != "QUEUED" {
        return Err("unexpected Task Graph unblock target".into());
    }
    let result=authority.commit_job(&request.id,&at,|prior|{
        if prior["repository"].as_str()!=Some(request.repository.as_str()){
            return Err("Job identity changed".into());
        }
        if matches!(prior["state"].as_str(),Some("CANCELLED"|"COMPLETED")){
            return Err("cannot unblock terminal Job".into());
        }
        let source_tasks=prior["tasks"].as_array().ok_or("Job tasks missing")?;
        let blocked=source_tasks.iter().filter(|t|
            t["kind"]!="planner"&&t["agentName"]=="troubleshooter"&&t["state"]=="BLOCKED"
        ).collect::<Vec<_>>();
        if blocked.is_empty(){return Err("Job has no effective BLOCKED work task".into());}
        if blocked.iter().any(|t|t["escalation"]["status"]=="pending"){
            return Err("Blocked Troubleshooter requires an authorized human response; use task unblock --response".into());
        }
        if blocked.iter().any(|t|t.get("executionId").is_some_and(|v|!v.is_null())
            ||t.get("leaseOwner").is_some_and(|v|!v.is_null())){
            return Err("cannot unblock active Troubleshooter execution lease".into());
        }
        let mut next=prior.clone();
        for task in next["tasks"].as_array_mut().into_iter().flatten(){
            if task["kind"]=="planner"||task["agentName"]!="troubleshooter"||task["state"]!="BLOCKED"{continue;}
            let baseline=task.get("blockedBaseline").filter(|v|!v.is_null()).cloned()
                .unwrap_or_else(||json!({"blockedAt":task["updatedAt"],"reason":task["error"]}));
            let mut record=json!({
                "event":"task.unblocked","at":at,"source":"cli","reason":reason,
                "baseline":baseline,"facts":[format!("unblock: {reason}")]
            });
            if let Some(head)=prior["headSha"].as_str(){
                record["currentHeadSha"]=json!(head);
            }
            task["blockedBaseline"]=baseline;
            task["unblock"]=record;
            for action in &task_actions{
                match action.id.as_str(){
                    "mutation.clearError"=>task["error"]=Value::Null,
                    "mutation.clearFailureReason"=>{task.as_object_mut().map(|m|m.remove("failureReason"));},
                    _=>return Err(format!("unexpected Task unblock action {}",action.id)),
                }
            }
            task["state"]=json!("QUEUED");
            task["attempt"]=json!(0);
            task["maxAttempts"]=json!(task["maxAttempts"].as_i64().unwrap_or(0).max(3));
            task["leaseOwner"]=Value::Null;
            task["leaseExpiresAt"]=Value::Null;
            task["executionId"]=Value::Null;
            task.as_object_mut().map(|m|m.remove("blockedBy"));
            task["updatedAt"]=json!(at);
        }
        next["updatedAt"]=json!(at);
        Ok((next,vec![]))
    })?;
    let resumed = result.job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|task| task["unblock"]["source"] == "cli" && task["unblock"]["at"] == at)
        .filter_map(|task| task["id"].as_str())
        .collect::<Vec<_>>();
    Ok(json!({"jobId":request.id,"resumedTasks":resumed}))
}

fn dispatch_job_mutation(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.version != 1 {
        return Err("unsupported native control version".into());
    }
    if request.id.trim().is_empty()
        || request.id.len() > 128
        || request.repository.trim().is_empty()
        || request.repository.len() > 500
    {
        return Err("Job mutation requires exact --id and --repo identities".into());
    }
    if request.operation == "job.unblock" {
        return dispatch_job_unblock(db, request);
    }
    let operation = request.operation.as_str();
    if !matches!(
        operation,
        "job.update" | "job.pause" | "job.resume" | "job.cancel"
    ) {
        return Err("unsupported native control operation".into());
    }
    if operation != "job.update" && request.changes.is_some() {
        return Err("Job lifecycle operation does not accept update fields".into());
    }
    if operation != "job.cancel" && request.reason.is_some() {
        return Err("--reason is only valid for job.cancel".into());
    }
    if request
        .reason
        .as_ref()
        .is_some_and(|reason| reason.len() > 2048)
    {
        return Err("Job cancellation reason exceeds 2048 bytes".into());
    }
    let changes = if operation == "job.update" {
        let map = request
            .changes
            .as_ref()
            .and_then(Value::as_object)
            .ok_or("job.update requires a JSON object of mutable fields")?;
        if map.is_empty() {
            return Err("job.update requires at least one mutable option".into());
        }
        for key in map.keys() {
            if !matches!(
                key.as_str(),
                "title"
                    | "objective"
                    | "projectRoot"
                    | "projectPath"
                    | "priority"
                    | "reviewEnabled"
                    | "autoMerge"
            ) {
                return Err(format!("unsupported Job update property {key}"));
            }
        }
        for key in ["title", "objective"] {
            if let Some(value) = map.get(key) {
                let s = value
                    .as_str()
                    .ok_or_else(|| format!("{key} must be text"))?;
                if s.trim().is_empty()
                    || (key == "title" && s.len() > 200)
                    || (key == "objective" && s.len() > 65_536)
                {
                    return Err(format!("{key} is empty or exceeds permitted length"));
                }
            }
        }
        if let Some(value) = map.get("priority") {
            if !value
                .as_str()
                .is_some_and(|x| matches!(x, "P0" | "P1" | "P2" | "P3"))
            {
                return Err("priority must be P0, P1, P2, or P3".into());
            }
        }
        for key in ["reviewEnabled", "autoMerge"] {
            if map.get(key).is_some_and(|x| !x.is_boolean()) {
                return Err(format!("{key} must be boolean"));
            }
        }
        if let Some(root) = map.get("projectRoot") {
            let root = root.as_str().ok_or("projectRoot must be a string")?;
            let path = Path::new(root)
                .canonicalize()
                .map_err(|e| format!("projectRoot: {e}"))?;
            if !path.is_dir() || !path.is_absolute() {
                return Err("projectRoot must be an existing absolute directory".into());
            }
        }
        if let Some(path) = map.get("projectPath") {
            if !(path.is_null() || path.as_str().is_some()) {
                return Err("projectPath must be a string or null".into());
            }
        }
        Some(map.clone())
    } else {
        None
    };
    let mut authority = RelayAuthority::open_existing(db)?;
    let original = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if original["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("Local Job/PR binding mismatch".into());
    }
    let at = after_time(
        original["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let reason = request.reason.clone();
    let result=authority.commit_job(&request.id,&at,|prior|{
        // Defense in depth: commit reads the actual current snapshot under
        // IMMEDIATE SQLite transaction, not the stale preflight snapshot.
        if prior["repository"].as_str()!=Some(request.repository.as_str()){
            return Err("Job repository identity changed".into());
        }
        let mut next=prior.clone();
        match operation{
            "job.update"=>{
                let changes=changes.as_ref().expect("validated patch");
                for (key,value) in changes{
                    if key=="projectRoot" {
                        let canonical=Path::new(value.as_str().unwrap()).canonicalize()
                            .map_err(|e|format!("projectRoot: {e}"))?;
                        next[key]=json!(canonical.to_string_lossy().to_string());
                    }else {
                        next[key]=value.clone();
                    }
                }
                if let Some(path)=next["projectPath"].as_str(){
                    let root=next["projectRoot"].as_str().ok_or("Job projectRoot missing")?;
                    let canonical_root=Path::new(root).canonicalize().map_err(|e|e.to_string())?;
                    let candidate=canonical_root.join(path).canonicalize().map_err(|e|format!("projectPath: {e}"))?;
                    if !candidate.starts_with(&canonical_root){
                        return Err("projectPath escapes Job projectRoot".into());
                    }
                }
            }
            "job.pause"=>{
                if matches!(prior["state"].as_str(),Some("COMPLETED"|"CANCELLED"|"FAILED")){
                    return Err("Cannot pause terminal Job".into());
                }
                if prior.get("pause").is_none_or(Value::is_null){
                    for task in prior["tasks"].as_array().into_iter().flatten(){
                        if matches!(task["state"].as_str(),Some("RUNNING"|"AWAITING_DECISION"))
                            || task.get("executionId").is_some_and(|x|!x.is_null())
                            || task.get("leaseOwner").is_some_and(|x|!x.is_null()){
                            return Err("pause requires daemon-coordinated cancellation of active executions; refusing to clear a live lease".into());
                        }
                    }
                    next["pause"]=json!({"generation":1,"requestedAt":at});
                }
            }
            "job.resume"=>{
                if matches!(prior["state"].as_str(),Some("COMPLETED"|"CANCELLED"|"FAILED")){
                    return Err("Cannot resume terminal Job".into());
                }
                next.as_object_mut().ok_or("Job object expected")?.remove("pause");
            }
            "job.cancel"=>{
                // Reuse the exact production Job and Task Mermaid Graphs.
                let graph=Graph::parse(include_str!("../../workflow/job-lifecycle.mmd"))?;
                let state=prior["state"].as_str().ok_or("Job state missing")?;
                let decision=graph.decide(state,GraphInput{transport:"event".into(),id:"cancel".into(),payload:json!({})},&HashMap::new())?;
                let Decision::Accepted{target,actions,..}=decision else {
                    return Err("canonical Job Graph denied cancellation".into());
                };
                if target!="CANCELLED"||!actions.iter().any(|a|a.id=="effect.cancelActiveTasks"){
                    return Err("canonical Job Graph selected unsupported cancellation effect".into());
                }
                if prior["plans"].as_array().is_some_and(|plans|plans.iter().any(|plan|plan["status"]=="PLANNING")){
                    return Err("cancel with active Planner lease requires coordinated Planner cancellation".into());
                }
                let task_graph=Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
                for task in next["tasks"].as_array_mut().into_iter().flatten(){
                    let state=task["state"].as_str().ok_or("Task state missing")?.to_owned();
                    if matches!(state.as_str(),"RUNNING"|"AWAITING_DECISION")
                        || task.get("executionId").is_some_and(|x|!x.is_null())
                        || task.get("leaseOwner").is_some_and(|x|!x.is_null()){
                        return Err("cancel with active Task execution requires coordinated process shutdown".into());
                    }
                    if matches!(state.as_str(),"DRAFT"|"QUEUED"){
                        let effect=task_graph.decide(&state,GraphInput{transport:"event".into(),id:"cancel".into(),payload:json!({})},&HashMap::new())?;
                        let Decision::Accepted{target,..}=effect else {
                            return Err(format!("canonical Task Graph denied cancellation for Task {}",task["id"]));
                        };
                        if target!="CANCELLED"{return Err("unexpected Task cancellation state".into());}
                        task["state"]=json!("CANCELLED");
                        task["error"]=json!(reason.as_deref().unwrap_or("Job cancelled"));
                        task["updatedAt"]=json!(at);
                    }else if !matches!(state.as_str(),"SUCCEEDED"|"FAILED"|"CANCELLED"){
                        return Err(format!("unsafe cancellation of Task in state {state}"));
                    }
                }
                next["state"]=json!("CANCELLED");
            }
            _=>unreachable!(),
        }
        next["updatedAt"]=json!(at);
        Ok((next,vec![]))
    })?;
    Ok(json!({"job":result.job,"operation":operation}))
}

/// Append a Task comment without touching its execution generation, lease,
/// result, Task updatedAt or lifecycle state. The authoritative Job snapshot
/// is the append-only source of truth. Never interpret comments as approvals.
fn dispatch_task_comment(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.escalation.is_some()
        || request.classification.is_some()
        || request.changes.is_some()
        || request.reason.is_some()
        || request.recovery_task_id.is_some()
        || request.diagnosis.is_some()
        || !request.title.is_empty()
        || !request.objective.is_empty()
        || !request.project_root.is_empty()
        || request.project_path.is_some()
        || !request.priority.is_empty()
        || request.review_enabled
        || request.auto_merge
    {
        return Err("task.comment does not accept Job mutation fields".into());
    }
    if request.id.trim().is_empty()
        || request.id.len() > 128
        || request.repository.trim().is_empty()
        || request.repository.len() > 500
    {
        return Err("task.comment requires exact Job ID and repository".into());
    }
    let task_id = request
        .task_id
        .as_deref()
        .filter(|id| !id.trim().is_empty() && id.len() <= 128)
        .ok_or("task.comment requires --task-id (1..128 bytes)")?;
    let message = request
        .message
        .as_deref()
        .ok_or("task.comment requires --message or --message-file")?
        .trim();
    if message.is_empty() || message.len() > 60_000 {
        return Err("task.comment requires nonempty message of at most 60000 bytes".into());
    }
    let mut authority = RelayAuthority::open_existing(db)?;
    let prior = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if prior["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("repository identity mismatch".into());
    }
    if !prior["tasks"]
        .as_array()
        .is_some_and(|tasks| tasks.iter().any(|t| t["id"].as_str() == Some(task_id)))
    {
        return Err(format!("Task {task_id} not found"));
    }
    let at = after_time(prior["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let comment = json!({"id":uuid::Uuid::new_v4().to_string(),"text":message,
        "author":"cli","createdAt":at,"jobId":request.id,"taskId":task_id});
    let saved = authority.commit_job(&request.id, &at, |current| {
        if current["repository"].as_str() != Some(request.repository.as_str()) {
            return Err("repository identity changed before comment append".into());
        }
        let mut next = current.clone();
        let task = next["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|t| t["id"].as_str() == Some(task_id)))
            .ok_or("Task disappeared before comment append")?;
        if task
            .get("comments")
            .is_some_and(|v| !v.is_null() && !v.is_array())
        {
            return Err("Task comment history is malformed; refusing overwrite".into());
        }
        if task.get("comments").is_none_or(Value::is_null) {
            task["comments"] = json!([]);
        }
        task["comments"]
            .as_array_mut()
            .ok_or("Task comments must be an array")?
            .push(comment.clone());
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    let persisted = saved.job["tasks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|t| t["id"].as_str() == Some(task_id))
        .and_then(|t| t["comments"].as_array())
        .and_then(|history| history.iter().find(|c| c["id"] == comment["id"]))
        .cloned()
        .ok_or("committed Task comment missing")?;
    Ok(persisted)
}

/// The same authority action is callable directly only for disposable
/// isolated tests. A live CLI must use the daemon socket's single writer.
pub fn append_task_comment_isolated(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("production Task comments require daemon-owned control socket".into());
    }
    isolated_store_root(db)?;
    dispatch_task_comment(db, request)
}

#[derive(Default)]
struct NativeRecoveryApproval {
    authorized: bool,
}
impl ActionPorts for NativeRecoveryApproval {
    fn persist_transition(&mut self, from: &str, to: &str) -> Result<(), String> {
        if from != "unresolved" || to != "resolved" {
            return Err("Task Resolution Graph did not authorize exact original retry".into());
        }
        Ok(())
    }
    fn execute_action(&mut self, id: &str, _input: &GraphInput) -> Result<Value, String> {
        if id != "resolution.activateRecovery" {
            return Err(format!(
                "Task Resolution Graph selected unexpected effect {id}"
            ));
        }
        self.authorized = true;
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, id: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected Task Resolution emitted event {id}"))
    }
}

/// CLI recovery shares this exact function in isolated E2E and the daemon's
/// private Unix-socket single-writer transport. No direct live SQLite writes.
fn dispatch_task_recover(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.escalation.is_some()
        || request.classification.is_some()
        || request.changes.is_some()
        || request.reason.is_some()
        || request.message.is_some()
        || !request.title.is_empty()
        || !request.objective.is_empty()
        || !request.project_root.is_empty()
        || request.project_path.is_some()
        || !request.priority.is_empty()
        || request.review_enabled
        || request.auto_merge
    {
        return Err("task.recover accepts only Task recovery fields".into());
    }
    if request.id.trim().is_empty()
        || request.id.len() > 128
        || request.repository.trim().is_empty()
        || request.repository.len() > 500
    {
        return Err("task.recover requires exact Job ID and repository".into());
    }
    let task_id = request
        .task_id
        .as_deref()
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .ok_or("task recover requires --task-id")?;
    let recovery_id = request
        .recovery_task_id
        .as_deref()
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .ok_or("task recover requires --recovery-task-id")?;
    if task_id == recovery_id {
        return Err("original and Troubleshooter IDs must differ".into());
    }
    let diagnosis = request
        .diagnosis
        .as_ref()
        .map(|d| {
            let o = d
                .as_object()
                .ok_or("recovery diagnosis must be a JSON object")?;
            for key in o.keys() {
                if !matches!(
                    key.as_str(),
                    "failureKind" | "reason" | "evidence" | "reroute" | "excludeCurrentRoute"
                ) {
                    return Err(format!("unsupported recovery diagnosis field {key}"));
                }
            }
            let kind = o
                .get("failureKind")
                .and_then(Value::as_str)
                .ok_or("diagnosis requires failureKind")?;
            if !matches!(
                kind,
                "adapter_failure"
                    | "model_failure"
                    | "provider_failure"
                    | "task_failure"
                    | "unknown"
            ) {
                return Err("Invalid recovery failureKind".into());
            }
            let reason = o
                .get("reason")
                .and_then(Value::as_str)
                .ok_or("diagnosis requires reason")?;
            if reason.trim().is_empty() || reason.len() > 4096 {
                return Err(
                    "Recovery diagnosis requires nonempty reason of at most 4096 bytes".into(),
                );
            }
            if o.get("evidence").is_some_and(|v| !v.is_string()) {
                return Err("diagnosis evidence must be text".into());
            }
            if o.get("evidence")
                .and_then(Value::as_str)
                .is_some_and(|s| s.len() > 16000)
            {
                return Err("recovery evidence exceeds 16000 bytes".into());
            }
            for f in ["reroute", "excludeCurrentRoute"] {
                if o.get(f).is_some_and(|v| !v.is_boolean()) {
                    return Err(format!("{f} must be boolean"));
                }
            }
            let reroute = o.get("reroute").and_then(Value::as_bool).unwrap_or(false);
            let exclude = o
                .get("excludeCurrentRoute")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            if exclude && !reroute {
                return Err("Cannot exclude route without reroute".into());
            }
            Ok((
                kind.to_owned(),
                reason.trim().to_owned(),
                o.get("evidence").and_then(Value::as_str).map(str::to_owned),
                reroute,
                exclude,
            ))
        })
        .transpose()?;
    let mut authority = RelayAuthority::open_existing(db)?;
    let before = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if before["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("repository identity mismatch".into());
    }
    let at = after_time(
        before["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let resolution_graph = Graph::parse(include_str!("../../workflow/task-resolution.mmd"))?;
    let lifecycle = Graph::parse(include_str!("../../workflow/task-lifecycle.mmd"))?;
    let committed=authority.commit_job(&request.id,&at,|prior|{
        if prior["repository"].as_str()!=Some(request.repository.as_str()){
            return Err("repository identity changed before Task recovery".into());
        }
        if prior["state"]!="ACTIVE"||prior.get("pause").is_some_and(|v|!v.is_null()){
            return Err("task recover requires active unpaused Job".into());
        }
        let original=prior["tasks"].as_array().and_then(|tasks|tasks.iter().find(|t|t["id"]==task_id))
            .ok_or("original Task not found")?;
        let recovery=prior["tasks"].as_array().and_then(|tasks|tasks.iter().find(|t|t["id"]==recovery_id))
            .ok_or("Troubleshooter recovery Task not found")?;
        if original["kind"]=="planner"||original["state"]!="FAILED"{
            return Err("exact-original recovery requires FAILED non-Planner Task".into());
        }
        if ["executionId","leaseOwner","leaseExpiresAt"].iter().any(|k|
            original.get(*k).is_some_and(|v|!v.is_null())){
            return Err("original FAILED Task still has active execution lease".into());
        }
        if recovery["agentName"]!="troubleshooter"||recovery["parentTaskId"]!=task_id
            ||!matches!(recovery["state"].as_str(),Some("QUEUED"|"RUNNING")){
            return Err("task recover requires active Troubleshooter recovery with exact parent Task".into());
        }
        let execution=recovery["executionId"].as_str().filter(|s|!s.is_empty())
            .ok_or("Troubleshooter has no current execution for fresh resolution")?;
        if original["resolution"]["recoveryExecutionId"].as_str()==Some(execution){
            return Err("Task recovery already recorded for this Troubleshooter execution".into());
        }
        if matches!(original["resolution"]["state"].as_str(),Some("active"|"waiting")){
            return Err("original Task has active or waiting recovery ownership".into());
        }
        let proposal=json!({
            "path":"exact_original_retry","targetTaskId":task_id,
            "recoveryExecutionId":execution,
            "rootCause":original["failureReason"].as_str().or_else(||original["error"].as_str()).unwrap_or("durable failure"),
            "solution":format!("Recover exact original Task via {recovery_id}")
        });
        let facts=HashMap::from([
            ("recoveryOwnerAvailable".into(),true),
            ("plannerOwnerAvailable".into(),false),
            ("freshRecoveryExecution".into(),true),
            ("exactOriginalRetry".into(),true),
            ("sameJobDependency".into(),false),
            ("blockerJobDependency".into(),false),
            ("escalationGate".into(),false),
            ("genuinelyObsolete".into(),false),
        ]);
        let mut approval=NativeRecoveryApproval::default();
        let selected=resolution_graph.dispatch_through_transient(
            "unresolved",
            GraphInput{transport:"event".into(),id:"resolution.propose".into(),payload:proposal.clone()},
            &facts,
            |state|matches!(state,"check_owner"|"check_path"|"check_fresh_execution"),
            &mut approval,
        )?;
        if !approval.authorized||!matches!(selected.decision,Decision::Accepted{ref target,..} if target=="resolved"){
            return Err("Task Resolution Graph rejected exact-original recovery".into());
        }
        let transition=lifecycle.decide("FAILED",GraphInput{
            transport:"event".into(),id:"retry".into(),payload:json!({"taskId":task_id})
        },&HashMap::new())?;
        let Decision::Accepted{target,actions,..}=transition else{
            return Err("Task lifecycle Graph denied failed Task retry".into());
        };
        if target!="QUEUED"{return Err("unexpected lifecycle recovery target".into());}
        let mut next=prior.clone();
        let task=next["tasks"].as_array_mut().and_then(|tasks|tasks.iter_mut().find(|t|t["id"]==task_id))
            .ok_or("original Task disappeared during recovery")?;
        task["state"]=json!(target);
        apply_pure_task_actions(task,&actions)?;
        task["error"]=Value::Null;
        task["leaseOwner"]=Value::Null;
        task["leaseExpiresAt"]=Value::Null;
        task["executionId"]=Value::Null;
        let max_attempts=task["maxAttempts"].as_i64().ok_or("Task maxAttempts missing")?;
        let attempt=task["attempt"].as_i64().ok_or("Task attempt missing")?;
        let budget=max_attempts.max(attempt);
        task["maxAttempts"]=json!(((budget/3+1)*3).max(3));
        if let Some((kind,reason,evidence,reroute,exclude))=&diagnosis{
            if *exclude&&task["routing"].is_object(){
                let route=&task["routing"];
                let provider=route["provider"].as_str().unwrap_or("");
                let model=route["model"].as_str().unwrap_or("");
                let profile=route["profile"].as_str();
                let present=task["routingExclusions"].as_array().is_some_and(|existing|existing.iter().any(|item|
                    item["provider"]==provider&&item["model"]==model&&item["profile"].as_str()==profile));
                if !present{
                    let mut excluded=json!({"provider":provider,"model":model,"reason":reason,"at":at});
                    if let Some(profile)=profile{excluded["profile"]=json!(profile);}
                    if task["routingExclusions"].is_null(){task["routingExclusions"]=json!([]);}
                    task["routingExclusions"].as_array_mut().ok_or("routingExclusions must be array")?
                        .push(excluded);
                }
            }
            let mut context=json!({"failureKind":kind,"reason":reason,"recoveryTaskId":recovery_id,
                "at":at,"reroute":reroute});
            if let Some(evidence)=evidence{if !evidence.is_empty(){context["evidence"]=json!(evidence);}}
            task["recoveryContext"]=context;
            if *reroute{
                task.as_object_mut().ok_or("Task must be object")?.remove("routing");
                task.as_object_mut().ok_or("Task must be object")?.remove("workerSelection");
            }
        }
        let mut resolution=proposal;
        resolution["state"]=json!("resolved");
        resolution["owner"]=json!("troubleshooter");
        resolution["updatedAt"]=json!(at);
        task["resolution"]=resolution;
        task["updatedAt"]=json!(at);
        next["updatedAt"]=json!(at);
        Ok((next,vec![]))
    })?;
    committed.job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .cloned()
        .ok_or_else(|| "recovered Task missing from committed Job".to_string())
}

pub fn recover_task_isolated(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("production Task recovery requires daemon-owned control".into());
    }
    isolated_store_root(db)?;
    dispatch_task_recover(db, request)
}

/// Classify one immutable FAILED Task under the canonical Task Resolution
/// Graph. Classification is evidence metadata, never an authorization to
/// complete, retry, cancel or create a replacement Task.
fn dispatch_task_classify(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.escalation.is_some()
        || request.changes.is_some()
        || request.reason.is_some()
        || request.message.is_some()
        || request.recovery_task_id.is_some()
        || request.diagnosis.is_some()
        || !request.title.is_empty()
        || !request.objective.is_empty()
        || !request.project_root.is_empty()
        || request.project_path.is_some()
        || !request.priority.is_empty()
        || request.review_enabled
        || request.auto_merge
    {
        return Err("task.classify accepts only Task classification fields".into());
    }
    if request.id.trim().is_empty()
        || request.id.len() > 128
        || request.repository.trim().is_empty()
        || request.repository.len() > 500
    {
        return Err("task.classify requires exact Job ID and repository".into());
    }
    let task_id = request
        .task_id
        .as_deref()
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .ok_or("task classify requires --task-id")?;
    let classification = request
        .classification
        .as_ref()
        .and_then(Value::as_object)
        .ok_or("task classify requires evidence classification object")?;
    for key in classification.keys() {
        if !matches!(
            key.as_str(),
            "kind" | "targetTaskId" | "reason" | "evidence"
        ) {
            return Err(format!("unsupported classification field {key}"));
        }
    }
    let kind = classification
        .get("kind")
        .and_then(Value::as_str)
        .ok_or("task classify requires --classification")?;
    if !matches!(kind, "superseded" | "invalid") {
        return Err("--classification must be superseded or invalid".into());
    }
    let target_id = classification
        .get("targetTaskId")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .ok_or("task classify requires --target-task-id")?;
    if task_id == target_id {
        return Err("classification target must differ from original Task".into());
    }
    let evidence = classification
        .get("evidence")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 16_000)
        .ok_or("classification requires nonempty evidence of at most 16000 bytes")?;
    let reason = classification
        .get("reason")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty() && s.len() <= 4096)
        .ok_or("classification requires nonempty reason of at most 4096 bytes")?;
    let mut authority = RelayAuthority::open_existing(db)?;
    let before = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if before["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("repository identity mismatch".into());
    }
    let at = after_time(
        before["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let graph = Graph::parse(include_str!("../../workflow/task-resolution.mmd"))?;
    let mut facts = HashMap::from([
        ("classifiableFailure".into(), true),
        ("classificationSuperseded".into(), kind == "superseded"),
        ("supersededEvidenceComplete".into(), kind == "superseded"),
        ("invalidEvidenceComplete".into(), kind == "invalid"),
    ]);
    let decision=graph.decide("unresolved",GraphInput{
        transport:"event".into(),id:"resolution.classify".into(),
        payload:json!({"kind":kind,"targetTaskId":target_id,"reason":reason,"evidence":evidence}),
    },&facts)?;
    let Decision::Accepted {
        target, actions, ..
    } = decision
    else {
        return Err("Task Resolution Graph rejected classification".into());
    };
    let expected = if kind == "superseded" {
        "resolution.classifySuperseded"
    } else {
        "resolution.classifyInvalid"
    };
    if target != "resolved" || actions.len() != 1 || actions[0].id != expected {
        return Err("Task Resolution Graph selected unexpected classification effect".into());
    }
    facts.clear();
    let saved = authority.commit_job(&request.id, &at, |current| {
        if current["repository"].as_str() != Some(request.repository.as_str()) {
            return Err("repository changed before Task classification".into());
        }
        let all = current["tasks"].as_array().ok_or("Job Tasks missing")?;
        if !all.iter().any(|t| t["id"] == target_id) {
            return Err(
                "classification target must identify a different durable Task in this Job".into(),
            );
        }
        let source = all
            .iter()
            .find(|t| t["id"] == task_id)
            .ok_or("original Task not found")?;
        if source["kind"] == "planner"
            || source["state"] != "FAILED"
            || source["failureReason"] == "worker_outcome_unknown"
            || ["executionId", "leaseOwner", "leaseExpiresAt"]
                .iter()
                .any(|k| source.get(*k).is_some_and(|v| !v.is_null()))
            || source
                .get("resolutionClassification")
                .is_some_and(|v| !v.is_null())
            || matches!(
                source["resolution"]["state"].as_str(),
                Some("active" | "waiting")
            )
        {
            return Err(
                "Task Resolution Graph classification requires inactive unclassified FAILED Task"
                    .into(),
            );
        }
        let mut next = current.clone();
        let original = next["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|t| t["id"] == task_id))
            .ok_or("original Task disappeared")?;
        original["resolutionClassification"] = json!({
            "kind":kind,"targetTaskId":target_id,
            "evidence":evidence.trim(),"reason":reason.trim(),"updatedAt":at,
        });
        original["updatedAt"] = json!(at);
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    saved.job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .cloned()
        .ok_or_else(|| "classified Task missing from committed Job".to_owned())
}
pub fn classify_task_isolated(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("production Task classification requires daemon-owned control".into());
    }
    isolated_store_root(db)?;
    dispatch_task_classify(db, request)
}

#[derive(Default)]
struct NativeSupersedeApproval {
    authorized: bool,
}
impl ActionPorts for NativeSupersedeApproval {
    fn persist_transition(&mut self, from: &str, to: &str) -> Result<(), String> {
        if from != "unresolved" || to != "resolved" {
            return Err("Task Resolution Graph rejected cancel supersede".into());
        }
        Ok(())
    }
    fn execute_action(&mut self, id: &str, _input: &GraphInput) -> Result<Value, String> {
        if id != "resolution.cancelSupersede" {
            return Err(format!(
                "Task Resolution Graph selected unexpected supersede effect {id}"
            ));
        }
        self.authorized = true;
        Ok(json!({"ok":true,"payloads":{}}))
    }
    fn publish_event(&mut self, event: &str, _payload: &Value) -> Result<(), String> {
        Err(format!("unexpected Task supersede event {event}"))
    }
}

/// Supersede is evidence annotation of an already CANCELLED Task. It never
/// cancels a Worker, changes a Task's state, or creates replacement work.
fn dispatch_task_supersede(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.escalation.is_some()
        || request.changes.is_some()
        || request.message.is_some()
        || request.classification.is_some()
        || request.recovery_task_id.is_some()
        || request.diagnosis.is_some()
        || !request.title.is_empty()
        || !request.objective.is_empty()
        || !request.project_root.is_empty()
        || request.project_path.is_some()
        || !request.priority.is_empty()
        || request.review_enabled
        || request.auto_merge
    {
        return Err("task.supersede accepts only Task ID and reason".into());
    }
    if request.id.trim().is_empty()
        || request.id.len() > 128
        || request.repository.trim().is_empty()
        || request.repository.len() > 500
    {
        return Err("task.supersede requires exact Job ID and repository".into());
    }
    let task_id = request
        .task_id
        .as_deref()
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .ok_or("task supersede requires --task-id")?;
    let reason = request
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.len() <= 4096)
        .ok_or("task supersede requires nonempty --reason of at most 4096 bytes")?;
    let mut authority = RelayAuthority::open_existing(db)?;
    let before = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if before["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("repository identity mismatch".into());
    }
    let at = after_time(
        before["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    let proposal = json!({"path":"cancel_supersede","targetTaskId":task_id,
        "rootCause":reason,"solution":"Superseded by later corrected durable work"});
    let facts = HashMap::from([
        ("recoveryOwnerAvailable".into(), false),
        ("plannerOwnerAvailable".into(), true),
        ("freshRecoveryExecution".into(), true),
        ("exactOriginalRetry".into(), false),
        ("sameJobDependency".into(), false),
        ("blockerJobDependency".into(), false),
        ("escalationGate".into(), false),
        ("genuinelyObsolete".into(), true),
    ]);
    let graph = Graph::parse(include_str!("../../workflow/task-resolution.mmd"))?;
    let mut approval = NativeSupersedeApproval::default();
    let selected = graph.dispatch_through_transient(
        "unresolved",
        GraphInput {
            transport: "event".into(),
            id: "resolution.propose".into(),
            payload: proposal.clone(),
        },
        &facts,
        |state| {
            matches!(
                state,
                "check_owner" | "check_path" | "check_fresh_execution"
            )
        },
        &mut approval,
    )?;
    if !approval.authorized
        || !matches!(selected.decision,Decision::Accepted{ref target,..} if target=="resolved")
    {
        return Err("Task Resolution Graph rejected cancellation supersede".into());
    }
    let committed = authority.commit_job(&request.id, &at, |prior| {
        if prior["repository"].as_str() != Some(request.repository.as_str()) {
            return Err("Job repository changed before supersede".into());
        }
        let original = prior["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
            .ok_or("Task to supersede not found")?;
        if original["kind"] == "planner" || original["state"] != "CANCELLED" {
            return Err("task supersede requires already CANCELLED non-Planner Task".into());
        }
        if ["leaseOwner", "leaseExpiresAt", "executionId"]
            .iter()
            .any(|key| original.get(*key).is_some_and(|v| !v.is_null()))
        {
            return Err("task supersede refuses active Task execution lease".into());
        }
        if original["resolution"]["path"] == "cancel_supersede" {
            return Err("Task already superseded; original evidence is immutable".into());
        }
        if matches!(
            original["resolution"]["state"].as_str(),
            Some("active" | "waiting")
        ) {
            return Err("task supersede cannot override active resolution ownership".into());
        }
        let mut next = prior.clone();
        let task = next["tasks"]
            .as_array_mut()
            .and_then(|tasks| tasks.iter_mut().find(|t| t["id"] == task_id))
            .ok_or("Task disappeared during supersede")?;
        let mut resolution = proposal.clone();
        resolution["state"] = json!("resolved");
        resolution["owner"] = json!("external");
        resolution["updatedAt"] = json!(at);
        task["resolution"] = resolution;
        task["error"] = json!(format!("Superseded {reason}"));
        task["updatedAt"] = json!(at);
        next["updatedAt"] = json!(at);
        Ok((next, vec![]))
    })?;
    committed.job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .cloned()
        .ok_or_else(|| "superseded Task missing from committed Job".to_owned())
}
pub fn supersede_task_isolated(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("production Task supersede requires daemon-owned control".into());
    }
    isolated_store_root(db)?;
    dispatch_task_supersede(db, request)
}

fn dispatch_task_escalate(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if request.changes.is_some()
        || request.reason.is_some()
        || request.message.is_some()
        || request.recovery_task_id.is_some()
        || request.diagnosis.is_some()
        || request.classification.is_some()
        || !request.title.is_empty()
        || !request.objective.is_empty()
        || !request.project_root.is_empty()
        || request.project_path.is_some()
        || !request.priority.is_empty()
        || request.review_enabled
        || request.auto_merge
    {
        return Err("task.escalate accepts only Task escalation fields".into());
    }
    if request.id.trim().is_empty()
        || request.id.len() > 128
        || request.repository.trim().is_empty()
        || request.repository.len() > 500
    {
        return Err("task.escalate requires exact Job ID and repository".into());
    }
    let task_id = request
        .task_id
        .as_deref()
        .filter(|s| !s.trim().is_empty() && s.len() <= 128)
        .ok_or("task escalate requires --task-id")?;
    let supplied = request
        .escalation
        .as_ref()
        .and_then(Value::as_object)
        .ok_or("task escalate requires --required-action, --resolution-condition and --context")?;
    for key in supplied.keys() {
        if !matches!(
            key.as_str(),
            "requiredAction" | "resolutionCondition" | "context"
        ) {
            return Err(format!("unsupported task escalation property {key}"));
        }
    }
    let text = |key: &str| -> Result<String, String> {
        let raw = supplied
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| format!("task escalate requires {key}"))?
            .trim();
        if raw.is_empty() || raw.len() > 4096 {
            return Err(format!(
                "task escalate {key} must be nonempty and at most 4096 bytes"
            ));
        }
        Ok(raw.to_owned())
    };
    let event = TroubleshooterEscalationRequest {
        required_action: text("requiredAction")?,
        resolution_condition: text("resolutionCondition")?,
        context: text("context")?,
    };
    let mut authority = RelayAuthority::open_existing(db)?;
    let before = authority.read_job(&request.id)?.ok_or("unknown Job")?;
    if before["repository"].as_str() != Some(request.repository.as_str()) {
        return Err("repository identity mismatch".into());
    }
    let at = after_time(
        before["updatedAt"]
            .as_str()
            .ok_or("Job timestamp missing")?,
    )?;
    authority.request_troubleshooter_escalation(&request.id, task_id, &event, &at)?;
    let job = authority
        .read_job(&request.id)?
        .ok_or("Job missing after escalation")?;
    job["tasks"]
        .as_array()
        .and_then(|tasks| tasks.iter().find(|t| t["id"] == task_id))
        .cloned()
        .ok_or_else(|| "Escalated Task missing after commit".to_owned())
}
pub fn escalate_task_isolated(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("production Task escalation requires daemon-owned control".into());
    }
    isolated_store_root(db)?;
    dispatch_task_escalate(db, request)
}

fn dispatch(db: &Path, request: ControlRequest) -> Result<Value, String> {
    if request.version != 1 {
        return Err("unsupported native control version".into());
    }
    if request.operation == "task.escalate" {
        return dispatch_task_escalate(db, &request);
    }
    if request.operation == "task.supersede" {
        return dispatch_task_supersede(db, &request);
    }
    if request.operation == "task.classify" {
        return dispatch_task_classify(db, &request);
    }
    if request.operation == "task.recover" {
        return dispatch_task_recover(db, &request);
    }
    if request.operation == "task.comment" {
        return dispatch_task_comment(db, &request);
    }
    if request.escalation.is_some()
        || request.classification.is_some()
        || request.task_id.is_some()
        || request.message.is_some()
        || request.recovery_task_id.is_some()
        || request.diagnosis.is_some()
    {
        return Err("task fields are only valid for task.comment".into());
    }
    if request.operation != "job.create" {
        return dispatch_job_mutation(db, &request);
    }
    if request.changes.is_some() || request.reason.is_some() {
        return Err("job.create does not accept mutation fields".into());
    }
    if request.id.trim().is_empty() || request.id.len() > 128 {
        return Err("job.create requires an explicit Job ID of at most 128 bytes".into());
    }
    if request.repository.trim().is_empty() || request.repository.len() > 500 {
        return Err("repository identity must be nonempty and at most 500 bytes".into());
    }
    if request.title.trim().is_empty() || request.title.len() > 200 {
        return Err("title must be nonempty and at most 200 bytes".into());
    }
    if request.objective.trim().is_empty() || request.objective.len() > 1_048_576 {
        return Err("objective must be nonempty and at most 1 MB".into());
    }
    if !matches!(request.priority.as_str(), "P0" | "P1" | "P2" | "P3") {
        return Err("priority must be P0, P1, P2, or P3".into());
    }
    let project_root = PathBuf::from(&request.project_root);
    if !project_root.is_absolute() {
        return Err("project root must be absolute".into());
    }
    // Exact ID makes retries safe across daemon restart. A matching existing
    // Job is a readback; any identity/content mismatch is rejected.
    let mut authority = RelayAuthority::open_existing(db)?;
    if let Some(existing) = authority.read_job(&request.id)? {
        let matches = existing["repository"] == request.repository
            && existing["title"] == request.title
            && existing["objective"] == request.objective
            && existing["projectRoot"] == request.project_root
            && existing["projectPath"] == json!(request.project_path)
            && existing["priority"] == request.priority
            && existing["reviewEnabled"] == request.review_enabled
            && existing["autoMerge"] == request.auto_merge;
        if !matches {
            return Err("Job ID already exists with different immutable create identity".into());
        }
        return Ok(json!({"job":existing,"created":false,"deduplicated":true}));
    }
    let at = crate::supervised_script::current_time();
    let job = authority.create_native_objective_job(NativeObjectiveJobSpec {
        repository: &request.repository,
        id: Some(&request.id),
        title: &request.title,
        objective: &request.objective,
        project_root: &request.project_root,
        project_path: request.project_path.as_deref(),
        priority: &request.priority,
        review_enabled: request.review_enabled,
        auto_merge: request.auto_merge,
        idempotency_key: None,
        tag: None,
        github_repo: None,
        creator_thread_id: None,
        reviewer_thread_id: None,
        implementation_thread_id: None,
        continuation: None,
        no_github: false,
        at: &at,
    })?;
    Ok(json!({"job":job,"created":true,"deduplicated":false}))
}

/// Bound the daemon's listener lifetime to the daemon process. A stale socket
/// may be removed only after the single-writer daemon lock has been acquired.
pub struct NativeControlServer {
    listener: UnixListener,
    path: PathBuf,
}
impl NativeControlServer {
    pub fn bind(db: &Path) -> Result<Self, String> {
        let path = socket_path(db)?;
        if let Ok(meta) = fs::symlink_metadata(&path) {
            if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
                return Err("refusing to replace non-owned control socket path".into());
            }
            fs::remove_file(&path).map_err(|e| format!("remove stale control socket: {e}"))?;
        }
        let listener =
            UnixListener::bind(&path).map_err(|e| format!("bind control socket: {e}"))?;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|e| format!("secure control socket: {e}"))?;
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        Ok(Self { listener, path })
    }

    /// Processes at most one queued request, synchronously between daemon ticks.
    pub fn serve_one(&self, db: &Path) -> Result<bool, String> {
        let (mut stream, _) = match self.listener.accept() {
            Ok(pair) => pair,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => return Ok(false),
            Err(e) => return Err(format!("control socket accept failed: {e}")),
        };
        // Listener is nonblocking, but an accepted client may inherit the flag
        // on supported Unix platforms. Switch this individual, timeout-bounded
        // connection to blocking I/O before reading its first request byte.
        stream
            .set_nonblocking(false)
            .map_err(|e| format!("configure accepted control socket: {e}"))?;
        let expected_uid = unsafe { libc::geteuid() };
        let response = match peer_uid(&stream) {
            Ok(uid) if peer_is_authorized(uid, expected_uid) => match read_request(&mut stream) {
                Ok(request) => match dispatch(db, request) {
                    Ok(result) => ControlResponse {
                        ok: true,
                        result: Some(result),
                        error: None,
                    },
                    Err(error) => ControlResponse {
                        ok: false,
                        result: None,
                        error: Some(error),
                    },
                },
                Err(error) => ControlResponse {
                    ok: false,
                    result: None,
                    error: Some(error),
                },
            },
            Ok(_) => ControlResponse {
                ok: false,
                result: None,
                error: Some("control socket peer UID mismatch".into()),
            },
            Err(error) => ControlResponse {
                ok: false,
                result: None,
                error: Some(error),
            },
        };
        write_response(&mut stream, response)?;
        Ok(true)
    }
}

impl Drop for NativeControlServer {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.path);
    }
}

pub fn request(db: &Path, request: &ControlRequest) -> Result<Value, String> {
    let path = socket_path(db)?;
    let mut stream = UnixStream::connect(path)
        .map_err(|e| format!("native daemon control socket unavailable: {e}"))?;
    stream
        .set_write_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    stream
        .set_read_timeout(Some(IO_TIMEOUT))
        .map_err(|e| e.to_string())?;
    let mut data = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    if data.len() > MAX_REQUEST {
        return Err("control request exceeds 64 KiB".into());
    }
    data.push(b'\n');
    stream
        .write_all(&data)
        .map_err(|e| format!("control request write failed: {e}"))?;
    let mut response = Vec::new();
    stream
        .take((MAX_REQUEST + 1) as u64)
        .read_to_end(&mut response)
        .map_err(|e| format!("control response read failed: {e}"))?;
    if response.len() > MAX_REQUEST {
        return Err("control response exceeds 64 KiB".into());
    }
    let response: ControlResponse =
        serde_json::from_slice(&response).map_err(|e| format!("invalid control response: {e}"))?;
    if !response.ok {
        return Err(response
            .error
            .unwrap_or_else(|| "daemon rejected control request".into()));
    }
    response
        .result
        .ok_or_else(|| "daemon returned no mutation readback".into())
}

#[cfg(test)]
mod tests {
    use super::peer_is_authorized;

    #[test]
    fn control_socket_authorizes_only_the_daemon_uid() {
        assert!(peer_is_authorized(501, 501));
        assert!(!peer_is_authorized(502, 501));
    }
}
