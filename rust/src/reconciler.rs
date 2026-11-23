// Head-to-head Phase1 port: src/reconciler.ts
// One Job Graph coordinator. Each pass builds a single candidate SQLite
// snapshot plus post-commit effect intents; native Store CAS must persist
// before launching Workers or merging Git. No second lifecycle policy.
use crate::{
    dag_task_runtime::{discover_dag_script,reconcile_dag_schedule,unified_dag},
    events::{event_for,random_uuid},
    final_review_role::is_final_review_agent,
    job_execution_slot::job_has_conflicting_execution,
    local_merge_lock::iso8601_now,
    execution_process_tracker::reclaim_stale_execution_process,
    route_outcome_recording::{
        record_launch_route_outcome_jsonl, record_watchdog_route_outcome_jsonl,
    },
    workflow_effect_failures::{apply_job_effect_outcomes,apply_task_effect_outcomes,
        WorkflowEffectOutcome},
    planner::{create_plan_round,pending_plan},
    planner_recovery::create_failed_plan_recovery,
    reconciler_review::{
        ensure_final_review,invalidate_stale_review,route_reviewer,
        ReviewSnapshot,
    },
    reconciler_runtime::{ReconcilerRuntime,RuntimeEffect},
    review_revision_execution::{
        reconcile_review_revision_facts,revision_request_ready,
    },
    review_revision_settlement::settle_review_revision_round,
    runtime_status::implementation_complete,
    task_actions::apply_task_retry_action,
    task_transitions::{refresh_task_dependencies,try_transition_task_event,
        transition_task_event,transition_job_event},
    troubleshooter::{
        exhausted_troubleshooter_recoveries,pending_troubleshooter_reopens,
        pending_troubleshooter_retries,pending_troubleshooter_tasks,
        refresh_troubleshooter_input,
    },
    troubleshooter_fallback::{
        fallback_failed_troubleshooters,exhausted_troubleshooter_escalations,
    },
    workflow::{
        contracts::workflow_effect_policy,
        job_reconcile_v2::decide_job_reconcile,
        planner_orchestration_v2::{
            decide_planner_orchestration,planner_orchestration_facts,
        },
        task_reconcile::dependency_ready,
    },
};
use chrono::{DateTime,Utc};
use serde_json::{json,Value};
use std::{
    cell::RefCell,rc::Rc,
    collections::{HashMap,HashSet},
    path::{Path,PathBuf},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks<'a>(v:&'a Value)->&'a [Value]{
    v.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn plans<'a>(v:&'a Value)->&'a [Value]{
    v.get("plans").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn active(job:&Value)->bool{field(job,"state")=="ACTIVE"}
fn graph_action(decision:&Value,action:&str)->bool{
    decision.get("accepted")==Some(&Value::Bool(true))
        &&decision.get("actions").and_then(Value::as_array)
            .is_some_and(|actions|actions.iter().any(|entry|
                entry.as_str()==Some(action) || field(entry,"id")==action))
}
fn priority(task:&Value,job:&Value)->u8{
    let name=task.get("priority").and_then(Value::as_str)
        .or_else(||job.get("priority").and_then(Value::as_str))
        .unwrap_or("P2");
    match name{"P0"=>0,"P1"=>1,"P3"=>3,_=>2}
}
pub fn compare_task_priority(
    a:&Value,b:&Value,job:&Value,
)->std::cmp::Ordering{
    priority(a,job).cmp(&priority(b,job))
        .then_with(||field(a,"createdAt").cmp(field(b,"createdAt")))
        .then_with(||field(a,"id").cmp(field(b,"id")))
}
#[derive(Clone,Debug)]
pub struct ReconcileResult {
    pub job:Value,
    pub events:Vec<Value>,
    pub effects:Vec<Value>,
    pub cancel_generations:Vec<String>,
    pub changed:bool,
}
impl ReconcileResult{
    fn new(job:&Value)->Self{
        Self{job:job.clone(),events:Vec::new(),
            effects:Vec::new(),cancel_generations:Vec::new(),
            changed:false}
    }
    fn merge_review(&mut self,review:ReviewSnapshot){
        if self.job!=review.job{self.changed=true;}
        self.job=review.job;
        self.events.extend(review.events);
        self.cancel_generations.extend(review.cancel_execution_ids);
    }
}
pub struct Reconciler{
    pub graph_directory:PathBuf,
    pub store_directory:PathBuf,
    pub profile_home:PathBuf,
    pub policy_path:PathBuf,
    pub rules_path:PathBuf,
    pub options:Value,
    pub runtime:ReconcilerRuntime,
    reconciling:HashSet<String>,
}
impl Reconciler{
    /// Node Reconciler.reconcile core durable pass: one read, canonical
    /// Graph planner/review/DAG/Job decisions, fenced SQLite write, then
    /// observable events and selected external effects. Any CAS rejection
    /// stops execution before launching new workers.
    /// The expired generation is verified against the *current* Job and the
    /// exact recorded POSIX identity before any Graph mutation. A stale
    /// candidate cannot overwrite a replacement execution: every recovery
    /// Task transition is committed through an authoritative whole-Job CAS.
    /// Reconcile a local Worker only after its exact registered POSIX process
    /// generation is gone. No lease, deadline or time-based eviction exists.
    /// Remote browser/thread Workers settle through their own session events.
    fn recover_exited_processes<P:crate::reconciler_durable::ReconcileHost>(
        &mut self,job_id:&str,host:&mut P,
    )->Result<(),String>{
        let initial=host.load(job_id)?;
        if !active(&initial)||initial.get("pause").is_some_and(|v|!v.is_null()){
            return Ok(());
        }
        for stale in tasks(&initial).iter().filter(|task|
            matches!(field(task,"adapter"),"codex"|"script")
            &&matches!(field(task,"state"),"RUNNING"|"QUEUED")
            &&!field(task,"executionId").is_empty()
            &&field(task,"kind")!="planner"){
            let task_id=field(stale,"id");
            let fresh=host.load(job_id)?;
            let Some(index)=tasks(&fresh).iter().position(|task|
                field(task,"id")==task_id)else{continue;};
            let current=&fresh["tasks"][index];
            if field(current,"executionId")!=field(stale,"executionId")
                ||!matches!(field(current,"state"),"RUNNING"|"QUEUED"){
                continue;
            }
            let exited={
                let future=reclaim_stale_execution_process(current,|j,t,e|{
                    std::future::ready(host.load_execution_process(&j,&t,&e))
                });
                let mut future=std::pin::pin!(future);
                let mut context=std::task::Context::from_waker(std::task::Waker::noop());
                match std::future::Future::poll(future.as_mut(),&mut context){
                    std::task::Poll::Ready(result)=>result?,
                    std::task::Poll::Pending=>return Err(
                        "Local process inspection unexpectedly suspended".into()),
                }
            };
            if !exited{continue;}
            // The immutable executionId is the CAS fence; a late event from
            // the old process cannot mutate a new generation.
            let mut candidate=fresh.clone();
            let task=&mut candidate["tasks"][index];
            let decision=try_transition_task_event(&self.graph_directory,
                task,"process.exited",&json!({}),&iso8601_now())?;
            if decision.get("accepted")!=Some(&Value::Bool(true)){
                continue;
            }
            let parent=task.get("parentTaskId").and_then(Value::as_str)
                .map(str::to_owned);
            let execution_id=field(stale,"executionId").to_owned();
            let error="Local Worker process exited without a verified terminal event";
            host.persist(job_id,&fresh,&candidate)?;
            record_watchdog_route_outcome_jsonl(&self.decision_audit_path(),
                &candidate["tasks"][index],&json!({
                    "executionId":execution_id,"failedExit":true,
                    "rawError":error,"failureReason":"process_exited",
                    "failureMessage":error,"exitCode":null,
                }));
            self.runtime.cancel_execution_generation(job_id,task_id,&execution_id);
            host.broadcast(&event_for(job_id,task_id,parent.as_deref(),
                "task.failed","failed",error,Some("user"),
                Some(json!({"reason":"process_exited","executionId":execution_id})),None))?;
        }
        Ok(())
    }
    pub fn reconcile<P:crate::reconciler_durable::ReconcileHost>(
        &mut self,job_id:&str,verified_head:Option<&str>,
        project:&Path,roots:&Value,adapters:&[Value],registered:&[Value],
        usage:Option<&Value>,host:&mut P,
    )->Result<Value,String>{
        // Match Node reconcile() ordering: replay pending human escalation
        // notices through the durable retry ledger before selecting any new
        // Task/Planner effects. Failed or missing channels cannot masquerade
        // as delivered human approval.
        host.deliver_pending_escalations(job_id)?;
        self.recover_exited_processes(job_id,host)?;
        let before=host.load(job_id)?;
        let outcome=self.reconcile_snapshot(&before,verified_head,
            project,roots,adapters,registered,usage)?;
        let mut after=if outcome.changed{
            host.persist(job_id,&before,&outcome.job)?
        }else{before.clone()};
        // Never publish before a successful SQLite commit. A transport
        // failure does not roll back the transaction, but remains visible to
        // the caller so the durable outbox can retry the observation.
        for event in &outcome.events{host.broadcast(event)?;}
        // Original Node Reconciler escalates only AFTER a bounded alternate
        // model fallback has been applied. The Graph/SQLite host must own the
        // actual human gate; no effect is claimed from a candidate list.
        // Recheck exact durable state after each request because an external
        // provider or concurrent Reconciler can change that Task generation.
        let escalation_candidates=exhausted_troubleshooter_escalations(&after);
        for candidate in escalation_candidates{
            let id=field(&candidate,"taskId").to_string();
            if id.is_empty(){return Err("Troubleshooter escalation Task ID missing".into());}
            let latest=host.load(job_id)?;
            if !exhausted_troubleshooter_escalations(&latest).iter()
                .any(|entry|field(entry,"taskId")==id){continue;}
            host.request_troubleshooter_escalation(job_id,&id,&candidate)?;
            let committed=host.load(job_id)?;
            let recovery=tasks(&committed).iter().find(|task|field(task,"id")==id)
                .ok_or("Escalated Troubleshooter Task missing after SQLite commit")?;
            if recovery.get("escalation").is_none_or(Value::is_null)
                ||field(recovery,"state")!="BLOCKED"{
                return Err(format!(
                    "Escalation for Troubleshooter {id} was not durably committed"));
            }
            host.broadcast(&event_for(job_id,&id,None,"task.blocked",
                "blocked",&format!("Fallback exhausted: human action required for {id}"),
                Some("orchestrator"),None,None))?;
            after=committed;
        }
        // Lost/blocked generations are cancelled using exact execution IDs,
        // never process-name matching or a global kill operation.
        for generation in &outcome.cancel_generations{
            if let Some(task)=before.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().find(|task|
                    task.get("executionId").and_then(Value::as_str)
                        ==Some(generation.as_str())){
                self.runtime.cancel_execution_generation(job_id,
                    task.get("id").and_then(Value::as_str).unwrap_or(""),
                    generation);
            }
        }
        // The Node workflow-effects ledger coalesces duplicate effect
        // requests selected in the same reconciliation pass. Rust's actual
        // dispatch path may expose the same Graph effect more than once:
        // deduplicate by immutable Job/Task/transition before even calling
        // an owned external launcher, not after it has mutated SQLite.
        let mut seen_effects=HashSet::new();
        for action in &outcome.effects{
            let key=json!([action.get("action"),action.get("jobId"),
                action.get("taskId"),action.get("transitionKey")]).to_string();
            if !seen_effects.insert(key){continue;}
            let Err(error)=host.launch(action)else{continue;};
            let launch_error=error.clone();
            let effect=field(action,"action");
            // Unknown non-Graph effects (e.g. planner.launch) fail closed.
            // Only canonical Graph effect policy may classify a launch error.
            if workflow_effect_policy(effect).is_none(){return Err(error);}
            let key=action.get("idempotencyKey").and_then(Value::as_str)
                .or_else(||action.get("transitionKey").and_then(Value::as_str))
                .unwrap_or("");
            let failure=WorkflowEffectOutcome{
                effect:effect.into(),key:key.into(),status:"failed".into(),
                error:Some(error)
            };
            let latest=host.load(job_id)?;
            let task_id=field(action,"taskId");
            if !task_id.is_empty(){
                let original=tasks(&latest).iter()
                    .find(|task|field(task,"id")==task_id)
                    .ok_or("Effect failure Task missing from authoritative SQLite")?
                    .clone();
                let mut task=original.clone();
                let graph=self.graph_directory.clone();
                let job_id=job_id.to_string();
                let shared=Rc::new(RefCell::new(&mut *host));
                let save=Rc::clone(&shared);
                let events=Rc::clone(&shared);
                let failures=[failure];
                let future=apply_task_effect_outcomes(
                    &latest,&mut task,&failures,
                    move |mut candidate,event|{
                        let result=(||{
                            transition_task_event(&graph,&mut candidate,&event,
                                &json!({}),&iso8601_now())?;
                            let mut svc=save.borrow_mut();
                            let current=svc.load(&job_id)?;
                            let idx=tasks(&current).iter().position(|task|
                                field(task,"id")==field(&original,"id"))
                                .ok_or("Effect failure Task no longer exists")?;
                            if current["tasks"][idx]!=original{
                                return Err("Effect failure generation changed before SQLite CAS".into());
                            }
                            let mut updated=current.clone();
                            updated["tasks"][idx]=candidate.clone();
                            svc.persist(&job_id,&current,&updated)?;
                            Ok(candidate)
                        })();
                        std::future::ready(result)
                    },
                    move |event|{
                        std::future::ready(events.borrow_mut().broadcast(&event))
                    },
                );
                let mut future=std::pin::pin!(future);
                let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
                match std::future::Future::poll(future.as_mut(),&mut ctx){
                    std::task::Poll::Ready(result)=>result?,
                    std::task::Poll::Pending=>return Err(
                        "Native Task effect failure recording unexpectedly suspended".into()),
                }
            }else{
                let graph=self.graph_directory.clone();
                let job_id=job_id.to_string();
                let shared=Rc::new(RefCell::new(&mut *host));
                let save=Rc::clone(&shared);
                let events=Rc::clone(&shared);
                let mut current=latest.clone();
                let expected_latest=latest.clone();
                let failures=[failure];
                let future=apply_job_effect_outcomes(
                    &mut current,&failures,
                    move |mut candidate,event|{
                        let result=(||{
                            transition_job_event(&graph,&mut candidate,&event,
                                &json!({}),&iso8601_now())?;
                            let mut svc=save.borrow_mut();
                            let fresh=svc.load(&job_id)?;
                            if fresh!=expected_latest{
                                return Err("Effect failure Job generation changed before SQLite CAS".into());
                            }
                            svc.persist(&job_id,&fresh,&candidate)?;
                            Ok(candidate)
                        })();
                        std::future::ready(result)
                    },
                    move |event|{
                        std::future::ready(events.borrow_mut().broadcast(&event))
                    },
                );
                let mut future=std::pin::pin!(future);
                let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
                match std::future::Future::poll(future.as_mut(),&mut ctx){
                    std::task::Poll::Ready(result)=>result?,
                    std::task::Poll::Pending=>return Err(
                        "Native Job effect failure recording unexpectedly suspended".into()),
                }
            }
            after=host.load(job_id)?;
            if effect=="effect.launchTask"&&!task_id.is_empty(){
                let original=tasks(&latest).iter().find(|task|
                    field(task,"id")==task_id);
                let current=tasks(&after).iter().find(|task|
                    field(task,"id")==task_id);
                if let (Some(before),Some(task))=(original,current){
                    if field(before,"state")!="FAILED"
                        &&field(task,"state")=="FAILED"
                        &&task.get("error").and_then(Value::as_str)
                            ==Some(launch_error.as_str()){
                        let audit_path=self.decision_audit_path();
                        record_launch_route_outcome_jsonl(
                            &audit_path,task,&launch_error,"launch",
                            before.get("executionId").and_then(Value::as_str),false);
                    }
                }
            }
        }
        Ok(after)
    }
    /// Isolated hosts write beneath their own fixture store. A production
    /// daemon may select an explicit audited location in immutable options.
    fn decision_audit_path(&self)->PathBuf{
        if let Some(path)=self.options.get("decisionAuditPath")
            .and_then(Value::as_str).filter(|path|!path.is_empty()){
            return PathBuf::from(path);
        }
        let root=if self.store_directory.file_name()
            .is_some_and(|name|name=="stores"){
            self.store_directory.parent().unwrap_or(&self.store_directory)
        }else{&self.store_directory};
        root.join("decision-audit.jsonl")
    }
    pub fn new(graph_directory:impl Into<PathBuf>,
        store_directory:impl Into<PathBuf>,profile_home:impl Into<PathBuf>,
        policy_path:impl Into<PathBuf>,rules_path:impl Into<PathBuf>,
        options:Value)->Self{
        let owner=field(&options,"owner").to_string();
        let grace=options.get("postExitTerminalGraceMs")
            .and_then(Value::as_i64).unwrap_or(15_000);
        Self{graph_directory:graph_directory.into(),
            store_directory:store_directory.into(),
            profile_home:profile_home.into(),
            policy_path:policy_path.into(),rules_path:rules_path.into(),
            options,runtime:ReconcilerRuntime::new(owner),
            reconciling:HashSet::new()}
    }
    fn event(&self,job:&Value,task:&Value,
        kind:&str,status:&str,message:&str,data:Value)->Value{
        event_for(field(job,"id"),field(task,"id"),
            task.get("parentTaskId").and_then(Value::as_str),
            kind,status,message,Some("orchestrator"),
            Some(data),Some(json!({"agent":"relay","component":"agents-relay"})))
    }
    fn reconcile_troubleshooters(&self,result:&mut ReconcileResult)
        ->Result<(),String>{
        let reopened=pending_troubleshooter_reopens(&result.job);
        for entry in reopened{
            let original=&entry["original"];
            let recovery=&entry["recovery"];
            let Some(index)=tasks(&result.job).iter().position(|task|
                task.get("id")==recovery.get("id"))else{continue;};
            let mut current=result.job["tasks"][index].clone();
            let decision=try_transition_task_event(
                &self.graph_directory,&mut current,"recovery.reopen",
                &json!({"troubleshooterRecovery":true}),&iso8601_now())?;
            if decision.get("accepted")!=Some(&Value::Bool(true)){continue;}
            refresh_troubleshooter_input(&result.job,original,&mut current);
            result.job["tasks"][index]=current.clone();
            result.events.push(self.event(&result.job,&current,
                "troubleshooter.reopened","queued",
                &format!("Reusing Troubleshooter {} for Task {} attempt {}",
                    field(recovery,"id"),field(original,"id"),
                    original.get("attempt").and_then(Value::as_u64).unwrap_or(0)),
                json!({"originalTaskId":original.get("id"),
                    "attempt":original.get("attempt")})));
        }
        let new=pending_troubleshooter_tasks(
            &self.graph_directory,&self.store_directory,&result.job)?;
        for task in new{
            result.events.push(self.event(&result.job,&task,
                "troubleshooter.created","queued",
                &format!("Troubleshooter Task {} created",field(&task,"id")),
                json!({"agentName":"troubleshooter",
                    "originalTaskId":task.get("parentTaskId")})));
            result.job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job Task array missing")?.push(task);
        }
        for pair in pending_troubleshooter_retries(&result.job){
            let id=field(&pair["recovery"],"id");
            let Some(index)=tasks(&result.job).iter().position(|t|
                field(t,"id")==id)else{continue;};
            let mut task=result.job["tasks"][index].clone();
            apply_task_retry_action(&self.graph_directory,&mut task,false,
                &iso8601_now())?;
            if let Some(map)=task.as_object_mut(){
                map.remove("routing");map.remove("workerSelection");
            }
            result.events.push(self.event(&result.job,&task,
                "troubleshooter.retry_queued","queued",
                &format!("Retrying failed Troubleshooter {id}"),
                json!({"originalTaskId":pair["original"].get("id"),
                    "attempt":task.get("attempt"),"maxAttempts":task.get("maxAttempts")})));
            result.job["tasks"][index]=task;
        }
        // Node Reconciler invokes fallbackFailedTroubleshooters AFTER normal
        // Troubleshooter retry admission and BEFORE human escalation. A
        // failed provider/runtime may get one Graph-authorized config-default
        // attempt, then this exact candidate is no longer escalation-eligible.
        // All changes are still speculative until Reconciler's SQLite CAS.
        let fallback_queued=fallback_failed_troubleshooters(
            &self.graph_directory,&mut result.job)?;
        for id in fallback_queued{
            let task=tasks(&result.job).iter().find(|task|field(task,"id")==id)
                .ok_or("Fallback queued Task missing from candidate")?;
            result.events.push(self.event(&result.job,task,
                "troubleshooter.retry_queued","queued",
                &format!("Alternate model fallback scheduled for {id}"),
                json!({})));
        }
        // Node runs human escalation before the generic "recovery exhausted"
        // bookkeeping. When a human gate will be created, the recovery
        // becomes BLOCKED and is no longer a FAILED recovery to record.
        // Do not publish a false independent terminal failure first.
        let pending_human=exhausted_troubleshooter_escalations(&result.job)
            .into_iter().filter_map(|entry|entry.get("taskId")
                .and_then(Value::as_str).map(str::to_string))
            .collect::<HashSet<_>>();
        let exhausted=exhausted_troubleshooter_recoveries(&result.job);
        for entry in exhausted{
            let original=field(&entry["original"],"id");
            let recovery=field(&entry["recovery"],"id");
            if pending_human.contains(recovery){continue;}
            let reason=field(&entry,"reason");
            let record=json!({"taskId":original,
                "recoveryTaskId":recovery,"reason":reason,"at":iso8601_now()});
            if let Some(records)=result.job.get_mut("recoveryFailures")
                .and_then(Value::as_array_mut){records.push(record);}
            else{result.job["recoveryFailures"]=json!([record]);}
            result.events.push(event_for(field(&result.job,"id"),recovery,
                Some(original),"recovery.exhausted","failed",
                &format!("Recovery exhausted for {original}: {reason}"),
                Some("user"),Some(entry.clone()),None));
        }
        Ok(())
    }
    fn reconcile_planner(&self,result:&mut ReconcileResult)
        ->Result<(),String>{
        if !active(&result.job){return Ok(());}
        let pending=pending_plan(&result.job);
        let recoverable=pending.as_ref().is_some_and(|p|
            !self.runtime.planner_live.contains_key(field(p,"id")));
        let facts=planner_orchestration_facts(&result.job,recoverable);
        let decision=decide_planner_orchestration(
            &self.graph_directory,&facts)?;
        if decision.get("accepted")!=Some(&Value::Bool(true)){
            return Ok(());
        }
        if graph_action(&decision,"planner.recoverPending"){
            if let Some(plan)=pending.as_ref(){
                result.effects.push(json!({"action":"planner.recoverPending",
                    "jobId":result.job.get("id"),"planId":plan.get("id")}));
            }
        }
        if graph_action(&decision,"planner.createRecovery"){
            let failed=plans(&result.job).iter().rev().find(|p|
                field(p,"status")=="FAILED")
                .ok_or("Planner Graph selected recovery without a FAILED Plan")?;
            let recovered=create_failed_plan_recovery(
                &self.graph_directory,&self.store_directory,&result.job,failed)?;
            if !tasks(&result.job).iter().any(|t|t.get("id")==recovered.get("id")){
                result.events.push(self.event(&result.job,&recovered,
                    "troubleshooter.created","queued",
                    "Troubleshooter recovery created for FAILED Plan",
                    json!({"planId":failed.get("id")})));
                result.job.get_mut("tasks").and_then(Value::as_array_mut)
                    .ok_or("Job Tasks missing")?.push(recovered);
            }
        }
        if graph_action(&decision,"planner.createRound"){
            let plan=create_plan_round(&self.graph_directory,&result.job,
                None,false,Some(self.options.get("plannerTimeoutMs")
                    .and_then(Value::as_u64).unwrap_or(900_000)),None)?;
            let id=field(&plan,"id");
            if let Some(rounds)=result.job.get_mut("plans")
                .and_then(Value::as_array_mut){rounds.push(plan.clone());}
            else{result.job["plans"]=json!([plan.clone()]);}
            result.events.push(event_for(field(&result.job,"id"),id,None,
                "planner.created","queued",
                &format!("Plan {id} created"),
                Some("orchestrator"),None,None));
            result.effects.push(json!({"action":"planner.launch",
                "jobId":result.job.get("id"),"planId":id}));
        }
        Ok(())
    }
    fn reconcile_tasks(&self,result:&mut ReconcileResult,
        project:&Path,roots:&Value,
    )->Result<(),String>{
        let now=iso8601_now();
        refresh_task_dependencies(
            &self.graph_directory,&mut result.job,&now)?;
        let _=reconcile_review_revision_facts(
            &self.graph_directory,&mut result.job)?;
        // Dependency revision creation must use a SQLite-backed numeric ID
        // allocator with a committed CAS. The daemon performs that mutation
        // before constructing this speculative Graph snapshot; never swallow
        // a missing-ID error or create a child with an ephemeral ID here.
        let updated=reconcile_dag_schedule(
            &self.graph_directory,&self.store_directory,&result.job,
            project,roots,|agent,project,roots|
                discover_dag_script(agent,project,roots))?;
        result.job=updated;
        refresh_task_dependencies(&self.graph_directory,&mut result.job,
            &iso8601_now())?;
        Ok(())
    }
    fn dispatch_tasks(&self,result:&mut ReconcileResult)
        ->Result<(),String>{
        if !active(&result.job)||result.job.get("pause")
            .is_some_and(|v|!v.is_null()){return Ok(());}
        let job=result.job.clone();
        let map=tasks(&job).iter().map(|task|(
            field(task,"id").to_string(),task.clone()))
            .collect::<HashMap<_,_>>();
        let mut ready=tasks(&job).iter().filter(|task|
            !unified_dag(&job,task)
            &&revision_request_ready(&job,task)
            &&field(task,"state")=="QUEUED"
            &&task.get("executionId").is_none_or(Value::is_null)
            &&field(task,"kind")!="planner"
            &&field(task,"adapter")!="orchestrator"
            &&dependency_ready(task,&map)
            &&!job_has_conflicting_execution(&job,task))
            .cloned().collect::<Vec<_>>();
        ready.sort_by(|a,b|compare_task_priority(a,b,&job));
        let capacity=self.options.get("maxConcurrent").and_then(Value::as_u64)
            .unwrap_or(4) as usize;
        let remaining=capacity.saturating_sub(self.runtime.live.len()
            +self.runtime.planner_live.len());
        let first_dag=ready.first()
            .and_then(|t|t.pointer("/dagNode/parentTaskId"))
            .and_then(Value::as_str).map(str::to_owned);
        if let Some(parent)=first_dag{
            ready.retain(|t|t.pointer("/dagNode/parentTaskId")
                .and_then(Value::as_str)==Some(&parent));
        }else{ready.truncate(1);}
        ready.truncate(remaining);
        for task in ready{
            let Some(idx)=tasks(&result.job).iter().position(|candidate|
                candidate.get("id")==task.get("id"))else{continue;};
            let mut candidate=result.job["tasks"][idx].clone();
            let decision=try_transition_task_event(
                &self.graph_directory,&mut candidate,
                "dispatch",&json!({"dispatchable":true}),&iso8601_now())?;
            if !graph_action(&decision,"effect.launchTask"){
                continue;
            }
            result.job["tasks"][idx]=candidate.clone();
            result.effects.push(json!({"action":"effect.launchTask",
                "jobId":job.get("id"),"taskId":task.get("id"),
                "transitionKey":format!("dispatch:{}",
                    task.get("attempt").and_then(Value::as_u64).unwrap_or(0)),
                "data":{"attempt":task.get("attempt"),
                    "reviewInvocationId":task.pointer("/interactiveInvocation/invocationId")}}));
        }
        Ok(())
    }
    pub fn claim_task_execution(
        &mut self,job:&Value,task_id:&str,
    )->Result<Option<Value>,String>{
        let Some(task)=tasks(job).iter().find(|t|field(t,"id")==task_id)
            .cloned() else{return Ok(None);};
        if !active(job)||job.get("pause").is_some_and(|v|!v.is_null())
            ||field(&task,"state")!="QUEUED"
            ||task.get("executionId").is_some_and(|v|!v.is_null())
            ||!revision_request_ready(job,&task)
            ||job_has_conflicting_execution(job,&task){
            return Ok(None);
        }
        if matches!(field(&task,"adapter"),"codex"|"chatgpt"|"z")
            &&task.get("routing").is_none_or(Value::is_null){
            return Err(format!("Task {task_id} requires routing metadata before launch"));
        }
        let mut candidate=job.clone();
        let index=tasks(&candidate).iter().position(|t|field(t,"id")==task_id)
            .ok_or("Task vanished")?;
        let execution_id=random_uuid();
        let next=&mut candidate["tasks"][index];
        next["attempt"]=json!(next.get("attempt").and_then(Value::as_u64)
            .unwrap_or(0)+1);
        next["executionId"]=json!(execution_id);
        for key in ["lastProgressAt","lastProgressEventAt","processExitedAt"]{
            if let Some(map)=next.as_object_mut(){map.remove(key);}
        }
        let mut history=next.get("executionHistory").and_then(Value::as_array)
            .cloned().unwrap_or_default();
        history.push(json!({"id":execution_id,
            "attempt":next.get("attempt"),"startedAt":iso8601_now()}));
        if history.len()>8{history.drain(..history.len()-8);}
        next["executionHistory"]=json!(history);
        Ok(Some(candidate))
    }
    /// One serial reconciliation pass. The caller retries the complete pass
    /// on a SQLite generation conflict; never persist stale whole Job state.
    pub fn reconcile_snapshot(
        &mut self,job:&Value,verified_head:Option<&str>,
        project:&Path,roots:&Value,adapters:&[Value],
        registered:&[Value],usage:Option<&Value>,
    )->Result<ReconcileResult,String>{
        let job_id=field(job,"id").to_string();
        if !self.reconciling.insert(job_id.clone()){
            return Ok(ReconcileResult::new(job));
        }
        let result=(||{
            let mut result=ReconcileResult::new(job);
            let head=verified_head.filter(|s|!s.is_empty())
                .or_else(||job.get("headSha").and_then(Value::as_str));
            if let Some(head)=head.filter(|s|job.get("headSha")
                .and_then(Value::as_str)!=Some(*s)){
                result.job["headSha"]=json!(head);
                if result.job.pointer("/localMerge/status")
                    .and_then(Value::as_str)!=Some("succeeded")
                    &&result.job.get("localMerge").is_some_and(|v|!v.is_null()){
                    result.job["localMerge"]["sourceSha"]=Value::Null;
                    result.job["localMerge"]["status"]=json!("pending");
                    result.job["localMerge"]["attempts"]=json!(0);
                }
                result.job["updatedAt"]=json!(iso8601_now());
            }
            let stale=invalidate_stale_review(&self.graph_directory,
                &result.job,head)?;
            result.merge_review(stale);
            if result.job.get("pause").is_some_and(|v|!v.is_null()){
                for task in tasks(&result.job){
                    if task.get("pausedExecution").is_some_and(|v|!v.is_null()){
                        if let Some(id)=task.get("executionId").and_then(Value::as_str){
                            result.cancel_generations.push(id.into());
                        }
                    }
                }
                result.changed|=result.job!=*job;
                return Ok(result);
            }
            if !active(&result.job){
                result.changed|=result.job!=*job;
                return Ok(result);
            }
            for task in tasks(&result.job){
                if field(task,"state")=="BLOCKED"{
                    if let Some(execution)=task.get("executionId")
                        .and_then(Value::as_str){
                        result.cancel_generations.push(execution.into());
                    }
                }
            }
            self.reconcile_troubleshooters(&mut result)?;
            self.reconcile_tasks(&mut result,project,roots)?;
            // Route correlated Final Review findings BEFORE the Planner Graph.
            // Fully owned feedback becomes a targeted Revision of existing
            // Implementation work. Unowned feedback stays with Re-Planner.
            let routed=crate::review_ownership::route_review_ownership(
                &self.graph_directory,&self.store_directory,&mut result.job)?;
            for decision in routed{
                result.events.push(event_for(field(&result.job,"id"),
                    field(&decision,"revisionTaskId"),None,
                    "review.ownership_assigned","queued",
                    "Final Review finding assigned to original Task",
                    Some("orchestrator"),Some(decision.clone()),None));
            }
            let reviewer_options=self.options.get("reviewer").cloned()
                .unwrap_or(json!({}));
            let need_review=crate::reconciler_review::review_facts(
                &self.graph_directory,&result.job,head)?;
            let review_route=if need_review.get("reviewWorkSettled")
                ==Some(&Value::Bool(true))&&head.is_some(){
                route_reviewer(&self.graph_directory,&result.job,&self.options,
                    adapters,registered,usage,&self.profile_home,
                    &self.policy_path,&self.rules_path).ok()
            }else{None};
            let review=ensure_final_review(&self.graph_directory,
                &self.store_directory,&result.job,head,
                review_route.as_ref(),&reviewer_options)?;
            result.merge_review(review);
            self.reconcile_planner(&mut result)?;
            self.reconcile_tasks(&mut result,project,roots)?;
            self.dispatch_tasks(&mut result)?;
            // Review may become eligible only after the last Worker result
            // or the DAG schedule has settled.
            let second=ensure_final_review(&self.graph_directory,
                &self.store_directory,&result.job,head,
                review_route.as_ref(),&reviewer_options)?;
            result.merge_review(second);
            self.dispatch_tasks(&mut result)?;
            let facts=json!({"jobActive":true,
                "implementationComplete":implementation_complete(&result.job),
                "headAvailable":head.is_some_and(|s|!s.is_empty()),
                "deliveryReady":result.job.pointer("/localMerge/status")
                    .and_then(Value::as_str)==Some("succeeded")});
            let decision=decide_job_reconcile(&self.graph_directory,
                &result.job,&facts)?;
            if decision.get("accepted")==Some(&Value::Bool(true)){
                for action in decision.get("actions").and_then(Value::as_array)
                    .into_iter().flatten(){
                    if let Some(id)=action.get("id").and_then(Value::as_str){
                        result.effects.push(json!({"action":id,
                            "jobId":job_id,"transitionKey":format!(
                                "reconcile:{}",head.unwrap_or("no-head")),
                            "data":{"headSha":head}}));
                    }
                }
            }
            result.changed=result.changed||result.job!=*job;
            Ok(result)
        })();
        self.reconciling.remove(&job_id);
        result
    }
    /// Apply the CLI Planner proposal through the existing Graph and
    /// SQLite generation-fenced commit; read back the accepted durable Plan.
    pub fn apply_planner_tree<P:crate::planner_runtime_public::PlannerFinishPorts>(
        &mut self,ports:&mut P,job_id:&str,plan_id:&str,
        execution_id:&str,proposal:&Value,
    )->Result<Value,String>{
        let candidate=crate::planner::parse_planner_result(proposal)
            .map_err(|cause|crate::planner_runtime::PlannerApplyValidationError::new(
                "candidate",vec![cause,
                    "Correct the candidate and retry plan apply with the same active Planner execution.".into()],
                None).to_string())?;
        crate::planner_runtime_public::finish_planner(ports,
            &self.graph_directory,job_id,plan_id,Some(execution_id),
            None,Some(&candidate),true)?;
        let committed=ports.load(job_id)?;
        let current=committed.get("plans").and_then(Value::as_array)
            .into_iter().flatten().find(|entry|field(entry,"id")==plan_id);
        match current{
            Some(plan) if field(plan,"status")=="SUCCEEDED"=>Ok(plan.clone()),
            _=>Err(format!("Plan {plan_id} was not committed")),
        }
    }
    /// Node Reconciler.planJob: native Graph and generation-checked SQLite
    /// mutation, with Planner launch and settlement owned by the host.
    pub async fn plan_job<Load,LFut,Mutate,Append,AFut,Save,SFut,Launch,PFut>(
        &mut self,job_id:&str,guidance:Option<&str>,force_restate:bool,
        has_atomic_store:bool,load:Load,mutate:Mutate,append_plan:Append,
        save_job:Save,launch:Launch,
    )->Result<(Value,Value),String>
    where
        Load:FnMut()->LFut,LFut:std::future::Future<Output=Result<Value,String>>,
        Mutate:FnMut(&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>,
        Append:FnMut(Value)->AFut,AFut:std::future::Future<Output=Result<(),String>>,
        Save:FnMut(Value)->SFut,SFut:std::future::Future<Output=Result<(),String>>,
        Launch:FnMut(Value,Value)->PFut,PFut:std::future::Future<Output=Result<(),String>>,
    {
        let timeout=self.options.get("plannerTimeoutMs")
            .and_then(Value::as_u64)
            .unwrap_or(crate::types::story_size_timeout_ms(crate::types::StorySize::M));
        crate::reconciler_manual_plan_public::plan_job(
            &self.graph_directory,job_id,guidance,force_restate,timeout,
            has_atomic_store,load,mutate,append_plan,save_job,launch).await
    }
    pub fn apply_event(&mut self,job:&Value,event:&Value,
        verified_head:Option<&str>)->Result<RuntimeEffect,String>{
        self.runtime.apply_event(&self.graph_directory,job,event,verified_head)
    }
    pub fn cancel_active_tasks(&mut self,job:&Value,reason:&str)
        ->Result<ReconcileResult,String>{
        let mut result=ReconcileResult::new(job);
        for idx in 0..tasks(&result.job).len(){
            let current=&result.job["tasks"][idx];
            if !matches!(field(current,"state"),"RUNNING"|"QUEUED"|"DRAFT"){
                continue;
            }
            let execution=field(current,"executionId").to_string();
            let mut candidate=current.clone();
            let decision=try_transition_task_event(
                &self.graph_directory,&mut candidate,
                "cancel",&json!({}),&iso8601_now())?;
            if decision.get("accepted")!=Some(&Value::Bool(true)){continue;}
            candidate["error"]=json!(reason);
            candidate["executionId"]=Value::Null;
            result.job["tasks"][idx]=candidate;
            if !execution.is_empty(){
                result.cancel_generations.push(execution);
            }
        }
        result.changed=result.job!=*job;
        Ok(result)
    }
}
