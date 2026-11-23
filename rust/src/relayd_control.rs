// Head-to-head Phase1 port: src/relayd-control.ts
// HTTP workspace control is a strict command dispatcher over authoritative
// SQLite Job bindings. The backend enforces atomic mutateJob/append operations
// and wakes the SAME Pool. No client-side Dashboard source changes.
use crate::{
    agent_graph::parse_agent_graph,
    cli_coordinator::bind_coordinator_start,
    blockers::register_blocker_dependency,
    cli_job_create::{ensure_managed_local_job,require_preflight_options},
    interactive_request::{begin_interactive_review,abort_interactive_review,interactive_waiting_event},
    job_pause::{pause_job,resume_job},
    local_merge_lock::iso8601_now,
    git_delivery::verify_source_commit,
    events::event_for,
    execution_event_identity::execution_event_source,
    force_restate::execute_force_restate,
    reconciler_runtime::ReconcilerRuntime,
    registry::discover_agents,
    task_actions::{dispatch_task_action_snapshot,classify_failed_task_snapshot,supersede_cancelled_task_snapshot},
    task_comments::append_task_comment,
    task_recovery::{request_troubleshooter_escalation,resume_troubleshooter},
    task_transitions::try_transition_task_event,
    unblock::{is_effectively_blocked,unblock_task_snapshot},
    workflow::lifecycle::dispatch_job_lifecycle_sync,
    workspace::{resolve_job_project_root,resolve_workspace_root},
};
use regex::Regex;
use serde_json::{json,Value};
use std::{collections::{HashMap,HashSet},path::Path};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn text<'a>(v:&'a Value,key:&str)->Option<&'a str>{
    v.get(key).and_then(Value::as_str).filter(|s|!s.trim().is_empty())
}
/// Original Node guard coercion: `typeof body.<key> === 'string' ? body.<key>
/// : ''`. Missing, null and non-string fields all read as the empty string.
fn js_text<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn required<'a>(v:&'a Value,key:&str,description:&str)->Result<&'a str,String>{
    text(v,key).ok_or_else(||format!("{description} requires {key}"))
}
fn task<'a>(job:&'a Value,id:&str)->Option<&'a Value>{
    job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|t|field(t,"id")==id)
}
fn allowed_repo(known:&[String],name:&str)->bool{
    known.iter().any(|v|v==name)
}
/// Store services, agent contracts and Git side effects are injected;
/// they MUST NOT be implemented via background process or a second Job DB.
pub trait WorkspaceControlBackend{
    fn graph_directory(&self)->&Path;
    fn store_directory(&self)->&Path;
    fn repositories(&self)->Vec<String>;
    fn repository_path(&self,repository:&str)->Option<String>;
    fn known_jobs(&mut self)->Result<Vec<Value>,String>;
    fn load_job(&mut self,job_id:&str)->Result<Value,String>;
    fn save_job(&mut self,job:&Value)->Result<Value,String>;
    fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>;
    fn mutate_job(&mut self,id:&str,
        reducer:&dyn Fn(&mut Value)->Result<(),String>)->Result<Value,String>;
    fn append_task(&mut self,job_id:&str,task:&Value)->Result<Value,String>;
    fn save_agent(&mut self,job_id:&str,agent:&Value)->Result<(),String>;
    fn list_agents(&mut self,job_id:&str)->Result<Vec<Value>,String>;
    fn wake(&mut self,id:&str,reason:&str)->Result<(),String>;
    fn refresh_inventory(&mut self)->Result<(),String>;
    fn publish(&mut self,event:&Value)->Result<(),String>;
    fn manual_plan(&mut self,id:&str,guidance:Option<&str>,force:bool)
        ->Result<Value,String>;
    fn review_targeted(&mut self,id:&str,request:&Value)->Result<Value,String>;
    /// Production Task edits must use canonical task-update SQLite/Graph
    /// reducer and wake only after a committed optimistic-version receipt.
    fn task_update(&mut self,_id:&str,_task_id:&str,_task:&Value,
        _expected_updated_at:&str)->Result<Value,String>{
        Err("Native managed Task update port is not connected".into())
    }
    fn blocker_ensure(&mut self,request:&Value)->Result<Value,String>;
    fn blocker_resolve(&mut self,id:&str,mode:&str)->Result<Value,String>;
    fn local_head(&mut self,job:&Value)->Result<String,String>;
    fn fail_interactive(&mut self,id:&str,task_id:&str,execution:&str,reason:&str)
        ->Result<Value,String>;
}
fn persist_candidate<B:WorkspaceControlBackend>(backend:&mut B,id:&str,
    previous:&Value,next:&Value)->Result<Value,String>{
    // Optimistic read+check is repeated INSIDE the caller's BEGIN IMMEDIATE
    // SQLite transaction. Refuse replacing concurrent Task/Review work.
    let expected=previous.clone();
    let candidate=next.clone();
    backend.mutate_job(id,&|fresh|{
        if fresh!=&expected{
            return Err("Concurrent Job mutation; recompute from SQLite snapshot".into());
        }
        *fresh=candidate.clone();Ok(())
    })
}
fn waking<B:WorkspaceControlBackend>(backend:&mut B,id:&str,reason:&str,
    snapshot:Value)->Result<Value,String>{
    backend.wake(id,reason)?;
    backend.load_job(id).or(Ok(snapshot))
}
fn control_create<B:WorkspaceControlBackend>(
    backend:&mut B,body:&Value,
)->Result<Value,String>{
    // Preserve Node public factory validation order: reject obsolete options
    // before checking the repository and before any backend side effects.
    let opts=body.get("options").filter(|v|v.is_object())
        .cloned().unwrap_or(json!({}));
    require_preflight_options(&opts)?;
    if opts.get("projectPath").is_some(){
        return Err("Job projectPath is removed; use an independent local Git root".into());
    }
    if opts.get("contentOnly").is_some()||opts.get("executionMode").is_some(){
        return Err("Execution mode/content-only is obsolete; use normal Job reviewEnabled and autoMerge policy".into());
    }
    let repository=body.get("repository").and_then(Value::as_str)
        .filter(|s|!s.is_empty())
        .ok_or("job.create requires repository")?.to_string();
    if opts.get("schedule").is_some(){return Err("Job schedules are unsupported".into());}
    if opts.get("coordinator").is_some_and(|v|!v.is_null())
        &&body.get("initialPlan")==Some(&Value::Bool(true)){
        return Err("Coordinator Job must not request an initial Planner".into());
    }
    if !allowed_repo(&backend.repositories(),&repository)
        &&backend.repository_path(&repository).is_none(){
        return Err(format!("Local repository {repository} is not authorized"));
    }
    let root=text(&opts,"projectRoot")
        .map(str::to_owned).or_else(||backend.repository_path(&repository))
        .ok_or("job.create requires a canonical local projectRoot")?;
    let graph=backend.graph_directory().to_path_buf();
    let stores=backend.store_directory().to_path_buf();
    let all=backend.known_jobs()?;
    let response=ensure_managed_local_job(
        &graph,&stores,&repository,Path::new(&root),
        &opts,&all,|id|Ok(all.iter().find(|j|field(j,"id")==id).cloned()),
        |job|Ok(job.clone()))?;
    let mut job=response.get("job").cloned()
        .ok_or("Native Job create did not return a Job")?;
    if body.get("initialPlan")==Some(&Value::Bool(true)){
        let planned=backend.manual_plan(field(&job,"id"),None,false)?;
        job=backend.create_job_if_absent(&planned["job"])?;
        backend.wake(field(&job,"id"),"control.job.create.initial-plan")?;
        backend.refresh_inventory()?;
        return Ok(json!({"repository":repository,"job":job.get("id"),
            "state":job.get("state"),
            "initialPlan":job.pointer("/plans/0/id")}));
    }
    job=backend.create_job_if_absent(&job)?;
    backend.refresh_inventory()?;
    if let Some(coordinator)=job.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|task|
            field(task,"title")=="Coordinator"
                &&task.get("agentGraph").is_some_and(|v|!v.is_null())){
        return Ok(json!({"repository":repository,"job":job.get("id"),
            "state":job.get("state"),"taskId":coordinator.get("id")}));
    }
    Ok(json!({"repository":repository,"job":job.get("id"),
        "state":job.get("state")}))
}
fn control_review<B:WorkspaceControlBackend>(
    backend:&mut B,job:&Value,body:&Value,command:&str,
)->Result<Value,String>{
    let job_id=field(job,"id");
    let task_id=required(body,"taskId","Interactive review")?;
    let execution=required(body,"executionId","Interactive review")?;
    match command{
        "review.interactive.begin"=>{
            let (next,receipt)=begin_interactive_review(job,job_id,task_id,execution)?;
            persist_candidate(backend,job_id,job,&next)?;
            Ok(receipt)
        },
        "review.interactive.abort"=>{
            let next=abort_interactive_review(job,task_id,execution);
            persist_candidate(backend,job_id,job,&next)?;
            Ok(json!({"aborted":true}))
        },
        "review.interactive.wait"=>{
            let current=task(job,task_id).ok_or("Stale interactive waiting request")?;
            if field(current,"state")=="AWAITING_DECISION"
                &&current.pointer("/interactiveInvocation/executionId")
                    .and_then(Value::as_str)==Some(execution){
                return Ok(json!({"waiting":true,"taskState":"AWAITING_DECISION"}));
            }
            if field(current,"state")!="RUNNING"
                ||field(current,"executionId")!=execution
                ||current.pointer("/interactiveInvocation/executionId")
                    .and_then(Value::as_str)!=Some(execution){
                return Err("Stale interactive waiting request".into());
            }
            let event=interactive_waiting_event(
                job_id,task_id,current.get("parentTaskId").and_then(Value::as_str),
                execution);
            // Publishing an SSE observation is not a Task transition. Apply
            // the correlated event through the SAME canonical Graph before
            // acknowledging the host-owned wait, and CAS it into SQLite.
            let graph=backend.graph_directory().to_path_buf();
            let mut runtime=ReconcilerRuntime::new("interactive-review-wait");
            let result=runtime.apply_event(&graph,job,&event,None)?;
            let waiting=result.job.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().find(|row|field(row,"id")==task_id)
                .is_some_and(|row|field(row,"state")=="AWAITING_DECISION"
                    &&row.pointer("/interactiveInvocation/status")
                        .and_then(Value::as_str)==Some("awaiting_decision")
                    &&row.pointer("/interactiveInvocation/executionId")
                        .and_then(Value::as_str)==Some(execution));
            if !result.applied || !waiting {
                return Err("Interactive review waiting was not accepted by Task Graph".into());
            }
            persist_candidate(backend,job_id,job,&result.job)?;
            backend.publish(&event)?;
            backend.wake(job_id,"interactive.wait")?;
            Ok(json!({"waiting":true,"taskState":"AWAITING_DECISION"}))
        },
        "review.interactive.fail"=>{
            let reason=text(body,"reason").unwrap_or("Interactive review failed");
            let receipt=backend.fail_interactive(job_id,task_id,execution,reason)?;
            if receipt.get("requeued")==Some(&Value::Bool(true)){
                backend.wake(job_id,"interactive.preview-failed")?;
            }
            Ok(receipt)
        },
        _=>Err("Unknown interactive review command".into())
    }
}
/// Uses one exact Job ID. Repository path from the caller is never silently
/// elevated to a new Job scope.
pub fn workspace_control<B:WorkspaceControlBackend>(
    backend:&mut B,body:&Value,
)->Result<Value,String>{
    let command=body.get("command").and_then(Value::as_str)
        .filter(|s|!s.is_empty())
        .ok_or("control command is required")?;
    if command=="job.create"{return control_create(backend,body);}
    let job_id=body.get("jobId").and_then(Value::as_str)
        .filter(|s|!s.is_empty())
        .ok_or_else(||format!("{command} requires jobId"))?
        .to_owned();
    let job=backend.load_job(&job_id)?;
    let graph=backend.graph_directory().to_path_buf();
    match command{
        "job.pause"|"job.resume"=>{
            let pause=command=="job.pause";
            let snapshot=backend.mutate_job(&job_id,&|current|{
                let prior=current.clone();
                let next=if pause{
                    pause_job(current,|task,event|{
                        try_transition_task_event(&graph,task,event,&json!({}),&iso8601_now())
                            .is_ok_and(|decision|decision["accepted"]==true)
                    })?
                }else{
                    resume_job(current)?
                };
                *current=next;
                if *current==prior{return Ok(());}
                Ok(())
            })?;
            backend.wake(&job_id,if pause{"control.job.pause"}else{"control.job.resume"})?;
            Ok(snapshot)
        },
        "job.run"=>{
            let task_id=required(body,"taskId","job run")?;
            let root=task(&job,task_id)
                .ok_or_else(||format!("Task {task_id} not found"))?;
            let override_graph=body.get("graphOverride").and_then(Value::as_str)
                .filter(|value|!value.is_empty());
            if let Some(source)=override_graph{parse_agent_graph(source)?;}
            let saved_graph=text(root,"agentGraph");
            let source=saved_graph.or(override_graph)
                .ok_or("job run requires a durable Agent Graph Task")?;
            parse_agent_graph(source)?;
            let workspace_root=resolve_workspace_root(
                body.get("workspaceRoot").and_then(Value::as_str)
                    .filter(|value|!value.is_empty()))?;
            let project_root=resolve_job_project_root(&job)?;
            let global_root=body.get("globalRoot").and_then(Value::as_str)
                .filter(|value|!value.is_empty());
            let now=iso8601_now();
            let stored=backend.mutate_job(&job_id,&|current|{
                // Recompute with fresh SQLite state inside one transaction.
                let updated=bind_coordinator_start(
                    current,task_id,source,
                    &project_root.to_string_lossy(),&workspace_root.to_string_lossy(),
                    global_root,false,
                    |task|try_transition_task_event(
                        &graph,task,"queue",
                        &json!({"dependenciesSatisfied":true}),&now)
                        .is_ok_and(|decision|
                            decision["accepted"]==true&&decision["target"]=="QUEUED"),
                    |job|dispatch_job_lifecycle_sync(
                        &graph,job,"activate",&json!({}),&now)
                        .is_ok_and(|decision|
                            decision["accepted"]==true&&decision["target"]=="ACTIVE"),
                )?;
                *current=updated;
                Ok(())
            })?;
            backend.wake(&job_id,"control.job.run")?;
            Ok(json!({"jobId":job_id,"taskId":task_id,"scheduled":true,
                "state":stored.get("state"),"graphRuntime":"tasks"}))
        },
        "review.interactive.begin"|"review.interactive.abort"
            |"review.interactive.wait"|"review.interactive.fail"=>
                control_review(backend,&job,body,command),
        "job.update"=>{
            let patch=body.get("patch").filter(|p|p.is_object())
                .cloned().unwrap_or(json!({}));
            for obsolete in ["projectPath","executionMode","schedule"]{
                if patch.get(obsolete).is_some(){
                    return Err("Job execution modes/schedules and projectPath are unsupported".into());
                }
            }
            let allowed=["title","objective","priority","tag","autoMerge",
                "reviewEnabled","reviewerThreadId","creatorThreadId",
                "implementationThreadId","continuation","localMerge"];
            let mut next=job.clone();
            for (key,value) in patch.as_object().into_iter().flatten(){
                if allowed.contains(&key.as_str()){
                    next[key]=value.clone();
                }
            }
            next["updatedAt"]=json!(iso8601_now());
            let updated=persist_candidate(backend,&job_id,&job,&next)?;
            backend.refresh_inventory()?;
            Ok(updated)
        },
        "job.plan"=>{
            let result=if body.get("forceRestate")==Some(&Value::Bool(true)){
                // Same canonical manual Plan Apply as normal planning. This
                // public wrapper forwards exactly forceRestate=true and
                // must never introduce a second planning/scheduling policy.
                let future=execute_force_restate(
                    (),&job_id,text(body,"guidance"),60_000,(),
                    |_,id,guidance,_timeout,_,force|std::future::ready(
                        backend.manual_plan(id,guidance,force)),
                );
                let mut future=std::pin::pin!(future);
                let mut context=std::task::Context::from_waker(std::task::Waker::noop());
                match std::future::Future::poll(future.as_mut(),&mut context){
                    std::task::Poll::Ready(value)=>value?,
                    std::task::Poll::Pending=>return Err(
                        "Native Force Restate unexpectedly suspended the synchronous Plan action".into()),
                }
            }else{
                backend.manual_plan(&job_id,text(body,"guidance"),false)?
            };
            backend.wake(&job_id,"control.job.plan")?;
            Ok(result.get("round").cloned().unwrap_or(result))
        },
        "job.unblock"=>{
            let reason=required(body,"reason","job.unblock")?;
            let selected=job.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().filter(|task|is_effectively_blocked(task))
                .filter_map(|t|t.get("id").and_then(Value::as_str))
                .map(str::to_owned).collect::<Vec<_>>();
            if selected.is_empty(){
                return Err(format!("Job {job_id} has no effectively BLOCKED work Task"));
            }
            let mut snapshot=job.clone();
            for id in &selected{
                snapshot=unblock_task_snapshot(&graph,&snapshot,id,"cli",
                    reason,None,None,None,None)?.0;
            }
            persist_candidate(backend,&job_id,&job,&snapshot)?;
            for id in selected{
                backend.publish(&event_for_unblock(&job_id,&id,reason))?;
            }
            waking(backend,&job_id,"control.job.unblock",snapshot)
        },
        "task.update"=>{
            let id=required(body,"taskId","task.update")?;
            let expected=required(body,"expectedUpdatedAt","task.update")?;
            let proposed=body.get("task").filter(|value|value.is_object())
                .ok_or("task.update requires proposed Task object")?;
            if proposed.get("id").and_then(Value::as_str)!=Some(id)
                ||proposed.get("jobId").and_then(Value::as_str)!=Some(job_id.as_str()){
                return Err("Task update identity mismatch".into());
            }
            backend.task_update(&job_id,id,proposed,expected)
        },
        "task.complete"=>{
            let task_id=field(body,"taskId");
            let execution_id=field(body,"executionId");
            let commit_sha=field(body,"commitSha");
            let repository=field(body,"repository");
            let summary=field(body,"summary").trim();
            if task_id.is_empty()||execution_id.is_empty()||commit_sha.is_empty()
                ||summary.is_empty()||repository!=field(&job,"repository")
                ||summary.encode_utf16().count()>4000{
                return Err("task.complete requires matching repository, Task/Execution IDs, commit SHA and bounded summary".into());
            }
            let original=task(&job,task_id).ok_or("task.complete is for commit-required source Tasks only")?;
            if original["gitDeliveryRequired"]!=true{
                return Err("task.complete is for commit-required source Tasks only".into());
            }
            if original["state"]=="SUCCEEDED"
                &&original.pointer("/gitDelivery/executionId").and_then(Value::as_str)==Some(execution_id)
                &&original.pointer("/gitDelivery/commitSha").and_then(Value::as_str)==Some(commit_sha){
                return Ok(json!({"accepted":true,"idempotent":true,"task":original}));
            }
            // Git is independently re-verified before every candidate receipt.
            // SQLite mutation fences this exact execution and start SHA.
            let receipt=verify_source_commit(&job,original,execution_id,commit_sha)?;
            let stored=backend.mutate_job(&job_id,&|fresh|{
                let current=fresh.get_mut("tasks").and_then(Value::as_array_mut)
                    .and_then(|list|list.iter_mut().find(|t|field(t,"id")==task_id))
                    .ok_or("task.complete refused: stale or replaced source Task execution")?;
                if current["gitDeliveryRequired"]!=true||current["state"]!="RUNNING"
                    ||field(current,"executionId")!=execution_id
                    ||current.pointer("/gitDeliveryBaseline/executionId")!=receipt.get("executionId")
                    ||current.pointer("/gitDeliveryBaseline/sha")!=receipt.get("baseSha"){
                    return Err("task.complete refused: stale or replaced source Task execution".into());
                }
                current["gitDelivery"]=receipt.clone();
                current["updatedAt"]=json!(iso8601_now());
                Ok(())
            })?;
            let event=event_for(&job_id,task_id,
                original.get("parentTaskId").and_then(Value::as_str),
                "task.completed","succeeded",summary,Some("worker"),
                Some(json!({"commit_sha":commit_sha,"verified_git_delivery":true})),
                Some(json!({"id":execution_event_source(&job_id,task_id,execution_id),
                    "agent":original.get("agentName").and_then(Value::as_str).unwrap_or("worker"),
                    "component":"agents-relay-cli"})));
            // Delegate the success decision and all Task field mutations to
            // the canonical Graph through the same ReconcilerRuntime entrypoint.
            let mut runtime=ReconcilerRuntime::new("control.task.complete");
            let effect=runtime.apply_event(&graph,&stored,&event,None)?;
            if !effect.applied{
                return Err(format!("task.complete rejected by Task Graph: {}",effect.reason));
            }
            let saved=persist_candidate(backend,&job_id,&stored,&effect.job)?;
            // An event bus failure cannot roll back verified SQLite success.
            let _=backend.publish(&event);
            backend.wake(&job_id,"control.task.complete")?;
            Ok(json!({"accepted":true,"task":task(&saved,task_id)}))
        },
        "task.comment"=>{
            let task_id=required(body,"taskId","task.comment")?;
            let message=required(body,"message","task.comment")?;
            let mut snapshot=job.clone();
            let recorded=append_task_comment(&mut snapshot,task_id,message,
                &json!({"author":"cli"}))?;
            persist_candidate(backend,&job_id,&job,&snapshot)?;
            Ok(recorded)
        },
        "task.supersede"|"task.classify"|"task.recover"=>{
            // Node validates the complete field set in one guard with the
            // combined message before any Task lookup (src/relayd-control.ts
            // 'task supersede requires taskId and reason' /
            // 'task classify requires taskId, classification, targetTaskId,
            // evidence, and reason' / 'task recover requires taskId and
            // recoveryTaskId').
            let id=js_text(body,"taskId");
            let reason=js_text(body,"reason");
            if command=="task.supersede"{
                if id.is_empty()||reason.trim().is_empty(){
                    return Err("task supersede requires taskId and reason".into());
                }
            }else if command=="task.classify"{
                let raw=body.get("classification");
                let shape=raw.is_some_and(|raw|
                    raw.get("kind").and_then(Value::as_str)
                        .is_some_and(|kind|kind=="superseded"||kind=="invalid")
                    &&raw.get("targetTaskId").and_then(Value::as_str)
                        .is_some_and(|v|!v.is_empty())
                    &&raw.get("evidence").and_then(Value::as_str)
                        .is_some_and(|v|!v.is_empty())
                    &&raw.get("reason").and_then(Value::as_str)
                        .is_some_and(|v|!v.is_empty()));
                if id.is_empty()||!shape{
                    return Err("task classify requires taskId, classification, targetTaskId, evidence, and reason".into());
                }
            }else if id.is_empty()||js_text(body,"recoveryTaskId").is_empty(){
                return Err("task recover requires taskId and recoveryTaskId".into());
            }
            let snapshot=if command=="task.supersede"{
                supersede_cancelled_task_snapshot(&graph,&job,id,&reason,None)?
            }else if command=="task.classify"{
                classify_failed_task_snapshot(&graph,&job,id,
                    body.get("classification").ok_or(
                        "task classify requires classification")?,None)?
            }else{
                let recovery=js_text(body,"recoveryTaskId");
                let request=json!({"id":"task.recover","taskId":id,
                    "recoveryTaskId":recovery,
                    "recoveryDiagnosis":body.get("recoveryDiagnosis")});
                dispatch_task_action_snapshot(&graph,&job,&request,None)?.0
            };
            persist_candidate(backend,&job_id,&job,&snapshot)?;
            waking(backend,&job_id,&format!("control.{command}"),snapshot)
        },
        "task.resume-troubleshooter"=>{
            // Node forwards the raw taskId and response straight into
            // resumeTroubleshooter: the trimmed-response check ('Troubleshooter
            // response is required') fires before any Task lookup.
            let id=body.get("taskId").and_then(Value::as_str).unwrap_or("");
            let response=body.get("response").and_then(Value::as_str).unwrap_or("");
            // Recovery returns a receipt { job, task }; persistence must
            // receive the Job snapshot, not that composite receipt.
            let outcome=resume_troubleshooter(&graph,&job,id,response,None)?;
            let snapshot=outcome.get("job").cloned()
                .ok_or("Troubleshooter recovery did not return a Job")?;
            persist_candidate(backend,&job_id,&job,&snapshot)?;
            backend.publish(&event_for_unblock(&job_id,id,
                "Human response recorded"))?;
            waking(backend,&job_id,"control.task.resume-troubleshooter",snapshot)
        },
        "task.unblock"=>{
            // Node looks the Task up FIRST: `Task ${taskId} not found` with
            // the raw (possibly empty) id, then routes to the troubleshooter
            // resume only when a response string exists.
            let id=body.get("taskId").and_then(Value::as_str).unwrap_or("");
            let original=task(&job,id)
                .ok_or_else(||format!("Task {id} not found"))?;
            let response=body.get("response").and_then(Value::as_str);
            let snapshot=if field(original,"agentName")=="troubleshooter"
                &&original.pointer("/escalation/status")
                    .and_then(Value::as_str)==Some("pending")
                &&response.is_some(){
                let outcome=resume_troubleshooter(
                    &graph,&job,id,response.unwrap_or(""),None)?;
                outcome.get("job").cloned()
                    .ok_or("Troubleshooter recovery did not return a Job")?
            }else{
                unblock_task_snapshot(&graph,&job,id,"cli",
                    field(body,"reason"),None,None,None,None)?.0
            };
            persist_candidate(backend,&job_id,&job,&snapshot)?;
            backend.publish(&event_for_unblock(&job_id,id,
                text(body,"reason").unwrap_or("Human response recorded")))?;
            waking(backend,&job_id,"control.task.unblock",snapshot)
        },
        "task.escalate"=>{
            // Node passes the raw (possibly empty/missing) taskId and
            // empty-string defaults into requestTroubleshooterEscalation;
            // its validateRequest throws 'Escalation requires a concrete
            // required action' before any Task lookup.
            let id=body.get("taskId").and_then(Value::as_str).unwrap_or("");
            let string_or_empty=|key:&str|match body.get(key){
                Some(Value::String(value))=>value.as_str(),
                _=>"",
            };
            let request=json!({"requiredAction":string_or_empty("requiredAction"),
                "resolutionCondition":string_or_empty("resolutionCondition"),
                "context":string_or_empty("context")});
            let receipt=request_troubleshooter_escalation(
                &graph,&job,id,&request,None)?;
            let snapshot=receipt.get("job").cloned()
                .ok_or("Escalation did not return candidate Job")?;
            persist_candidate(backend,&job_id,&job,&snapshot)?;
            if let Some(event)=receipt.get("event").filter(|v|!v.is_null()){
                backend.publish(event)?;
            }
            waking(backend,&job_id,"control.task.escalate",snapshot)
        },
        "review.request"=>{
            if matches!(field(&job,"state"),"CANCELLED"|"COMPLETED"){
                return Err("Cannot request review for terminal Job".into());
            }
            if job.get("reviewEnabled")==Some(&Value::Bool(false)){
                return Err("Review disabled for this Job".into());
            }
            if let Some(thread)=text(body,"threadId"){
                let mut candidate=job.clone();
                candidate["reviewerThreadId"]=json!(thread);
                candidate["updatedAt"]=json!(iso8601_now());
                persist_candidate(backend,&job_id,&job,&candidate)?;
            }
            backend.wake(&job_id,"control.review.request")?;
            backend.load_job(&job_id)
        },
        "task.revise"=>{
            // Node validates the whole guard in one throw: 'task.revise
            // requires matching repository, original/reviewer IDs, active
            // execution ID, valid SHA, stable request ID and nonempty
            // findings'.
            let request=body.clone();
            let revise_guard=
                js_text(&request,"repository")!=""&&field(&request,"repository")==field(&job,"repository")
                &&js_text(&request,"taskId")!=""
                &&js_text(&request,"reviewTaskId")!=""
                &&js_text(&request,"reviewExecutionId")!=""
                &&js_text(&request,"requestId")!=""
                &&Regex::new(r"(?i)^[a-f0-9]{40,64}$").unwrap()
                    .is_match(js_text(&request,"headSha"))
                &&request.get("findings").and_then(Value::as_array)
                    .is_some_and(|items|!items.is_empty()&&items.len()<=200);
            if !revise_guard{
                return Err("task.revise requires matching repository, original/reviewer IDs, active execution ID, valid SHA, stable request ID and nonempty findings".into());
            }
            if backend.local_head(&job)?!=field(&request,"headSha"){
                return Err("task.revise rejected: local Git source SHA changed".into());
            }
            backend.review_targeted(&job_id,&request)
        },
        "blocker.add"=>{
            let target=required(body,"dependentJobId","blocker.add")?;
            let task=required(body,"dependentTaskId","blocker.add")?;
            let dependent=backend.load_job(target)?;
            let result=register_blocker_dependency(&graph,&job,&dependent,
                task,None,text(body,"resolutionMode"),None)?;
            persist_candidate(backend,&job_id,&job,&result.blocker)?;
            persist_candidate(backend,target,&dependent,&result.dependent)?;
            backend.wake(&job_id,"control.blocker.add")?;
            backend.refresh_inventory()?;
            Ok(result.relation)
        },
        "blocker.ensure"=>{
            let request=body.get("request").filter(|v|v.is_object())
                .ok_or("blocker.ensure requires request")?;
            for key in ["requestId","targetRepository","dependentRepository",
                "dependentJobId","dependentTaskId","reason","title","objective"]{
                required(request,key,"blocker.ensure")?;
            }
            if !allowed_repo(&backend.repositories(),field(request,"targetRepository")){
                return Err("Blocker target repository is outside authorized scope".into());
            }
            let response=backend.blocker_ensure(request)?;
            backend.refresh_inventory()?;
            Ok(response)
        },
        "blocker.resolve"=>{
            let mode=if field(body,"resolution")=="merge"{"merge"}else{"verified"};
            let response=backend.blocker_resolve(&job_id,mode)?;
            backend.refresh_inventory()?;
            Ok(response)
        },
        "job.reconcile"=>{
            backend.wake(&job_id,"control.job.reconcile")?;
            backend.load_job(&job_id)
        },
        "agent.discover"=>{
            let agents=backend.list_agents(&job_id)?;
            Ok(json!(discover_agents(&agents,
                body.get("requirements").unwrap_or(&json!({})))))
        },
        "record"=>{
            let candidate=body.get("task")
                .filter(|task|field(task,"jobId")==job_id)
                .ok_or("record requires a Task bound to this Job")?;
            backend.append_task(&job_id,candidate)?;
            waking(backend,&job_id,"control.record",job)
        },
        "agent.register"=>{
            let candidate=body.get("agent").filter(|v|v.is_object())
                .ok_or("agent.register requires Agent registration")?;
            backend.save_agent(&job_id,candidate)?;
            Ok(candidate.clone())
        },
        _=>Err(format!("Unsupported control command {command}"))
    }
}
fn event_for_unblock(job_id:&str,task_id:&str,reason:&str)->Value{
    crate::events::event_for(job_id,task_id,None,
        "task.unblocked","queued",reason,Some("orchestrator"),
        Some(json!({})),None)
}

/// Node createWorkspaceControl returns an owned callback that closes over
/// its dependencies. Rust captures the same authorized backend: the returned
/// callback executes the existing SQLite/Graph-bound workspace_control.
pub fn create_workspace_control<'a,B:WorkspaceControlBackend>(
    backend:&'a mut B,
)->impl FnMut(&Value)->Result<Value,String>+'a{
    move |body|workspace_control(backend,body)
}
