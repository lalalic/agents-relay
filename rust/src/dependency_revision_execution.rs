// Node provenance: src/dependency-revision-execution.ts. Reconcile semantic
// dependency evidence vectors through the canonical Dependency Revision Graph.
use crate::{
    final_review_role::is_final_review_agent,
    job_task_id_sequence::allocate_entity_id,
    relay_store::SQLiteRelayStore,
    local_merge_lock::iso8601_now,
    review_revision_model::{
        dependency_revision_vector, dependency_validity, same_dependency_revision_vector,
    },
    task_transitions::try_transition_task_event,
    workflow::{
        dependency_revision_v2::decide_dependency_revision,
        entity_creation::create_task_entity,
    },
};
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::path::Path;

fn string<'a>(value:&'a Value,key:&str)->&'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
fn tasks(job:&Value)->&[Value] {
    job.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn dependencies(task:&Value)->Vec<String> {
    task.get("dependencies").and_then(Value::as_array).into_iter().flatten()
        .filter_map(Value::as_str).map(str::to_owned).collect()
}
fn latest_direct_revision(job:&Value,original:&Value)->Option<Value> {
    tasks(job).iter()
        .filter(|task|task.pointer("/revision/originalTaskId")==original.get("id")
            && string(task,"state")=="SUCCEEDED")
        .max_by(|a,b|string(a,"createdAt").cmp(string(b,"createdAt"))
            .then_with(||string(a,"id").cmp(string(b,"id")))).cloned()
}
fn prior_vector(job:&Value,original:&Value)->Result<Value,String> {
    if let Some(vector)=latest_direct_revision(job,original)
        .and_then(|child|child.pointer("/revision/dependencyVector").cloned())
    {return Ok(vector);}
    let mut vector=Map::new();
    for id in dependencies(original) {
        if dependency_validity(original,&id)?=="order-only"{continue;}
        let dependency=tasks(job).iter().find(|candidate|string(candidate,"id")==id)
            .ok_or_else(||format!("missing original dependency {id}"))?;
        let attempt=dependency.get("attempt").and_then(Value::as_i64)
            .map(|a|a.to_string()).unwrap_or_else(||"undefined".into());
        vector.insert(id.clone(),json!(format!("{id}:{attempt}")));
    }
    Ok(Value::Object(vector))
}
pub fn dependency_revision_still_current(job:&Value,task:&Value)->bool {
    let Some(revision)=task.get("revision").filter(|r|!r.is_null()) else{return true;};
    if !matches!(string(revision,"kind"),"rerun"|"revalidate"){return true;}
    let Some(original)=tasks(job).iter()
        .find(|candidate|candidate.get("id")==revision.get("originalTaskId"))
    else{return false;};
    let Some(prior)=revision.get("dependencyVector") else{return false;};
    let Ok(actual)=dependency_revision_vector(job,original) else{return false;};
    if !same_dependency_revision_vector(&actual,prior){return false;}
    dependencies(original).into_iter()
        .filter(|id|dependency_validity(original,id).ok().as_deref()!=Some("order-only"))
        .all(|id|!tasks(job).iter().any(|other|
            other.get("id")!=task.get("id")
                && other.pointer("/revision/originalTaskId")==Some(&json!(id))
                && !matches!(string(other,"state"),"SUCCEEDED"|"CANCELLED")))
}
fn topo_visit(task:&Value,originals:&[Value],visited:&mut HashSet<String>,sorted:&mut Vec<Value>) {
    let id=string(task,"id").to_owned();
    if !visited.insert(id){return;}
    for dependency_id in dependencies(task) {
        if let Some(dependency)=originals.iter()
            .find(|candidate|string(candidate,"id")==dependency_id) {
            topo_visit(dependency,originals,visited,sorted);
        }
    }
    sorted.push(task.clone());
}
fn policy_deps(original:&Value)->Result<Vec<String>,String> {
    dependencies(original).into_iter()
        .filter_map(|id|match dependency_validity(original,&id){
            Ok(policy) if policy!="order-only"=>Some(Ok(id)),
            Ok(_)=>None,
            Err(error)=>Some(Err(error)),
        }).collect()
}

/// Pure candidate-snapshot reducer; call within SQLite mutateJob. Reserved
/// numeric Task IDs are consumed only for Graph-approved descendants.
pub fn reconcile_dependency_revision_facts(
    graph_directory:&Path,job:&mut Value,reserved_ids:&[String],
)->Result<Vec<String>,String>{
    let originals:Vec<Value>=tasks(job).iter().filter(|task|
        string(task,"kind")!="planner"
            && !is_final_review_agent(task.get("agentName").and_then(Value::as_str))
            && string(task,"agentName")!="troubleshooter"
            && string(task,"state")=="SUCCEEDED"
            && task.get("revision").is_none_or(Value::is_null)).cloned().collect();
    let mut visited=HashSet::new();
    let mut sorted=Vec::new();
    for task in &originals {topo_visit(task,&originals,&mut visited,&mut sorted);}
    let mut created=Vec::new();
    let mut changed_stale=Vec::new();
    for original in sorted {
        let original_id=string(&original,"id").to_owned();
        let stale_ids:Vec<String>=tasks(job).iter().filter(|task|
            task.pointer("/revision/originalTaskId")==Some(&json!(original_id))
                && matches!(task.pointer("/revision/kind").and_then(Value::as_str),
                    Some("revalidate"|"rerun"))
                && matches!(string(task,"state"),"DRAFT"|"QUEUED")
                && !dependency_revision_still_current(job,task))
            .map(|task|string(task,"id").to_string()).collect();
        for stale_id in stale_ids {
            let decision=decide_dependency_revision(graph_directory,
                "dependency.stale",&json!({}),"PROPOSED")?;
            let selected=decision.get("accepted")==Some(&Value::Bool(true))
                && string(&decision,"target")=="STALE"
                && decision.get("actions").and_then(Value::as_array).is_some_and(|items|
                    items.iter().any(|action|string(action,"id")=="dependencyRevision.markStale"));
            if !selected {continue;}
            let now=iso8601_now();
            if let Some(stale)=job.get_mut("tasks").and_then(Value::as_array_mut)
                .and_then(|ts|ts.iter_mut().find(|t|string(t,"id")==stale_id)) {
                let transition=try_transition_task_event(graph_directory,
                    stale,"cancel",&json!({}),&now)?;
                if transition.get("accepted")==Some(&Value::Bool(true)) {
                    stale["error"]=json!("Superseded upstream dependency evidence vector changed before execution");
                    stale["executionId"]=Value::Null;
                    changed_stale.push(stale_id);
                }
            }
        }
        let policies=policy_deps(&original)?;
        if policies.is_empty(){continue;}
        let all_inputs_settled=policies.iter().all(|id|!tasks(job).iter().any(|task|
                task.pointer("/revision/originalTaskId")==Some(&json!(id))
                    && !matches!(string(task,"state"),"SUCCEEDED"|"CANCELLED")))
            && !tasks(job).iter().any(|task|
                task.pointer("/revision/originalTaskId")==Some(&json!(original_id))
                    && !matches!(string(task,"state"),"SUCCEEDED"|"CANCELLED"));
        if !all_inputs_settled {continue;}
        let vector=dependency_revision_vector(job,&original)?;
        let previous=prior_vector(job,&original)?;
        let changed=!same_dependency_revision_vector(&vector,&previous);
        let rerun_required=policies.iter().any(|id|
            vector.get(id)!=previous.get(id)
                && dependency_validity(&original,id).ok().as_deref()==Some("rerun"));
        let duplicate=tasks(job).iter().any(|task|
            task.pointer("/revision/originalTaskId")==Some(&json!(original_id))
                && task.pointer("/revision/kind").and_then(Value::as_str)!=Some("targeted")
                && same_dependency_revision_vector(
                    task.pointer("/revision/dependencyVector").unwrap_or(&json!({})),&vector));
        let decision=decide_dependency_revision(graph_directory,
            "dependency.reconcile",&json!({
                "upstreamEvidenceChanged":changed,
                "explicitValidityPolicy":!policies.is_empty(),
                "allInputsSettled":all_inputs_settled,
                "notAlreadyRecorded":!duplicate,"rerunRequired":rerun_required
            }),"NONE")?;
        if decision.get("accepted")!=Some(&Value::Bool(true))
            || string(&decision,"target")!="PROPOSED" {continue;}
        let actions=decision.get("actions").and_then(Value::as_array)
            .ok_or("Dependency Revision Graph had no action list")?;
        if actions.len()!=1 ||
            !matches!(string(&actions[0],"id"),
                "dependencyRevision.createRerun"|"dependencyRevision.createRevalidation") {
            return Err("Dependency Revision Graph did not select exactly one child action".into());
        }
        let mode=if string(&actions[0],"id")=="dependencyRevision.createRerun" {
            "rerun"
        }else{"revalidate"};
        let id=reserved_ids.get(created.len())
            .ok_or("Dependency Revision reconciliation requires preallocated numeric Task IDs")?;
        let inputs:Vec<Value>=policies.iter().map(|dependency_id|{
            let original_dependency=tasks(job).iter().find(|t|
                string(t,"id")==dependency_id).expect("validated dependency");
            latest_direct_revision(job,original_dependency)
                .unwrap_or_else(||original_dependency.clone())
        }).collect();
        let mut request_ids=Vec::new();
        let mut seen=HashSet::new();
        for input in &inputs {
            for request in input.pointer("/revision/requestIds").and_then(Value::as_array)
                .into_iter().flatten() {
                if seen.insert(request.to_string()){request_ids.push(request.clone());}
            }
        }
        let ancestor_review=inputs.iter().find(|t|t.get("revision").is_some_and(|v|!v.is_null()))
            .and_then(|t|t.pointer("/revision/reviewTaskId")).and_then(Value::as_str)
            .or_else(||job.pointer("/review/taskId").and_then(Value::as_str))
            .unwrap_or("").to_owned();
        let mut deps=vec![original_id.clone()];
        deps.extend(inputs.iter().map(|t|string(t,"id").to_string()));
        let mut seen=HashSet::new();
        deps.retain(|id|seen.insert(id.clone()));
        let now=iso8601_now();
        let title=format!("{} {}",if mode=="rerun"{"Rerun"}else{"Revalidate"},
            original.get("title").and_then(Value::as_str).unwrap_or(&original_id));
        let directive=if mode=="rerun" {
            "Re-execute the original deliverable from the current upstream evidence; do not merely sign off the old output."
        }else{
            "Verify whether the original delivered result remains valid against every new upstream generation. Update code/output if required and report exact verification evidence."
        };
        let input=[
            format!("{} of original Task {}.",if mode=="rerun"{"MANDATORY RERUN"}else{"EXPLICIT REVALIDATION"},original_id),
            format!("Semantic dependency evidence vector (all inputs must be validated): {}.",vector),
            directive.into(),
            format!("Original durable Task objective: {}",string(&original,"input")),
            format!("Original result: {}",original.get("result").unwrap_or(&Value::Null)),
        ].join("\n\n");
        let mut fields=json!({
            "jobId":job.get("id"),"id":id,"title":title,
            "kind":"work","parentTaskId":original_id,"agentName":original.get("agentName"),
            "priority":original.get("priority").or_else(||job.get("priority")),
            "storySize":original.get("storySize").filter(|v|!v.is_null()).unwrap_or(&json!("M")),
            "projectName":original.get("projectName"),
            "dependencies":deps,
            "capabilities":original.get("capabilities"),"workerRequirements":original.get("workerRequirements"),
            "adapter":original.get("adapter"),
            "output":original.get("output").filter(|v|!v.is_null()).unwrap_or(&json!({"kind":"task_pr"})),
            "input":input,
            "revision":{"kind":mode,"originalTaskId":original_id,
                "requestIds":request_ids,"reviewTaskId":ancestor_review,
                "basedOnHeadSha":job.get("headSha").and_then(Value::as_str).unwrap_or(""),
                "dependencyVector":vector},
            "attempt":0,"maxAttempts":original.get("maxAttempts").and_then(Value::as_i64).unwrap_or(3).max(3),
            "executionId":null,"threadId":null,
            "result":null,"error":null,"timeoutMs":original.get("timeoutMs"),
            "createdAt":now,"updatedAt":now,"continuation":null,"continuationDeliveredAt":null,
        });
        // The original JS object spread omits `undefined` optional metadata.
        // Null is a distinct durable field: a missing projectName/timeoutMs or
        // workerRequirements must not be invented by serde_json::json!.
        for optional in ["projectName","timeoutMs","workerRequirements"] {
            if original.get(optional).is_none(){
                fields.as_object_mut().expect("revision Task fields")
                    .remove(optional);
            }
        }
        let child=create_task_entity(graph_directory,job,&fields,false,&now)?;
        job.get_mut("tasks").and_then(Value::as_array_mut)
            .ok_or("Job missing Tasks")?.push(child);
        created.push(id.clone());
    }
    if !created.is_empty() || !changed_stale.is_empty() {
        job["updatedAt"]=json!(iso8601_now());
    }
    Ok(created)
}


/// Only Graph-approved dependency revisions allocate global numeric Task IDs.
/// The final mutation is an authoritative SQLite transaction, not an EventBus
/// or ephemeral in-memory plan.
pub fn reconcile_dependency_revisions(
    graph_directory: &Path, store_directory: &Path,
    store: &SQLiteRelayStore, job_id: &str,
) -> Result<Vec<String>, String> {
    let snapshot = store.load_job(job_id)?
        .ok_or_else(||format!("Local authoritative Job {job_id} not found"))?;
    let preview_ids = (0..snapshot.get("tasks").and_then(Value::as_array)
        .map_or(0, Vec::len)).map(|index|
            format!("preview-dependency-{index}")).collect::<Vec<_>>();
    let mut preview = snapshot.clone();
    let planned = reconcile_dependency_revision_facts(
        graph_directory, &mut preview, &preview_ids,
    )?;
    // The daemon polls repeatedly. A no-op preview must never rewrite the
    // SQLite Job, allocate sequence numbers or trigger a wake on every tick.
    // Superseded pending revisions still require the atomic store mutation.
    if planned.is_empty() && preview == snapshot {return Ok(Vec::new());}
    let repository = snapshot.get("repository").and_then(Value::as_str).unwrap_or("");
    let mut reserved = Vec::with_capacity(planned.len());
    let occupied = HashSet::new();
    for _ in &planned {
        reserved.push(allocate_entity_id(
            store_directory, repository, "task", None, &occupied,
        )?);
    }
    let mut created = Vec::new();
    store.mutate_job(job_id, |mut job| {
        created = reconcile_dependency_revision_facts(
            graph_directory, &mut job, &reserved,
        )?;
        Ok(job)
    })?;
    Ok(created)
}
