// Node src/planner-runtime.ts runtime orchestration over the canonical
// Planner / Job Graph and authoritative per-Job SQLite transaction. No
// secondary planner scheduler or invented terminal lifecycle states.
use crate::{
    events::event_for,
    force_restate_validation::{apply_planner_history_cleanup,
        force_restate_converged,objective_satisfied_for_review},
    local_merge_lock::iso8601_now,
    planner::{parse_planner_result,validate_planner_hierarchy,
        validate_planner_lifecycle_ownership,validate_planner_progress,
        validate_planner_resolution_materialization,materialize_planner_child},
    planner_agent_roles::validate_planner_agent_roles,
    planner_child::same_planner_child_definition,
    planner_runtime::{activate_committed_planner_work,PlannerApplyValidationError},
    planner_task_ids::assign_planner_task_ids,
    task_transitions::try_transition_task_event,
    workflow::{force_restate_validation_v2::decide_force_restate_validation,
        task_resolution::attach_resolution_ownership},
};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::path::{Path,PathBuf};

fn field<'a>(value:&'a Value,name:&str)->&'a str{
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn plan<'a>(job:&'a Value,plan_id:&str)->Option<&'a Value>{
    job.get("plans").and_then(Value::as_array)
        .into_iter().flatten().find(|plan|field(plan,"id")==plan_id)
}
fn fail(phase:&str,messages:Vec<String>)->String{
    PlannerApplyValidationError::new(phase,messages,None).to_string()
}
fn fingerprint(candidate:&Value)->String{
    let bytes=candidate.to_string();
    format!("{:x}",Sha256::digest(bytes.as_bytes()))
}
fn sorted(value:&Value)->Value{
    match value {
        Value::Array(items)=>Value::Array(items.iter().map(sorted).collect()),
        Value::Object(fields)=>{
            let mut keys=fields.keys().collect::<Vec<_>>();
            keys.sort_by(|a,b|a.to_lowercase().cmp(&b.to_lowercase())
                .then_with(||a.cmp(b)));
            let mut result=serde_json::Map::new();
            for key in keys{result.insert(key.to_owned(),sorted(&fields[key]));}
            Value::Object(result)
        },
        _=>value.clone()
    }
}
fn job_version(job:&Value)->String{
    let mut snapshot=job.clone();
    if let Some(map)=snapshot.as_object_mut(){map.remove("updatedAt");}
    fingerprint(&sorted(&snapshot))
}
fn graph_actions(decision:&Value,action:&str)->bool{
    decision.get("actions").and_then(Value::as_array)
        .into_iter().flatten().any(|entry|field(entry,"id")==action)
}
/// The Store and execution host own effects. `mutate` must run the callback
/// inside one authoritative SQLite BEGIN IMMEDIATE transaction, CAS the
/// candidate against the same local Job, and commit only on Ok.
pub trait PlannerFinishPorts {
    fn load(&mut self,job_id:&str)->Result<Value,String>;
    fn atomic_available(&self)->bool{true}
    fn mutate(&mut self,job_id:&str,
        callback:&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>;
    fn save_plan(&mut self,_plan:&Value)->Result<(),String>{
        Err("Store.savePlan unavailable".into())
    }
    fn execution_context(&mut self,job:&Value,plan:&Value)->Result<Value,String>;
    fn registered_workers(&mut self)->Result<Vec<Value>,String>{Ok(Vec::new())}
    fn emit(&mut self,event:&Value)->Result<(),String>;
    fn register_unblock(&mut self,_job_id:&str,_request:&Value)->Result<(),String>{
        Err("Blocker registration unavailable".into())
    }
    fn can_register_unblock(&self)->bool{false}
    fn reconcile(&mut self,job_id:&str,plan_id:&str,context:&str)
        ->Result<(),String>;
    /// The host tracks the follow-up operation and reports its failure
    /// without invalidating a successfully committed Planner candidate.
    fn detached_reconcile(&mut self,_job_id:&str,_plan_id:&str,_why:&str){}
    fn release_live(&mut self,plan_id:&str,execution_id:Option<&str>);
    fn has_live(&self,plan_id:&str,execution_id:Option<&str>)->bool;
    fn store_directory(&self)->&Path;
}

fn apply_candidate(
    graph:&Path,store_directory:&Path,initial:&Value,current:Value,
    current_plan:&Value,execution_id:Option<&str>,raw:&Value,
    normalized:&Value,context:&Value,workers:&[Value],now:&str,
)->Result<Value,String>{
    let plan_id=field(current_plan,"id");
    let fresh=plan(&current,plan_id);
    let actual=fresh.and_then(|p|p.get("executionId")).and_then(Value::as_str);
    let id_match=actual==execution_id;
    let status=fresh.map(|p|field(p,"status")).unwrap_or("missing");
    let plan_match=fresh.and_then(|p|p.get("updatedAt"))==current_plan.get("updatedAt");
    let version_match=job_version(initial)==job_version(&current);
    if status!="PLANNING"||!id_match||!plan_match||!version_match{
        let mut keys=initial.as_object().into_iter().flat_map(|m|m.keys())
            .chain(current.as_object().into_iter().flat_map(|m|m.keys()))
            .map(String::as_str).collect::<Vec<_>>();
        keys.sort();keys.dedup();
        let changed=keys.into_iter().filter(|key|*key!="updatedAt"
            &&initial.get(*key)!=current.get(*key)).collect::<Vec<_>>().join(",");
        return Err(PlannerApplyValidationError::new("fencing",vec![format!(
            "The Job or Planner execution changed while this candidate was being validated (plan={}, status={status}, execution={id_match}, planVersion={plan_match}, jobVersion={version_match}, changed={changed}). Refresh the Planner context and retry with the active execution.",
            fresh.is_some())],Some(status=="PLANNING"&&id_match)).to_string());
    }
    let Some(planned)=fresh else{return Err("Plan missing inside SQLite mutation".into())};
    let mut candidate=current.clone();
    let parsed=raw;
    let specs=normalized.get("next_tasks").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    let cleanup=normalized.get("history_cleanup").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    let force=planned.get("forceRestate")==Some(&Value::Bool(true));
    let history=if force{
        let ids=planned.get("restateTaskIds").and_then(Value::as_array)
            .into_iter().flatten().filter_map(Value::as_str)
            .map(str::to_owned).collect::<Vec<_>>();
        apply_planner_history_cleanup(&mut candidate,&ids,&cleanup,now,graph)?
    }else if !cleanup.is_empty(){
        json!({"valid":false,"issues":["history_cleanup is only allowed for a Force Restate Plan. Remove it and submit the Plan again."]})
    }else{json!({"valid":true})};
    if history["valid"]==true&&force{
        validate_planner_resolution_materialization(&candidate,&specs)
            .map_err(|err|fail("history_consistency",vec![err]))?;
    }
    let index=candidate["plans"].as_array().ok_or("Job Plans absent")?
        .iter().position(|p|field(p,"id")==plan_id)
        .ok_or("Plan disappeared")?;
    let generated=specs.iter().filter_map(|s|s.get("id"))
        .cloned().collect::<Vec<_>>();
    {
        let plan=&mut candidate["plans"][index];
        plan["status"]=json!("SUCCEEDED");
        plan["objectiveStatus"]=normalized.get("objective_status").cloned().unwrap_or(Value::Null);
        plan["plannerResult"]=normalized.clone();
        plan["appliedCandidateFingerprint"]=json!(fingerprint(parsed));
        plan["assessment"]=normalized.get("assessment").cloned().unwrap_or(Value::Null);
        plan["generatedTaskIds"]=json!(generated);
        if let Some(pending)=normalized.get("unblocks").and_then(Value::as_array)
            .filter(|p|!p.is_empty()){plan["pendingUnblocks"]=json!(pending);}
        else if let Some(object)=plan.as_object_mut(){object.remove("pendingUnblocks");}
        if let Some(object)=plan.as_object_mut(){
            object.remove("error");object.remove("retryFeedback");
        }
        plan["leaseOwner"]=Value::Null;
        plan["leaseExpiresAt"]=Value::Null;
        plan["executionId"]=Value::Null;
        if let Some(id)=execution_id{plan["appliedExecutionId"]=json!(id);}
        plan["updatedAt"]=json!(now);
    }
    if candidate.get("changeCycle").and_then(Value::as_object).is_some()
        &&candidate.pointer("/changeCycle/consumedByPlannerTaskId")
            .is_none_or(Value::is_null)
        &&candidate["plans"][index].pointer("/trigger/source")
            .and_then(Value::as_str)==Some("unblock"){
        candidate["changeCycle"]["consumedByPlannerTaskId"]=json!(plan_id);
    }
    let plan_for_child=candidate["plans"][index].clone();
    let mut children=Vec::new();
    for spec in &specs{
        let child=materialize_planner_child(graph,&candidate,&plan_for_child,spec,context)?;
        if let Some(resolution)=spec.get("resolution").filter(|v|!v.is_null()){
            attach_resolution_ownership(graph,&mut candidate,&child,
                resolution,&json!("planner"),now)?;
        }
        let current=candidate.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|entry|entry.get("id")==child.get("id"));
        if current.is_some_and(|existing|!same_planner_child_definition(existing,&child)){
            return Err(format!("Planner child {} already exists with a different definition",
                field(&child,"id")));
        }
        if current.is_none(){
            candidate.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job Tasks absent")?.push(child.clone());
        }
        children.push(child);
    }
    let consumed=plan_for_child.pointer("/trigger/taskIds")
        .filter(|_|plan_for_child.pointer("/trigger/source").and_then(Value::as_str)==Some("unblock"))
        .and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(tasks)=candidate.get_mut("tasks").and_then(Value::as_array_mut){
        for task in tasks{
            if !consumed.contains(&task["id"])||task.get("unblock").is_none()
                ||field(task,"state")=="CANCELLED"||generated.contains(&task["id"]){continue;}
            if try_transition_task_event(graph,task,"cancel",&json!({}),now)
                .is_ok_and(|decision|decision["accepted"]==true){
                task["error"]=json!(format!("Superseded by successful unblock plan {plan_id}"));
                task["leaseOwner"]=Value::Null;
                task["leaseExpiresAt"]=Value::Null;
                task["executionId"]=Value::Null;
            }
        }
    }
    activate_committed_planner_work(graph,&mut candidate,now)?;
    candidate["updatedAt"]=json!(now);
    let forward=force_restate_converged(&candidate,Some(plan_id),workers);
    let outcome=decide_force_restate_validation(graph,&json!({
        "forceRestateRequested":force,
        "historyConsistencyValid":history["valid"]==true,
        "normalHistoryMutationAbsent":!force&&cleanup.is_empty(),
        "forwardConvergenceValid":forward,
        "objectiveSatisfied":!force&&objective_satisfied_for_review(&candidate)
    }))?;
    if outcome["accepted"]!=true{
        return Err(fail("forward_convergence",vec![format!(
            "Plan Apply graph rejected the candidate: {}.",field(&outcome,"reason"))]));
    }
    if field(&outcome,"target")=="rejected"{
        let history_rejected=graph_actions(&outcome,"plan.apply.rejectHistory");
        let issues=if history_rejected&&history["valid"]==false{
            history["issues"].as_array().into_iter().flatten()
                .filter_map(Value::as_str).map(str::to_owned).collect()
        }else{vec![
            "The proposed Plan does not converge to executable, dependency-accounted work, an evidence-backed blocked Troubleshooter owned by this Plan, or a completed Job.".into(),
            "Add a queued/running Task with an eligible worker route, make each dependency path lead to eligible work, provide the Troubleshooter evidence and unblock conditions, or preserve verified completion.".into(),
            format!("Candidate work: {}. Eligible worker adapters: {}.",
                candidate["tasks"].as_array().into_iter().flatten()
                    .filter(|t|field(t,"kind")!="planner")
                    .map(|t|format!("{}:{}/{}",field(t,"id"),field(t,"state"),field(t,"adapter")))
                    .collect::<Vec<_>>().join("; "),
                {
                    let adapters=workers.iter().map(|w|field(w,"adapter"))
                        .filter(|s|!s.is_empty()).collect::<Vec<_>>();
                    if adapters.is_empty(){"(none)".into()}
                    else{adapters.join(", ")}
                })]};
        return Err(fail(if history_rejected{"history_consistency"}
            else{"forward_convergence"},issues));
    }
    if !graph_actions(&outcome,"plan.apply.commit"){
        return Err(fail("forward_convergence",vec![
            "The Plan Apply graph did not select the atomic commit action.".into()]));
    }
    let _=store_directory;
    Ok(candidate)
}

/// Node finishPlanner: exact lease idempotency, fail/retry and atomic Plan
/// success mutation, retaining cross-Job unblock intents for replay.
pub fn finish_planner<P:PlannerFinishPorts>(
    ports:&mut P,graph:&Path,job_id:&str,plan_id:&str,
    execution_id:Option<&str>,error:Option<&str>,raw:Option<&Value>,cli_apply:bool,
)->Result<(),String>{
    let initial=ports.load(job_id)?;
    let old=plan(&initial,plan_id).cloned();
    let release=|ports:&mut P|ports.release_live(plan_id,execution_id);
    if let (Some(existing),Some(raw))=(&old,raw){
        if field(existing,"status")=="SUCCEEDED"
            &&existing.get("appliedExecutionId").and_then(Value::as_str)==execution_id
            &&raw.get("cliApplied")!=Some(&Value::Bool(true)){
            let parsed=parse_planner_result(raw)?;
            if field(existing,"appliedCandidateFingerprint")!=fingerprint(&parsed){
                release(ports);
                return Err(format!("Plan {plan_id} already committed a different candidate for execution {}",
                    execution_id.unwrap_or("null")));
            }
            release(ports);return Ok(());
        }
    }
    let owned=old.as_ref().is_some_and(|current|{
        current.get("executionId").and_then(Value::as_str)==execution_id
            ||(raw.is_some_and(|v|v["cliApplied"]==true)
                &&field(current,"status")=="SUCCEEDED")
    });
    if !owned{
        release(ports);
        if cli_apply{return Err(format!(
            "Plan {plan_id} is not owned by this active execution"));}
        return Ok(())
    }
    let old=old.ok_or("Plan vanished unexpectedly")?;
    if raw.is_some_and(|v|v["cliApplied"]==true){
        if field(&old,"status")!="SUCCEEDED"{
            release(ports);
            return Err(format!("Planner reported CLI application, but Plan {plan_id} is {}",
                field(&old,"status")));
        }
        release(ports);return Ok(());
    }
    if let Some(message)=error{
        if cli_apply{return Err(message.into());}
        let mut applied=false;
        let mut retry=false;
        let mut mutation=|mut current:Value|{
            if let Some(fresh)=current.get_mut("plans").and_then(Value::as_array_mut)
                .and_then(|items|items.iter_mut().find(|item|field(item,"id")==plan_id)){
                if field(fresh,"status")=="PLANNING"
                    &&fresh.get("executionId").and_then(Value::as_str)==execution_id{
                    let attempt=fresh.get("attempt").and_then(Value::as_u64).unwrap_or(0);
                    let max=fresh.get("maxAttempts").and_then(Value::as_u64)
                        .unwrap_or(if fresh["manualPlanning"]==true{1}else{3});
                    retry=attempt<max&&!message.starts_with(
                        "Planner JSON correction failed after one retry:");
                    fresh["status"]=json!(if retry{"PLANNING"}else{"FAILED"});
                    fresh["retryFeedback"]=json!(message);
                    fresh["error"]=json!(message);
                    fresh["assessment"]=json!(format!("Planning {}: {message}",
                        if retry{"retry"}else{"failed"}));
                    fresh["leaseOwner"]=Value::Null;
                    fresh["leaseExpiresAt"]=Value::Null;
                    fresh["executionId"]=Value::Null;
                    fresh["updatedAt"]=json!(iso8601_now());
                    applied=true;
                }
            }
            Ok(current)
        };
        if ports.atomic_available(){ports.mutate(job_id,&mut mutation)?;}
        else{
            let mut fresh=ports.load(job_id)?;
            fresh=mutation(fresh)?;
            if applied{ports.save_plan(plan(&fresh,plan_id).ok_or("Plan missing")?)?;}
        }
        if applied{
            ports.emit(&event_for(job_id,plan_id,None,
                if retry{"planner.retry"}else{"planner.failed"},
                if retry{"queued"}else{"failed"},
                &format!("Planner {plan_id}: {message}"),Some("user"),None,None))?;
            if retry&&old["manualPlanning"]!=true{
                ports.reconcile(job_id,plan_id,"planner retry reconciliation")?;
                ports.detached_reconcile(job_id,plan_id,"planner retry reconciliation");
            }
        }
        release(ports);return Ok(())
    }
    let mut committed=false;
    let successful=(||{
        let raw=raw.ok_or("Planner result is missing")?;
        let parsed=parse_planner_result(raw)?;
        let task_ids=assign_planner_task_ids(&parsed,
            field(&initial,"repository"),job_id,plan_id,ports.store_directory())?;
        let specs=task_ids.get("next_tasks").and_then(Value::as_array)
            .cloned().unwrap_or_default();
        let ctx=ports.execution_context(&initial,&old)?;
        validate_planner_agent_roles(&specs)
            .map_err(|error|fail("candidate",vec![error]))?;
        validate_planner_hierarchy(&initial,&specs)?;
        if old["forceRestate"]!=true{
            validate_planner_resolution_materialization(&initial,&specs)?;
        }
        validate_planner_lifecycle_ownership(&initial,&specs)?;
        validate_planner_progress(&initial,&task_ids)?;
        if task_ids.get("unblocks").and_then(Value::as_array)
            .is_some_and(|unblocks|!unblocks.is_empty())&&!ports.can_register_unblock(){
            return Err("Durable store does not support Planner cross-Job unblock registration".into());
        }
        for spec in &specs{
            let child=materialize_planner_child(graph,&initial,&old,spec,&ctx)?;
            if initial.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().any(|entry|entry.get("id")==child.get("id")
                &&!same_planner_child_definition(entry,&child)){
                return Err(format!("Planner child {} already exists with a different definition",
                    field(&child,"id")));
            }
        }
        if !ports.atomic_available(){
            return Err("Plan apply requires one atomic durable SQLite mutation".into());
        }
        let workers=ports.registered_workers()?;
        let now=iso8601_now();
        let store_dir=ports.store_directory().to_path_buf();
        let mut mutation=|current:Value|{
            apply_candidate(graph,&store_dir,&initial,current,&old,
                execution_id,&parsed,&task_ids,&ctx,&workers,&now)
        };
        let _committed_job=ports.mutate(job_id,&mut mutation)?;
        committed=true;
        // Node drainPlannerUnblocks always re-reads the committed SQLite
        // Plan before acknowledging any external dependent registration.
        let refreshed=ports.load(job_id)?;
        let pending=plan(&refreshed,plan_id)
            .and_then(|p|p.get("pendingUnblocks")).and_then(Value::as_array)
            .cloned().unwrap_or_default();
        if !pending.is_empty()&&!ports.can_register_unblock(){
            return Err("Blocker registration unavailable".into());
        }
        let mut acknowledged=std::collections::HashSet::<String>::new();
        for request in &pending{
            if ports.register_unblock(job_id,request).is_ok(){
                acknowledged.insert(request.to_string());
            }
        }
        if !acknowledged.is_empty(){
            if !ports.atomic_available(){
                return Err("Atomic SQLite mutation is required to acknowledge planner unblocks".into());
            }
            let mut acknowledge=|mut current:Value|{
                let fresh=current.get_mut("plans").and_then(Value::as_array_mut)
                    .into_iter().flatten().find(|p|field(p,"id")==plan_id);
                if let Some(fresh)=fresh{
                    if let Some(items)=fresh.get("pendingUnblocks").and_then(Value::as_array){
                        if !items.is_empty(){
                            let remaining=items.iter().filter(|value|
                                !acknowledged.contains(&value.to_string()))
                                .cloned().collect::<Vec<_>>();
                            if remaining.is_empty(){
                                if let Some(map)=fresh.as_object_mut(){map.remove("pendingUnblocks");}
                            }else{fresh["pendingUnblocks"]=json!(remaining);}
                            fresh["updatedAt"]=json!(iso8601_now());
                        }
                    }
                }
                Ok(current)
            };
            ports.mutate(job_id,&mut acknowledge)?;
        }
        let missing=if pending.is_empty(){Vec::new()}else{
            let after_ack=ports.load(job_id)?;
            plan(&after_ack,plan_id)
                .and_then(|p|p.get("pendingUnblocks")).and_then(Value::as_array)
                .into_iter().flatten().map(|entry|format!("{}#{}:{}:{}",
                    field(entry,"repository"),
                    entry.get("prNumber").map(Value::to_string)
                        .unwrap_or_else(||"undefined".into()),
                    field(entry,"jobId"),field(entry,"taskId")))
                .collect::<Vec<_>>()
        };
        let status=field(&task_ids,"objective_status");
        ports.emit(&event_for(job_id,plan_id,None,"planner.completed","succeeded",
            &format!("Plan {plan_id} completed: {status}"),Some("orchestrator"),
            Some(json!({"objective_status":status,"pendingUnblocks":missing})),None))?;
        Ok::<(),String>(())
    })();
    match successful{
        Ok(())=>{
            release(ports);
            if old["manualPlanning"]!=true{
                ports.reconcile(job_id,plan_id,"planner follow-up reconciliation")?;
                ports.detached_reconcile(job_id,plan_id,"planner follow-up reconciliation");
            }
            Ok(())
        },
        Err(cause)=>{
            if committed {release(ports);return Err(cause);}
            let validation=if cause.contains("PLAN_APPLY_VALIDATION_FAILED"){
                cause
            }else{
                fail("candidate",vec![cause,
                    "Correct the candidate and retry plan apply with the same active Planner execution.".into()])
            };
            let retryable=!(validation.contains("\\\"phase\\\":\\\"fencing\\\"")
                &&validation.contains("\\\"retryable\\\":false"));
            if !(cli_apply&&retryable){release(ports);}
            Err(validation)
        }
    }
}
