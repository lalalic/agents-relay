// Node provenance: src/worker-failure-recovery.ts. Classify owned
// execution failures; the canonical Task Graph alone decides retry or terminal.
use crate::{
    chatgpt_platform_fallback::persist_chatgpt_platform_failure,
    events::event_for,
    final_review_role::is_final_review_agent,
    worker_rejection::classify_chat_gpt_platform_failure,
};
use regex::Regex;
use serde_json::{json,Value};
use std::collections::HashMap;
use std::time::{Duration,Instant};

fn field<'a>(v:&'a Value,key:&str)->&'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
#[derive(Default)]
pub struct FailureClaims {
    claimed:HashMap<String,Instant>,
}
impl FailureClaims {
    pub fn claim(&mut self,id:&str,now:Instant)->bool {
        self.claimed.retain(|_,at|now.duration_since(*at)<Duration::from_secs(60));
        if self.claimed.contains_key(id) {return false;}
        self.claimed.insert(id.to_string(),now);
        true
    }
}
#[derive(Debug,Clone)]
pub struct FailureAdmission {
    pub event:String,
    pub facts:Value,
    pub platform_failure:Option<Value>,
    pub failure_reason:Option<String>,
    pub unknown_outcome:bool,
    pub phase:String,
    pub message:String,
    pub expected_execution_id:Option<String>,
}
/// `codex_no_start_route` is a *verified* routing result from the configured
/// Codex default provider, never a model catalog guess.
pub fn classify_worker_launch_failure(
    task:Option<&Value>,error:&Value,phase:&str,execution_id:Option<&str>,
    active_execution_id:Option<&str>,active_worker_started:bool,
    safe_alternative:bool,codex_no_start_route:bool,
)->FailureAdmission {
    let message=error.as_str().map(str::to_owned)
        .or_else(||error.get("message").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_else(||error.to_string());
    let browser=task.is_some_and(|task|matches!(field(task,"adapter"),"chatgpt"|"z"));
    let started=task.is_some_and(|task|{
        field(task,"state")=="QUEUED"
            && task.get("executionId").and_then(Value::as_str)==execution_id
            && task.get("lastProgressEventAt").is_none_or(Value::is_null)
            && !active_worker_started
    });
    let can_no_start=started && browser && task.is_some_and(|task|
        !is_final_review_agent(task.get("agentName").and_then(Value::as_str))
            && field(task,"agentName")!="troubleshooter"
            && field(task,"kind")!="planner"
            && task.get("noStartFallback").is_none_or(Value::is_null)
            && task.get("attempt").and_then(Value::as_i64).unwrap_or(0)
                <task.get("maxAttempts").and_then(Value::as_i64).unwrap_or(0));
    let no_start_allowed=can_no_start && codex_no_start_route;
    let normalized_phase=if matches!(phase,"process"|"terminal"){"delivery"}else{phase};
    let codex_failure=task.filter(|task|field(task,"adapter")=="codex")
        .and_then(|task|crate::native_codex_thread::recovery_classification(&message,field(task,"threadId")));
    let codex_can_retry=codex_failure.is_none() || task.is_some_and(
        |task| crate::native_codex_thread::provider_recovery_available(task)
            && task["routing"]["decidedBy"]!="cli");
    let platform_failure=if browser {Some(classify_chat_gpt_platform_failure(error,normalized_phase))}
        else {codex_failure.map(|classification|json!({"classification":classification,
            "safeToReroute":true,"evidence":message}))};
    let classification=platform_failure.as_ref().map(|value|field(value,"classification")).unwrap_or("");
    let unknown=phase=="start-ack"
        || matches!(classification,"outcome_unknown"|"start_ack_timeout")
        || (phase=="launch" && active_execution_id==execution_id && active_execution_id.is_some())
        || (phase=="delivery" && active_execution_id==execution_id
            && active_execution_id.is_some() && active_worker_started);
    let unknown=unknown && codex_failure.is_none();
    let browser_failure=Regex::new(
        r"(?i)WEBHELM_UNAVAILABLE|webhelm runtime dependency unavailable|webhelm session start returned no session_id|no close frame received or sent"
    ).expect("static failure regex").is_match(&message);
    let failure_reason=if phase=="start-ack"{Some("worker_start_timeout".into())}
        else if browser_failure{Some("browser_workspace_unavailable".into())}else{None};
    let event=if no_start_allowed {"worker.no_start_failed"}
        else if platform_failure.is_some(){"worker.platform_failure"}
        else if phase=="start-ack"{"worker.start_ack_failed"}
        else {"worker.delivery_failed"};
    let facts=json!({
        "platformFallbackSafe":platform_failure.as_ref().is_some_and(|p|
            p.get("safeToReroute")==Some(&Value::Bool(true))) && safe_alternative && codex_can_retry,
        "noStartFallbackAllowed":no_start_allowed && task.is_some_and(|t|
            t.get("noStartFallback").is_none_or(Value::is_null))
    });
    FailureAdmission{event:event.into(),facts,platform_failure,failure_reason,
        unknown_outcome:unknown,phase:phase.into(),message,
        expected_execution_id:execution_id.map(str::to_owned)}
}
pub fn apply_launch_failure_mutation(
    updated:&mut Value, original:Option<&Value>,
    proposal:&FailureAdmission,decision:&Value,
) {
    let status=field(decision,"target");
    if let Some(ref platform)=proposal.platform_failure {
        if proposal.event!="worker.no_start_failed" {
            if original.is_some_and(|v|field(v,"adapter")=="codex"){
                if let Some(prior)=original{
                    let route=&prior["routing"];
                    let failure=crate::native_codex_thread::exclude_route(updated,route,
                        field(platform,"classification"));
                    if status=="QUEUED" {
                        crate::native_codex_thread::mark_provider_recovery(updated);
                    }
                    updated["platformFailure"]=json!({"classification":platform.get("classification"),
                        "executionId":proposal.expected_execution_id,
                        "route":failure,"evidence":platform.get("evidence"),
                        "safeToReroute":true});
                }
            }else{
                persist_chatgpt_platform_failure(updated,original,
                    proposal.expected_execution_id.as_deref(),
                    field(platform,"classification"),field(platform,"evidence"),
                    platform.get("safeToReroute")==Some(&Value::Bool(true)));
            }
        }
    }
    if proposal.event=="worker.no_start_failed"
        && updated.get("noStartFallback").is_some_and(|v|!v.is_null()) {
        updated["noStartFallback"]["reason"]=json!(proposal.message);
    }
    updated["error"]=if status=="QUEUED" {Value::Null}
        else {json!(format!("Worker {} failed: {}",proposal.phase,proposal.message))};
    if status=="QUEUED"{
        if let Some(map)=updated.as_object_mut(){map.remove("failureReason");}
    }else{
        let reason=if proposal.unknown_outcome{"worker_outcome_unknown"}
            else if proposal.platform_failure.is_some(){"worker_platform_failure"}
            else{proposal.failure_reason.as_deref().unwrap_or("")};
        if !reason.is_empty(){updated["failureReason"]=json!(reason);}
        else if let Some(map)=updated.as_object_mut(){map.remove("failureReason");}
    }
    // Releasing a finished execution generation also releases its owned
    // durable lease. A future dispatch must claim a new process identity.
    updated["executionId"]=Value::Null;
    updated["leaseOwner"]=Value::Null;
    updated["leaseExpiresAt"]=Value::Null;
}
pub fn launch_failure_event(
    job_id:&str,task_id:&str,parent_task_id:Option<&str>,
    proposal:&FailureAdmission,transition:&Value,
)->Value {
    let accepted=transition.pointer("/decision/accepted")==Some(&Value::Bool(true));
    if !accepted {
        return event_for(job_id,task_id,parent_task_id,
            "task.process.delivery_failed","failed",
            &format!("Worker {} reported after lifecycle moved to {}: {}",
                proposal.phase,field(transition,"from"),proposal.message),
            Some("orchestrator"),
            Some(json!({"phase":proposal.phase,"authoritative":false,
                "executionId":proposal.expected_execution_id,"workflowEvent":proposal.event})),
            Some(json!({"agent":"relay","component":"agents-relay"})));
    }
    let task=&transition["task"];
    let queued=field(task,"state")=="QUEUED";
    let kind=if queued && proposal.event=="worker.no_start_failed"{
        "worker.no_start_fallback"
    }else if queued{"worker.pre_submission_rejected"}else{"task.failed"};
    let reason=task.get("failureReason").filter(|v|!v.is_null()).cloned()
        .or_else(||proposal.failure_reason.as_ref().map(|s|json!(s)));
    // Node leaves optional `reason` undefined when no failure reason was
    // classified; JSON events omit it rather than serializing `null`.
    let mut data=json!({"phase":proposal.phase,"workflowEvent":proposal.event});
    if let Some(reason)=reason{data["reason"]=reason;}
    if task.get("noStartFallback").is_some_and(|v|!v.is_null()){
        data["noStartFallback"]=task["noStartFallback"].clone();
    }
    if task.get("platformFailure").is_some_and(|v|!v.is_null()){
        data["platformFailure"]=task["platformFailure"].clone();
    }
    let fallback=format!("Worker {} failed: {}",proposal.phase,proposal.message);
    event_for(job_id,task_id,parent_task_id,kind,
        if queued{"queued"}else{"failed"},
        task.get("error").and_then(Value::as_str).unwrap_or(&fallback),
        Some("user"),Some(data),
        Some(json!({"agent":"relay","component":"agents-relay","watchdog":true})))
}

/// Public Node handleWorkerLaunchFailure: ordered, execution-fenced
/// orchestration through one injected Graph/SQLite authoritative runtime.
pub fn handle_worker_launch_failure<P:crate::worker_failure_orchestration::WorkerFailurePorts>(
    ports:&mut P,job_id:&str,task_id:&str,execution_id:Option<&str>,
    failure:&Value,phase:&str,
)->Result<(),String>{
    crate::worker_failure_orchestration::handle_worker_launch_failure_impl(
        ports,job_id,task_id,execution_id,failure,phase)
}
