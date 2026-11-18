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
    task_transitions::{refresh_task_dependencies,try_transition_task_event},
    troubleshooter::{
        exhausted_troubleshooter_recoveries,pending_troubleshooter_reopens,
        pending_troubleshooter_retries,pending_troubleshooter_tasks,
        refresh_troubleshooter_input,
    },
    workflow::{
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
            .is_some_and(|actions|actions.iter()
                .any(|entry|field(entry,"id")==action))
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
            options,runtime:ReconcilerRuntime::new(owner,grace),
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
        let exhausted=exhausted_troubleshooter_recoveries(&result.job);
        for entry in exhausted{
            let original=field(&entry["original"],"id");
            let recovery=field(&entry["recovery"],"id");
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
        let recoverable=pending.as_ref().is_some_and(|p|{
            let id=field(p,"id");
            !self.runtime.planner_live.contains_key(id)
                &&(field(p,"executionId").is_empty()
                    ||field(p,"leaseOwner")!=self.runtime.owner
                    ||p.get("leaseExpiresAt").and_then(Value::as_str)
                        .and_then(|raw|DateTime::parse_from_rfc3339(raw).ok())
                        .is_none_or(|date|date.timestamp_millis()
                            <=Utc::now().timestamp_millis()))
        });
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
        let mut reserved=Vec::new();
        let _=crate::dependency_revision_execution::
            reconcile_dependency_revision_facts(
                &self.graph_directory,&mut result.job,&reserved)?;
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
        &mut self,job:&Value,task_id:&str,lease_ms:u64,
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
        let now=Utc::now();
        let execution_id=random_uuid();
        let next=&mut candidate["tasks"][index];
        next["attempt"]=json!(next.get("attempt").and_then(Value::as_u64)
            .unwrap_or(0)+1);
        next["leaseOwner"]=json!(self.runtime.owner);
        next["leaseExpiresAt"]=json!((now+chrono::Duration::milliseconds(
            lease_ms.max(next.get("timeoutMs")
                .and_then(Value::as_u64).unwrap_or(0)) as i64)).to_rfc3339());
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
                return Ok(result);
            }
            if !active(&result.job){return Ok(result);}
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
    /// Node Reconciler.recoverLostExecutions delegates to the canonical
    /// generation-fenced lease recovery. Caller supplies authoritative SQLite
    /// loads, OS process-group reclamation, and Graph task persistence ports.
    pub async fn recover_lost_executions<Load,LFut,Reclaim,RFut,Recover,OFut>(
        &mut self,job:&Value,now_ms:i64,load:Load,reclaim:Reclaim,recover:Recover,
    )->Result<(),String>
    where
        Load:FnMut()->LFut, LFut:std::future::Future<Output=Result<Value,String>>,
        Reclaim:FnMut(Value)->RFut, RFut:std::future::Future<Output=Result<bool,String>>,
        Recover:FnMut(Value,String,String)->OFut,
        OFut:std::future::Future<Output=Result<(),String>>,
    {
        crate::execution_recovery::recover_expired_executions(
            job,now_ms,load,reclaim,recover).await
    }
    pub fn recover_startup_orphans(
        &mut self,job:&Value,now:i64,
    )->Vec<Value>{
        tasks(job).iter().filter(|task|{
            matches!(field(task,"state"),"RUNNING"|"QUEUED")
                &&!matches!(field(task,"adapter"),"chatgpt"|"z")
                &&field(task,"kind")!="planner"
                &&task.get("executionId").is_some_and(|v|!v.is_null())
                &&!field(task,"leaseOwner").is_empty()
                &&field(task,"leaseOwner")!=self.runtime.owner
                &&task.get("leaseExpiresAt").and_then(Value::as_str)
                    .and_then(|s|DateTime::parse_from_rfc3339(s).ok())
                    .is_some_and(|t|t.timestamp_millis()<=now)
        }).cloned().collect()
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
            candidate["leaseOwner"]=Value::Null;
            candidate["leaseExpiresAt"]=Value::Null;
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
