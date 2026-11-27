// Node provenance: src/types.ts. Native Rust wire contracts preserve the
// original camelCase SQLite/Events JSON. Canonical Mermaid Graphs own every
// state transition; these declarations add no alternative lifecycle policy.
use crate::workflow::definitions_v2::{
    assert_v2_state_transition,job_lifecycle_v2,task_lifecycle_v2,
};
use chrono::DateTime;
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use std::{collections::HashMap,path::Path};

#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="SCREAMING_SNAKE_CASE")]
pub enum JobLifecycleState{Draft,Active,Completed,Cancelled}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="SCREAMING_SNAKE_CASE")]
pub enum TaskState{Draft,Queued,Running,AwaitingDecision,Blocked,Succeeded,Failed,Cancelled}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="SCREAMING_SNAKE_CASE")]
pub enum JobRuntimeStatus{Idle,Waiting,Queued,Running,Blocked,Failed,Reviewing,MergePending,Merged,Completed,Cancelled}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
pub enum Priority{P0,P1,P2,P3}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
pub enum StorySize{S,M,L}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum WorkerAdapterName{Codex,Chatgpt,Z,Script}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum AdapterName{Codex,Chatgpt,Z,Script,Orchestrator}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum TaskKind{Work,Planner}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum BlockerResolutionMode{Merge,Verified}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct JobTag {
    pub description:String,
    pub values:HashMap<String,String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ResultRecord {
    pub summary:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub artifacts:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub data:Option<HashMap<String,Value>>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct BlockerReference {
    pub repository:String,
    pub pr_number:i64,
    pub job_id:String,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskBlockerReference {
    pub repository:String,
    pub pr_number:i64,
    pub job_id:String,
    pub blocked_attempt:u64,
    pub registered_at:String,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct BlockedBaseline{
    pub blocked_at:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub head_sha:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub reason:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskUnblockRecord {
    pub event:String,
    pub at:String,
    pub source:String,
    pub reason:String,
    pub baseline:BlockedBaseline,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub current_head_sha:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub facts:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub blocker_job_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub resolution:Option<BlockerResolutionMode>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskResolution {
    pub path:String,
    pub state:String,
    pub owner:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub target_task_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub target_job_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub mode:Option<BlockerResolutionMode>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub root_cause:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub solution:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub deviations:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub validation_evidence:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub recovery_execution_id:Option<String>,
    pub updated_at:String,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct TaskEscalation {
    pub id:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub fingerprint:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub original_task_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub original_plan_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub original_execution_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub recovery_execution_id:Option<String>,
    pub required_action:String,
    pub resolution_condition:String,
    pub context:String,
    pub status:String,
    pub requested_at:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub responded_at:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub response:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub notification:Option<Value>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct PlanTrigger {
    pub source:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub review_task_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub task_ids:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub reason:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub facts:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub blocked_head_shas:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub current_head_sha:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub unblock_source:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Plan {
    pub job_id:String,
    pub id:String,
    pub round:u64,
    pub source:String,
    pub previous_plan_id:Option<String>,
    pub trigger:PlanTrigger,
    pub status:String,
    pub assessment:String,
    pub generated_task_ids:Vec<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub guidance:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub force_restate:Option<bool>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub restate_task_ids:Option<Vec<String>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub objective_status:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub planner_result:Option<Value>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub assessment_extra:Option<Value>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub pending_unblocks:Option<Vec<Value>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub head_sha:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub error:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub attempt:Option<u64>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub max_attempts:Option<u64>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub execution_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub applied_execution_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub paused_execution_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub retry_feedback:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub timeout_ms:Option<u64>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub manual_planning:Option<bool>,
    pub created_at:String,
    pub updated_at:String,
    #[serde(flatten)]
    pub extra:HashMap<String,Value>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct BlockerDependent {
    pub repository:String,
    pub pr_number:i64,
    pub job_id:String,
    pub task_id:String,
    pub blocked_attempt:u64,
    pub registered_at:String,
    pub state:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub resolved_at:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub resolution:Option<BlockerResolutionMode>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub note:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct BlockerRecoveryRequest {
    pub request_id:String,
    pub intent_fingerprint:String,
    pub reason:String,
    pub status:String,
    pub target_repository:String,
    pub dependent_repository:String,
    pub dependent_job_id:String,
    pub dependent_task_id:String,
    pub blocked_attempt:Option<u64>,
    pub title:String,
    pub objective:String,
    pub resolution_mode:BlockerResolutionMode,
    pub origin:String,
    pub authorized:bool,
    pub created_at:String,
    pub updated_at:String,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct BlockerRecoveryReceipt {
    pub request_id:String,
    pub reason:String,
    pub status:String,
    pub blocker_job_id:String,
    pub blocker_repository:String,
    pub dependent_repository:String,
    pub dependent_job_id:String,
    pub dependent_task_id:String,
    pub resolution_mode:BlockerResolutionMode,
    pub outcome:String,
    pub planning_recovery_required:bool,
    pub created_at:String,
    pub updated_at:String,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(tag="kind",rename_all="snake_case")]
pub enum TaskOutput {
    TaskPr,
    File{path:String},
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct WorkerRequirements {
    pub capabilities:Vec<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub runtime:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub task_kind:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub trust_domain:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub region:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub labels:Option<HashMap<String,String>>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct RoutingDecision {
    pub provider:String,
    pub model:String,
    pub decided_by:String,
    pub decided_at:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub profile:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub reasoning:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub cwd:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub project_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub decision_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub decision_evidence:Option<Value>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct WorkerSelection {
    pub worker_id:String,
    pub adapter:WorkerAdapterName,
    pub capabilities:Vec<String>,
    pub selected_by:String,
    pub selected_at:String,
    #[serde(flatten)]
    pub resource:HashMap<String,Value>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Task {
    pub id:String,
    pub parent_task_id:Option<String>,
    pub dependencies:Vec<String>,
    pub capabilities:Vec<String>,
    pub adapter:AdapterName,
    pub input:String,
    pub state:TaskState,
    pub attempt:u64,
    pub max_attempts:u64,
    pub execution_id:Option<String>,
    pub thread_id:Option<String>,
    pub result:Option<ResultRecord>,
    pub error:Option<String>,
    pub timeout_ms:u64,
    pub created_at:String,
    pub updated_at:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub job_id:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub title:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub kind:Option<TaskKind>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub priority:Option<Priority>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub story_size:Option<StorySize>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub project_name:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub agent_name:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub agent_graph:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub output:Option<TaskOutput>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub worker_requirements:Option<WorkerRequirements>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub worker_selection:Option<WorkerSelection>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub routing:Option<RoutingDecision>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub escalation:Option<TaskEscalation>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub resolution:Option<TaskResolution>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub blocked_by:Option<TaskBlockerReference>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub blocked_baseline:Option<BlockedBaseline>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub unblock:Option<TaskUnblockRecord>,
    #[serde(flatten)]
    pub extra:HashMap<String,Value>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Continuation {
    pub kind:String,
    pub target:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub input:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ReviewState {
    pub outcome:String,
    pub head_sha:String,
    pub task_id:Option<String>,
    pub evidence:Option<ResultRecord>,
    pub updated_at:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub revision_disposition:Option<String>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Job {
    pub id:String,
    pub title:String,
    pub project_root:String,
    pub repository:String,
    pub state:JobLifecycleState,
    pub continuation:Option<Continuation>,
    pub created_at:String,
    pub updated_at:String,
    pub tasks:Vec<Task>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub objective:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub description:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub tag:Option<JobTag>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub priority:Option<Priority>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub auto_merge:Option<bool>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub review_enabled:Option<bool>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub interactive_review_enabled:Option<bool>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub plans:Option<Vec<Plan>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub review:Option<ReviewState>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub local_merge:Option<Value>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub remote_delivery:Option<Value>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub head_sha:Option<String>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub pause:Option<Value>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub unblocks:Option<Vec<BlockerDependent>>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub blocker_recovery_request:Option<BlockerRecoveryRequest>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub blocker_resolution_mode:Option<BlockerResolutionMode>,
    #[serde(flatten)]
    pub extra:HashMap<String,Value>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct EventRecord {
    pub version:u8,
    pub event_id:String,
    pub job_id:String,
    pub task_id:String,
    pub parent_task_id:Option<String>,
    #[serde(rename="type")]
    pub kind:String,
    pub status:String,
    pub timestamp:String,
    pub visibility:String,
    pub level:String,
    pub message:String,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub source:Option<Value>,
    #[serde(default,skip_serializing_if="Option::is_none")]
    pub data:Option<Value>,
}
pub fn story_size_timeout_ms(size:StorySize)->u64{
    match size{StorySize::S=>300_000,StorySize::M=>900_000,StorySize::L=>2_700_000}
}
pub fn task_overall_timeout_ms(size:StorySize,reasoning:Option<&str>)->u64{
    story_size_timeout_ms(size)*if reasoning.is_some_and(|s|s.eq_ignore_ascii_case("high")){2}else{1}
}
pub fn chatgpt_start_ack_timeout_ms(overall_timeout_ms:u64)->u64{
    600_000.min(120_000.max(overall_timeout_ms/3))
}
fn js_truthy(value:&Value)->bool{
    match value{
        Value::Null=>false,
        Value::Bool(v)=>*v,
        Value::Number(n)=>n.as_f64().is_some_and(|n|n!=0.0),
        Value::String(s)=>!s.is_empty(),
        Value::Array(_)|Value::Object(_)=>true,
    }
}
pub fn normalize_legacy_task_lifecycle(task:&mut Value){
    let state=task.get("state").and_then(Value::as_str).unwrap_or("").to_string();
    if state=="UNBLOCKED"{
        let agent=task.get("agentName").and_then(Value::as_str).unwrap_or("");
        task["state"]=json!(if agent=="troubleshooter"{"QUEUED"}else{"FAILED"});
        if task.get("failureReason").is_none_or(Value::is_null){
            task["failureReason"]=json!("legacy_unblocked_task_requires_recovery");
        }
        // Node: Math.max(3, task.maxAttempts ?? 0, task.attempt + 1). A missing
        // attempt poisons the maximum to NaN, which JSON serializes as null;
        // a null attempt coerces to 0 before the +1.
        let max=task.get("maxAttempts").and_then(Value::as_f64).unwrap_or(0.0);
        task["maxAttempts"]=match task.get("attempt"){
            None=>Value::Null,
            Some(Value::Null)=>json!(3.0f64.max(max).max(1.0)),
            Some(value)=>match value.as_f64(){
                Some(attempt)=>json!(3.0f64.max(max).max(attempt+1.0)),
                None=>json!(3.0f64.max(max).max(1.0)),
            },
        };
        if task.get("unblock").is_some_and(js_truthy){
            task["unblock"]["event"]=json!("task.unblocked");
        }else if let Some(object)=task.as_object_mut(){
            // Node assigns undefined, which JSON serialization omits entirely.
            object.remove("unblock");
        }
    }
    let state=task.get("state").and_then(Value::as_str).unwrap_or("").to_string();
    if state=="DRAFT"
        && task.get("attempt").and_then(Value::as_f64)
            .is_some_and(|attempt|attempt>0.0)
        && task.get("executionId").map(|v|!js_truthy(v)).unwrap_or(true)
        && task.get("unblock").map(|v|!js_truthy(v)).unwrap_or(true)
        && task.get("interactiveInvocation").is_some_and(js_truthy)
        && task.pointer("/interactiveInvocation/boundAt").is_some_and(js_truthy){
        let invocation=&task["interactiveInvocation"];
        let waiting=invocation.get("status").and_then(Value::as_str)==Some("awaiting_decision");
        let decided=invocation.get("decidedAt").and_then(Value::as_str)
            .and_then(|date|DateTime::parse_from_rfc3339(date).ok());
        let updated=task.get("updatedAt").and_then(Value::as_str)
            .and_then(|date|DateTime::parse_from_rfc3339(date).ok());
        if waiting || decided.is_some_and(|decided|updated.is_some_and(|at|at<=decided)){
            task["state"]=json!("AWAITING_DECISION");
        }
    }
    let state=task.get("state").and_then(Value::as_str).unwrap_or("").to_string();
    if state=="BLOCKED"
        && task.get("kind").and_then(Value::as_str)!=Some("planner")
        && task.get("agentName").and_then(Value::as_str)!=Some("troubleshooter"){
        task["state"]=json!("FAILED");
        if task.get("failureReason").is_none_or(Value::is_null){
            task["failureReason"]=json!("legacy_ordinary_blocked");
        }
        if task.get("error").is_none_or(Value::is_null){
            task["error"]=json!("Legacy ordinary Task was BLOCKED; preserved as FAILED pending Troubleshooter diagnosis.");
        }
    }
}
pub fn assert_job_lifecycle_transition(
    directory:&Path,from:&str,to:&str,
)->Result<(),String>{
    let runtime=job_lifecycle_v2(directory)?;
    assert_v2_state_transition(&runtime.graph,from,to,"job")
}
pub fn assert_task_transition(
    directory:&Path,from:&str,to:&str,
)->Result<(),String>{
    let runtime=task_lifecycle_v2(directory)?;
    assert_v2_state_transition(&runtime.graph,from,to,"task")
}
