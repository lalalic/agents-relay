// Head-to-head Phase1 port: src/reconciler-review.ts
// Review Graph owns the immutable pre-merge Final Review gate. This module
// computes snapshot mutations and events; the Reconciler Runtime commits
// changes in the SAME SQLite mutateJob transaction with generation fences.
use crate::{
    events::event_for,
    execution_routing::{
        discover_execution_routes,route_execution_with_choice,route_execution_decide,
    },
    final_review_role::{is_final_review_agent,FINAL_REVIEW_AGENT},
    job_task_id_sequence::allocate_entity_id,
    local_merge_lock::iso8601_now,
    review_evidence::normalize_review_evidence,
    review_generation_fence::review_generation_matches,
    review_replan::{review_plan_ready_with_head,review_work_settled},
    review_revision_model::{
        targeted_requests_for_review,targeted_requests_cover_review,
    },
    review_revision_policy::review_finding_fingerprint,
    review_revision_stale::stale_review_revisions,
    review_revision_settlement::settle_review_revision_round,
    task_transitions::{
        refresh_task_dependencies,try_transition_task_event,
    },
    types::story_size_timeout_ms,
    worker_routing::worker_candidates,
    workflow::{
        entity_creation::create_task_entity,
        review_v2::{decide_review_lifecycle,review_outcome},
    },
};
use chrono::Utc;
use serde_json::{json,Value};
use std::{collections::HashSet,path::Path};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job:&Value)->&[Value]{
    job.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn candidate_task<'a>(job:&'a Value,id:&str)->Option<&'a Value>{
    tasks(job).iter().find(|t|field(t,"id")==id)
}
fn review_task(task:&Value)->bool {
    is_final_review_agent(task.get("agentName").and_then(Value::as_str))
}
/// Resolve optional effective Agent hints read-only, before choosing a route.
/// They rank existing eligible choices; they never pin or widen them.
pub fn agent_model_preference_for_job(
    job:&Value,agent:&str,options:&Value,
)->Option<Value>{
    let project=job.get("projectRoot").and_then(Value::as_str)?;
    crate::execution_context::optional_agent_model_preference(
        project,agent,
        options.get("workspaceRoot").and_then(Value::as_str),
        options.get("globalRoot").and_then(Value::as_str),None)
}
fn graph_actions(decision:&Value,action:&str)->bool {
    decision.get("accepted")==Some(&Value::Bool(true))
        &&decision.get("actions").and_then(Value::as_array)
            .is_some_and(|actions|actions.iter()
                .any(|item|field(item,"id")==action))
}
#[derive(Clone,Debug)]
pub struct ReviewSnapshot {
    pub job:Value,
    pub events:Vec<Value>,
    pub cancel_execution_ids:Vec<String>,
    pub wake:bool,
    pub decision_audit:Option<Value>,
}
impl ReviewSnapshot{
    pub fn unchanged(job:&Value)->Self{
        Self{job:job.clone(),events:Vec::new(),
            cancel_execution_ids:Vec::new(),wake:false,decision_audit:None}
    }
}
pub fn review_head(job:&Value,verified_local_sha:Option<&str>)->Option<String>{
    verified_local_sha.filter(|s|!s.is_empty()).map(str::to_owned)
        .or_else(||job.get("headSha").and_then(Value::as_str).map(str::to_owned))
        .or_else(||job.pointer("/review/headSha").and_then(Value::as_str)
            .map(str::to_owned))
}
pub fn review_facts(directory:&Path,job:&Value,head:Option<&str>)
    ->Result<Value,String>{
    let review_tasks=tasks(job).iter().filter(|task|
        review_task(task)&&task.get("reviewHeadSha")
            .and_then(Value::as_str)==head).collect::<Vec<_>>();
    let current=job.pointer("/review/taskId").and_then(Value::as_str)
        .and_then(|id|candidate_task(job,id));
    Ok(json!({
        "reviewEnabled":job.get("reviewEnabled")!=Some(&Value::Bool(false)),
        "jobActive":field(job,"state")=="ACTIVE",
        "reviewWorkSettled":review_work_settled(directory,job)?,
        "headAvailable":head.is_some_and(|h|!h.is_empty()),
        "reviewPlanReady":review_plan_ready_with_head(job, head),
        "noActiveReviewTask":!review_tasks.iter().any(|task|
            matches!(field(task,"state"),"DRAFT"|"QUEUED"|"RUNNING")),
        "currentReviewCancelled":current.is_some_and(|task|
            task.get("reviewHeadSha").and_then(Value::as_str)==head
                &&field(task,"state")=="CANCELLED"),
        "noApprovedCurrentReview":!review_tasks.iter().any(|task|
            field(task,"state")=="SUCCEEDED"
            &&job.pointer("/review/headSha").and_then(Value::as_str)==head
            &&job.pointer("/review/outcome").and_then(Value::as_str)==Some("approved")),
    }))
}
pub fn invalidate_stale_review(
    directory:&Path,job:&Value,head:Option<&str>,
)->Result<ReviewSnapshot,String>{
    let mut result=ReviewSnapshot::unchanged(job);
    let review=job.get("review").filter(|v|!v.is_null());
    let Some(review)=review else{return Ok(result);};
    if head.is_none()||review.get("headSha").and_then(Value::as_str)==head{
        return Ok(result);
    }
    let decision=decide_review_lifecycle(directory,
        review.get("outcome").and_then(Value::as_str),
        "head.changed",&json!({}))?;
    if !graph_actions(&decision,"review.cancelStale"){return Ok(result);}
    let review_id=field(review,"taskId").to_owned();
    let old_head=field(review,"headSha").to_owned();
    if let Some(index)=tasks(&result.job).iter()
        .position(|t|field(t,"id")==review_id){
        if matches!(field(&result.job["tasks"][index],"state"),
            "DRAFT"|"QUEUED"|"RUNNING"){
            let task=&mut result.job["tasks"][index];
            if let Some(execution)=task.get("executionId")
                .and_then(Value::as_str){
                result.cancel_execution_ids.push(execution.into());
            }
            try_transition_task_event(directory,task,"cancel",&json!({}),
                &iso8601_now())?;
            task["error"]=json!("Review evidence became stale after the PR head changed");
        }
    }
    let cancelled=stale_review_revisions(directory,&mut result.job,
        &review_id,&old_head,None)?;
    for revision in cancelled{
        if let Some(id)=revision.get("executionId").and_then(Value::as_str){
            result.cancel_execution_ids.push(id.into());
        }
    }
    let next=review_outcome(field(&decision,"target"))?
        .ok_or("Review Graph returned no stale verdict")?;
    if result.job.pointer("/review/taskId")==review.get("taskId")
        &&result.job.pointer("/review/headSha")==review.get("headSha"){
        let now=iso8601_now();
        result.job["review"]["outcome"]=json!(next);
        result.job["review"]["updatedAt"]=json!(now);
        result.job["updatedAt"]=json!(now);
    }
    Ok(result)
}
fn final_review_input(job:&Value,head:&str)->String{
    [
        format!("Job ID: {}",field(job,"id")),
        format!("Review the local Git Job artifact at exactly head SHA {head}."),
        format!("Review head SHA: {head}"),
        format!("Job objective: {}",job.get("objective").and_then(Value::as_str)
            .or_else(||job.get("description").and_then(Value::as_str))
            .unwrap_or_else(||field(job,"title"))),
        "Review the complete local Git diff at this exact immutable head SHA, not only the dependency Tasks.".into(),
        "Use the selected reviewer agent contract as the authoritative review protocol.".into(),
        "This is a PRE-MERGE artifact approval gate: inspect the exact local Git head, requirements, tests and genuine blocking defects.".into(),
        "Do not block approval because automatic merge, Job COMPLETED, or post-merge validation has not occurred yet.".into(),
        "All non-review Tasks have terminal outcomes. Examine FAILED and CANCELLED Tasks and their recovery evidence; never approve an unresolved required outcome.".into(),
        "The Final Review is the Job completion check. Persist concrete, owner-attributed findings with a changes-required verdict. A Job without an explicit Planner remains plan-free; request targeted revisions rather than assuming Relay creates a Planner round.".into(),
        "Do not treat historical failed attempts as current artifact defects; distinguish preserved baseline files from implementation.".into(),
    ].join("\n\n")
}
pub fn route_reviewer(
    graph_directory:&Path,job:&Value,options:&Value,
    adapters:&[Value],registered:&[Value],usage:Option<&Value>,
    profile_home:&Path,policy_path:&Path,rules_path:&Path,
)->Result<Value,String>{
    let configured=options.get("reviewer").unwrap_or(&Value::Null);
    let requirements=configured.get("requirements").cloned()
        .unwrap_or(json!({"capabilities":["model"]}));
    let workers=worker_candidates(adapters,registered,usage,
        Utc::now().timestamp_millis()).into_iter()
        .filter(|candidate|field(candidate,"adapter")=="codex")
        .filter(|candidate|
            (field(configured,"workerId").is_empty()
                ||field(candidate,"workerId")==field(configured,"workerId"))
            &&(field(configured,"adapter").is_empty()
                ||field(candidate,"adapter")==field(configured,"adapter")))
        .collect::<Vec<_>>();
    let implementation=tasks(job).iter()
        .filter(|task|!review_task(task)&&field(task,"kind")!="planner")
        .collect::<Vec<_>>();
    let task_facts=json!({"role":"reviewer",
        "reviewer_diversity":{
            "preference":"Prefer a worker/provider-model identity different from implementation when otherwise suitable; this is a soft preference below user environment rules.",
            "implementation_workers":implementation.iter()
                .map(|task|task.pointer("/workerSelection/workerId")
                    .or_else(||task.get("adapter"))).collect::<Vec<_>>(),
            "implementation_routes":implementation.iter()
                .filter_map(|task|task.get("routing")).collect::<Vec<_>>()
        }});
    let opts=json!({"registered":registered,"usage":usage,
        "routingConstraints":configured.get("routing"),
        "modelPreference":agent_model_preference_for_job(
            job,FINAL_REVIEW_AGENT,options),
        "taskFacts":task_facts,
        "decisionMode":options.get("decisionMode"),
        "recordDecisionAudit":options.get("recordDecisionAudit"),
        "chatgptRunning":options.pointer("/runtimeSummary/chatgptRunning")});
    let discovery=discover_execution_routes(&workers,&requirements,&opts,
        profile_home,policy_path,rules_path,
        Utc::now().timestamp_millis())?;
    let routed=if options["useDecisionEngine"]==true{
        route_execution_decide(&discovery,&requirements,&workers,&opts,
            options["recentRouteResults"].as_array().map(Vec::as_slice).unwrap_or(&[]))?
    }else{route_execution_with_choice(&discovery,&requirements,&workers,&opts,None,None,&[],None)?};
    let _=graph_directory;
    Ok(routed)
}
pub fn create_final_review_task(
    graph_directory:&Path,store_directory:&Path,job:&Value,head:&str,
    routed:&Value,reviewer_options:&Value,
)->Result<Value,String>{
    let round=tasks(job).iter().filter(|t|
        review_task(t)&&field(t,"reviewHeadSha")==head).count()+1;
    let id=allocate_entity_id(store_directory,field(job,"repository"),
        "task",Some(&format!("final-review:{}:{head}:{round}",
            field(job,"id"))),&HashSet::new())?;
    let now=iso8601_now();
    let route=&routed["routing"];
    let selection=&routed["selection"];
    let candidate=&routed["candidate"];
    let mut fields=json!({
        "jobId":job.get("id"),"id":id,"title":"Final Review",
        "kind":"work","priority":job.get("priority"),
        "storySize":"M","projectName":job.get("title"),
        "agentName":FINAL_REVIEW_AGENT,"parentTaskId":null,
        "dependencies":[],"capabilities":["review"],
        "workerSelection":selection,"adapter":candidate.get("adapter"),
        "input":final_review_input(job,head),
        "output":{"kind":"task_pr"},"routing":route,
        "continuation":null,"continuationDeliveredAt":null,
        "reviewHeadSha":head,"attempt":0,
        "maxAttempts":reviewer_options.get("maxAttempts")
            .and_then(Value::as_u64).unwrap_or(2),
        "executionId":null,
        "threadId":null,"result":null,"plannerResult":null,
        "error":null,
        "timeoutMs":reviewer_options.get("timeoutMs")
            .and_then(Value::as_u64).unwrap_or(
                story_size_timeout_ms(crate::types::StorySize::M)),
        "createdAt":now,"updatedAt":now
    });
    // Preserve role conversation continuity between independent immutable
    // SHA-bound Review Tasks. The previous PASS/CHANGES_REQUIRED verdict is
    // NOT reused; it is merely prior conversation context.
    if fields["adapter"]=="codex"{
        if let Some(previous)=tasks(job).iter().rev().find(|task|
            review_task(task)
                &&field(task,"adapter")=="codex"
                &&field(task,"state")=="SUCCEEDED"
                &&crate::native_codex_thread::valid_thread_id(field(task,"threadId"))){
            fields["threadId"]=previous["threadId"].clone();
            if let Some(binding)=previous.get("threadRoute"){fields["threadRoute"]=binding.clone();}
        }
    }
    create_task_entity(graph_directory,job,&fields,false,&now)
}
pub fn ensure_final_review(
    directory:&Path,store_dir:&Path,job:&Value,head:Option<&str>,
    routed:Option<&Value>,reviewer_options:&Value,
)->Result<ReviewSnapshot,String>{
    let mut result=ReviewSnapshot::unchanged(job);
    let _=settle_review_revision_round(directory,&mut result.job,3,2)?;
    let prior=result.job.pointer("/review/taskId").and_then(Value::as_str)
        .and_then(|id|candidate_task(&result.job,id)).cloned();
    if result.job.pointer("/review/outcome").and_then(Value::as_str)==Some("blocked")
        &&result.job.pointer("/review/headSha").and_then(Value::as_str)==head
        &&prior.as_ref().is_some_and(|task|
            review_task(task)
            &&task.pointer("/unblock/event").and_then(Value::as_str)
                ==Some("task.unblocked")
            &&matches!(field(task,"state"),"QUEUED"|"RUNNING"|"FAILED")){
        let decision=decide_review_lifecycle(directory,Some("blocked"),
            "review.retry",&json!({"reviewUnblocked":true}))?;
        if field(&decision,"target")=="PENDING"
            &&decision.get("accepted")==Some(&Value::Bool(true)){
            result.job["review"]["outcome"]=json!("pending");
            result.job["review"]["updatedAt"]=json!(iso8601_now());
        }
    }
    let facts=review_facts(directory,&result.job,head)?;
    let decision=decide_review_lifecycle(directory,
        result.job.pointer("/review/outcome").and_then(Value::as_str),
        "reconcile",&facts)?;
    if !graph_actions(&decision,"review.create"){return Ok(result);}
    let head=head.ok_or("Review Graph requested creation without a durable SHA")?;
    let route=routed.ok_or("Final Review requires a hard-gated Worker route")?;
    let review_task=create_final_review_task(directory,store_dir,&result.job,
        head,route,reviewer_options)?;
    let id=field(&review_task,"id").to_string();
    let now=iso8601_now();
    result.job.get_mut("tasks").and_then(Value::as_array_mut)
        .ok_or("Job Task array missing")?.push(review_task.clone());
    let outcome=review_outcome(field(&decision,"target"))?
        .ok_or("Review Graph rejected create target")?;
    result.job["review"]=json!({"outcome":outcome,"headSha":head,
        "taskId":id,"evidence":null,"updatedAt":now});
    result.job["updatedAt"]=json!(now);
    refresh_task_dependencies(directory,&mut result.job,&now)?;
    result.events.push(event_for(field(job,"id"),&id,None,
        "review.created","queued",
        &format!("Final review Task {id} created for {head} using worker-router"),
        Some("orchestrator"),Some(json!({
            "headSha":head,"agentName":FINAL_REVIEW_AGENT,
            "reviewerRouting":{"workerId":route.pointer("/selection/workerId"),
                "reason":"worker-router",
                "selectedBy":route.pointer("/selection/selectedBy")}
        })),None));
    result.wake=true;
    if let Some(mut audit)=route.get("audit").filter(|v|v.is_object()).cloned(){
        audit["correlation"]=json!({"job_id":job["id"],"task_id":id,"attempt":0});
        audit["task"]=crate::decision_audit::task_audit_facts(Some(&review_task));
        result.decision_audit=Some(audit);
    }
    Ok(result)
}
pub fn route_task_for_execution(
    directory:&Path,profile_home:&Path,policy_path:&Path,
    rules_path:&Path,job:&Value,task:&Value,
    adapters:&[Value],registered:&[Value],usage:Option<&Value>,
    options:&Value,
)->Result<ReviewSnapshot,String>{
    let mut result=ReviewSnapshot::unchanged(job);
    if task.get("routing").is_some_and(|v|!v.is_null()) {
        return Ok(result);
    }
    if task.get("output").is_none_or(Value::is_null)
        ||field(task,"adapter")=="orchestrator"{return Ok(result);}
    let excluded=task.get("routingExclusions").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    let workers=worker_candidates(adapters,registered,usage,
        Utc::now().timestamp_millis()).into_iter()
        .filter(|worker|!excluded.iter().any(|x|{
            x.get("workerId")==worker.get("workerId")
                ||x.get("adapter")==worker.get("adapter")
        }))
        .filter(|worker|field(worker,"adapter")=="codex")
        .collect::<Vec<_>>();
    let requirements=task.get("workerRequirements").cloned()
        .unwrap_or(json!({"capabilities":[]}));
    let mut excluded_routes=excluded;
    if field(task,"agentName")=="troubleshooter"
        &&!field(task,"parentTaskId").is_empty(){
        if let Some(parent)=candidate_task(job,field(task,"parentTaskId")){
            let error=parent.get("error").and_then(Value::as_str)
                .or_else(||parent.get("failureReason").and_then(Value::as_str))
                .unwrap_or("");
            if regex::Regex::new(
                r"(?i)exited before publishing task\.started|worker_exit_before_start|launch failed"
            ).expect("source failure matcher").is_match(error){
                if let Some(route)=parent.get("routing"){
                    excluded_routes.push(route.clone());
                }
            }
        }
    }
    let task_facts=json!({
        "job":{"id":job.get("id"),"title":job.get("title"),
            "objective":job.get("objective"),"description":job.get("description"),
            "repository":job.get("repository"),"state":job.get("state")},
        "routingPreferences":if review_task(task){Value::Null}
            else{job.get("routingPreferences").cloned().unwrap_or(Value::Null)},
        "task":task,"storySize":task.get("storySize"),
        "recovery":task.get("recoveryContext")
    });
    let opts=json!({"registered":registered,"usage":usage,
        "modelPreference":agent_model_preference_for_job(
            job,task.get("agentName").and_then(Value::as_str)
                .filter(|agent|!agent.is_empty()).unwrap_or("implementation"),options),
        "taskFacts":task_facts,"excludedRoutes":excluded_routes,
        "decisionMode":options.get("decisionMode"),
        "recordDecisionAudit":options.get("recordDecisionAudit"),
        "chatgptRunning":options.pointer("/runtimeSummary/chatgptRunning")});
    let discovery=discover_execution_routes(&workers,&requirements,
        &opts,profile_home,policy_path,rules_path,
        Utc::now().timestamp_millis())?;
    let route=if options["useDecisionEngine"]==true{
        route_execution_decide(&discovery,&requirements,&workers,&opts,
            options["recentRouteResults"].as_array().map(Vec::as_slice).unwrap_or(&[]))?
    }else{route_execution_with_choice(&discovery,&requirements,&workers,&opts,None,None,&[],None)?};
    result.decision_audit=route.get("audit").filter(|v|!v.is_null()).cloned();
    let index=tasks(&result.job).iter().position(|t|t.get("id")==task.get("id"))
        .ok_or("Task absent after routing")?;
    let updated=&mut result.job["tasks"][index];
    updated["workerSelection"]=route["selection"].clone();
    updated["adapter"]=route["candidate"]["adapter"].clone();
    updated["routing"]=route["routing"].clone();
    updated["timeoutMs"]=json!(task.get("timeoutMs").and_then(Value::as_u64)
        .unwrap_or(story_size_timeout_ms(crate::types::StorySize::M)));
    updated["updatedAt"]=json!(iso8601_now());
    for (kind,detail) in [
        ("worker.selected",json!({"workerSelection":route.get("selection"),
            "workerRequirements":requirements})),
        ("model.selected",json!({"routing":route.get("routing")}))
    ]{
        result.events.push(event_for(field(job,"id"),field(task,"id"),
            task.get("parentTaskId").and_then(Value::as_str),
            kind,"queued",
            &if kind=="worker.selected"{
                format!("Worker {} selected for task {}",field(&route["selection"],"workerId"),
                    field(task,"id"))
            }else{
                format!("Selected {} · thinking {}",field(&route["routing"],"model"),
                    field(&route["routing"],"reasoning"))
            },
            Some("user"),Some(detail),None));
    }
    let _=directory;
    Ok(result)
}
pub fn apply_review_event(
    directory:&Path,job:&Value,event:&Value,
    verified_head:Option<&str>,
)->Result<ReviewSnapshot,String>{
    let mut result=ReviewSnapshot::unchanged(job);
    let task_id=field(event,"task_id");
    let Some(original)=candidate_task(job,task_id).filter(|t|review_task(t))
        .cloned() else{return Ok(result);};
    let evidence=normalize_review_evidence(event,&original);
    if evidence.is_null(){return Ok(result);}
    let head=field(&evidence,"headSha");
    if field(&original,"reviewHeadSha")!=head {return Ok(result);}
    let actual_head=review_head(job,verified_head);
    if actual_head.as_deref().is_some_and(|current|current!=head){
        return Ok(result);
    }
    if !review_generation_matches(&result.job,job,&original,head){
        return Ok(result);
    }
    let execution=field(&original,"executionId").to_owned();
    if !execution.is_empty(){
        let _=stale_review_revisions(directory,&mut result.job,task_id,
            head,Some(&execution))?;
    }
    let initial=if result.job.get("review").is_none_or(Value::is_null)
        &&original.get("planningDecisionId").is_some_and(|v|!v.is_null()){
        Some("pending")
    }else{result.job.pointer("/review/outcome").and_then(Value::as_str)};
    let issues=evidence.get("issues").and_then(Value::as_array)
        .map(Vec::as_slice).unwrap_or(&[]);
    let targeted=targeted_requests_cover_review(&result.job,&original,
        head,issues);
    let decision=decide_review_lifecycle(directory,initial,
        field(event,"type"),&json!({
            "autoMerge":job.get("autoMerge")!=Some(&Value::Bool(false)),
            "targetedRevisionRequestsReady":targeted
        }))?;
    if decision.get("accepted")!=Some(&Value::Bool(true)){
        return Ok(result);
    }
    let outcome=review_outcome(field(&decision,"target"))?
        .ok_or("Review Graph produced unknown verdict")?;
    let disposition=if graph_actions(&decision,"review.awaitTargetedRevisions"){
        Some("targeted")
    }else if graph_actions(&decision,"review.requireOwnerResolution"){
        Some("needs-ownership")
    }else{None};
    let index=tasks(&result.job).iter()
        .position(|task|field(task,"id")==task_id)
        .ok_or("Reviewer Task vanished")?;
    if !review_generation_matches(&result.job,job,&original,head){
        return Ok(ReviewSnapshot::unchanged(job));
    }
    let now=event.get("timestamp").and_then(Value::as_str)
        .filter(|s|!s.is_empty()).map(str::to_owned)
        .unwrap_or_else(iso8601_now);
    let mut candidate=result.job["tasks"][index].clone();
    let task_event=try_transition_task_event(directory,&mut candidate,
        field(event,"type"),&json!({}),&now)?;
    if task_event.get("accepted")!=Some(&Value::Bool(true)){
        return Ok(ReviewSnapshot::unchanged(job));
    }
    let terminal=field(&task_event,"target")!="RUNNING";
    candidate["error"]=Value::Null;
    if terminal{
        // Review verdicts are normalized separately from Worker terminal
        // events. They still terminate an owned execution generation and
        // MUST release the same lease fields as task.completed. Otherwise a
        // COMPLETED Job can retain a ghost Reviewer lease indefinitely.
        candidate["executionId"]=Value::Null;
        candidate["result"]=json!({"summary":event.get("message")
            .and_then(Value::as_str).unwrap_or("Review settled"),
            "data":event.get("data")});
    }
    result.job["tasks"][index]=candidate;
    let mut normalized_data=event.get("data").cloned().unwrap_or(json!({}));
    if !normalized_data.is_object(){normalized_data=json!({});}
    let mut review_data=normalized_data.get("review").cloned()
        .unwrap_or(json!({}));
    if !review_data.is_object(){review_data=json!({});}
    review_data["headSha"]=json!(head);
    normalized_data["review"]=review_data;
    normalized_data["headSha"]=json!(head);
    normalized_data["outcome"]=json!(outcome);
    normalized_data["source"]=event.get("source").cloned().unwrap_or(Value::Null);
    let mut review=json!({"outcome":outcome,"headSha":head,
        "taskId":task_id,"updatedAt":now,
        "evidence":{"summary":event.get("message"),"data":normalized_data}});
    if let Some(disposition)=disposition{
        review["revisionDisposition"]=json!(disposition);
    }
    result.job["review"]=review;
    result.job["updatedAt"]=json!(now);
    if terminal&&!execution.is_empty()
        &&matches!(field(event,"type"),
            "review.changes_required"|"review.approved"){
        let request_ids=targeted_requests_for_review(&result.job,&original,head)
            .iter().filter_map(|request|request.get("requestId"))
            .cloned().collect::<Vec<_>>();
        let exists=result.job.get("reviewRevisionRounds")
            .and_then(Value::as_array).into_iter().flatten()
            .any(|round|round.get("reviewTaskId")==Some(&json!(task_id))
                &&round.get("reviewExecutionId")==Some(&json!(execution)));
        if !exists{
            let round=json!({"reviewTaskId":task_id,
                "reviewExecutionId":execution,"headSha":head,
                "requestIds":request_ids,
                "status":if outcome=="approved"{"approved"}else{"changes_required"},
                "findingFingerprint":review_finding_fingerprint(issues),
                "recordedAt":now});
            if let Some(rows)=result.job.get_mut("reviewRevisionRounds")
                .and_then(Value::as_array_mut){rows.push(round);}
            else{result.job["reviewRevisionRounds"]=json!([round]);}
        }
    }
    if terminal&&!execution.is_empty(){
        result.cancel_execution_ids.push(execution);
    }
    result.wake=matches!(outcome.as_str(),"approved"|"changes_required")
        ||disposition==Some("targeted");
    Ok(result)
}

// Node ReconcilerReviewBase's owned runtime host adapter, extracted for SRP.
pub use crate::reconciler_review_base::{ReconcilerReviewBase,ReviewBaseHost};

#[cfg(test)]
mod model_agent_routing_preference_tests {
    use super::*;
    #[test]
    fn inherited_project_agent_hints_are_optional_and_read_only() {
        let root=std::env::temp_dir().join(format!(
            "relay-model-agent-pref-{}",crate::events::random_uuid()));
        let project=root.join("project");
        std::fs::create_dir_all(project.join("agents")).unwrap();
        std::fs::write(project.join("agents/parentpref.agent.md"),
            "---\nname: parentpref\nmodel: zai/glm-5.3-flash\nreasoning: medium\n---\n# Parent\n").unwrap();
        std::fs::write(project.join("agents/childpref.agent.md"),
            "---\nname: childpref\nextends: parentpref\nreasoning: high\n---\n# Child\n").unwrap();
        let job=json!({"projectRoot":project});
        let options=json!({"workspaceRoot":root,"globalRoot":root});
        assert_eq!(agent_model_preference_for_job(&job,"childpref",&options),
            Some(json!({"model":"zai/glm-5.3-flash","reasoning":"high"})));
        assert_eq!(agent_model_preference_for_job(&job,"missingpref",&options),None);
        assert_eq!(agent_model_preference_for_job(&json!({}),"childpref",&options),None);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
