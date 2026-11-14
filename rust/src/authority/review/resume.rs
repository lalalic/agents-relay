//! Resume a durable, accepted Review on its original Task. Task Graph owns
//! the transition; adapter routing remains a concrete action.
use super::*;

/// Continue an already accepted Review on the SAME Task. This is a
/// Graph-authorized `interactive.resume` mutation; it neither generates a
/// second revision Task nor treats host delivery as worker completion.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewResume {
    pub task_id: String,
    pub status: String,
    pub state: String,
    pub adapter: String,
}

impl RelayAuthority {
    pub fn resume_review_task(
        &mut self,
        job_id: &str,
        task_id: &str,
        at: &str,
    ) -> Result<ReviewResume, String> {
        let mut finished = None;
        self.commit_job_with_tx(job_id,at,|tx,current| {
            if current.get("state").and_then(Value::as_str)!=Some("ACTIVE")
                ||current.get("pause").is_some_and(|v|!v.is_null()) {
                return Err("cannot resume a paused or terminal Job".into());
            }
            let mut job=current.clone();
            let task=job.get_mut("tasks").and_then(Value::as_array_mut)
                .and_then(|tasks|tasks.iter_mut().find(|t|t.get("id").and_then(Value::as_str)==Some(task_id)))
                .ok_or("Review Task missing")?;
            if task.get("state").and_then(Value::as_str)!=Some("AWAITING_DECISION")
                ||task.get("executionId").is_some_and(|id|!id.is_null()) {
                return Err("Review Task must be awaiting a decision without a live execution".into());
            }
            let invocation=task.get("interactiveInvocation").ok_or("missing Review invocation")?;
            let status=invocation.get("status").and_then(Value::as_str)
                .filter(|status|matches!(*status,"approved"|"changes_requested"))
                .ok_or("Review has no accepted decision")?.to_owned();
            let invocation_id=invocation.get("invocationId").and_then(Value::as_str).ok_or("Review invocation ID missing")?;
            let execution_id=invocation.get("executionId").and_then(Value::as_str).ok_or("Review execution ID missing")?;
            let revision=invocation.get("revision").and_then(Value::as_str).ok_or("Review revision missing")?;
            let ledger:Option<(String,String,String)>=tx.query_row(
                "SELECT execution_id,revision,decision FROM host_invocation_decision WHERE job_id=?1 AND task_id=?2 AND invocation_id=?3",
                params![job_id,task_id,invocation_id],|row|Ok((row.get(0)?,row.get(1)?,row.get(2)?))
            ).optional().map_err(|e|e.to_string())?;
            if !ledger.is_some_and(|(exec,rev,dec)|exec==execution_id&&rev==revision&&dec==status) {
                return Err("Review decision not confirmed in durable host ledger".into());
            }
            let decision=Graph::parse(include_str!("../../../../workflow/task-lifecycle.mmd"))?
                .decide("AWAITING_DECISION",GraphInput{
                    transport:"event".into(),id:"interactive.resume".into(),payload:json!({})
                },&HashMap::new())?;
            let Decision::Accepted{target,actions,..}=decision else {return Err("Task Graph denied Review resume".into());};
            if target!="QUEUED" {return Err("Task Graph did not requeue Review Task".into());}
            crate::lifecycle::apply_pure_task_actions(task,&actions)?;
            // Mirror applyTaskUnblockRetrySnapshot: an accepted Review
            // starts a fresh attempt generation on the same Task.
            if task.get("kind").and_then(Value::as_str)==Some("planner") {
                return Err("Planner cannot resume as an ordinary Task".into());
            }
            task["attempt"]=json!(0);
            let budget=task.get("maxAttempts").and_then(Value::as_i64).unwrap_or(0);
            task["maxAttempts"]=json!(budget.max(3));
            task["leaseOwner"]=Value::Null;
            task["leaseExpiresAt"]=Value::Null;
            task["executionId"]=Value::Null;
            task["error"]=Value::Null;
            if let Some(fields)=task.as_object_mut(){
                fields.shift_remove("blockedBy");
                fields.shift_remove("failureReason");
            }
            if status=="changes_requested" {
                let saved=task.get("interactiveInvocation").ok_or("invocation lost")?;
                let feedback=saved.get("feedback").and_then(Value::as_str).unwrap_or("").trim();
                let feedback=if feedback.is_empty(){"Changes requested"}else{feedback};
                let preview=feedback.chars().take(1000).collect::<String>();
                let rev=saved.get("revision").and_then(Value::as_str).ok_or("revision missing")?;
                let message=format!("Interactive review changes requested for revision {rev}: {preview}");
                let comment=json!({
                    "id":uuid::Uuid::new_v4().to_string(),
                    "text":message,"author":"cli","createdAt":at,
                    "jobId":job_id,"taskId":task_id,
                });
                let mut comments=task.get("comments").and_then(Value::as_array).cloned().unwrap_or_default();
                comments.push(comment);
                task["comments"]=Value::Array(comments);
            }

            if task.get("dagNode").and_then(|node|node.get("executor")).and_then(Value::as_str)==Some("script") {
                let revision=task.get("interactiveInvocation").ok_or("Review invocation missing")?.clone();
                let script=status!="changes_requested";
                task["adapter"]=json!(if script{"script"}else{"codex"});
                task["capabilities"]=json!([if script{"script"}else{"model"}]);
                if let Some(fields)=task.as_object_mut(){
                    fields.shift_remove("routing");
                    fields.shift_remove("workerSelection");
                    if script {fields.shift_remove("workerRequirements");}
                }
                if !script {
                    task["workerRequirements"]=json!({"capabilities":["model"]});
                    let input=task["input"].as_str().ok_or("DAG input not string")?;
                    let mut parsed:Value=serde_json::from_str(input).map_err(|_|"DAG input not structured JSON")?;
                    if !parsed.is_object(){return Err("DAG input must be JSON object".into());}
                    parsed["reviewRevision"]=json!({
                        "status":"changes_requested",
                        "feedback":revision.get("feedback").and_then(Value::as_str).unwrap_or(""),
                        "comments":revision.get("comments").cloned().unwrap_or(json!([])),
                        "instruction":"Revise the current Stage Artifact from the human feedback. Verify it, then use agents-relay review interactive --path to submit a NEW review for this same Task Execution. Do not publish or emit task.completed until the new review is approved."
                    });
                    task["input"]=Value::String(serde_json::to_string(&parsed).map_err(|e|e.to_string())?);
                }
            }
            task["state"]=json!(target);
            task["updatedAt"]=json!(at);
            let adapter=task.get("adapter").and_then(Value::as_str).ok_or("Task adapter missing")?.to_owned();
            job["updatedAt"]=json!(at);
            finished=Some(ReviewResume{task_id:task_id.into(),status,state:target,adapter});
            Ok((job,vec![]))
        })?;
        finished.ok_or("Review resume did not commit".into())
    }
}
