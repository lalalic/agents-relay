// Node src/blockers.ts DurableStore port: cross-Job blocker registration and
// release. Graph authorizes each Task mutation; SQLite mutation is atomic in
// authoritative implementations. The caller injects related-store resolution.
use crate::{blockers::{
    register_blocker_dependency,resolve_blocker_dependencies,BlockerResolutionSummary,
},local_merge_lock::iso8601_now};
use serde_json::{json,Value};
use std::path::Path;

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub trait CrossJobBlockerStore {
    fn load_job(&mut self,job_id:&str)->Result<Value,String>;
    fn save_job(&mut self,job:&Value)->Result<(),String>;
    fn save_task(&mut self,task:&Value)->Result<(),String>;
    fn mutate_job(&mut self,job_id:&str,
        update:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>;
}
pub fn register_blocker_dependent(
    directory:&Path,blocker:&mut dyn CrossJobBlockerStore,blocker_job_id:&str,
    dependent:&Value,related:Option<&mut dyn CrossJobBlockerStore>,
    now:Option<&str>,
)->Result<Value,String>{
    let related=related.ok_or("Related local store factory is required for blocker dependencies")?;
    let dependent_job_id=field(dependent,"jobId");
    let dependent_task_id=field(dependent,"taskId");
    let stamp=now.map(str::to_string).unwrap_or_else(iso8601_now);
    let target=related.load_job(dependent_job_id)?;
    let blocker_head=blocker.load_job(blocker_job_id)?;
    let expected_mode=dependent.get("resolutionMode").and_then(Value::as_str);
    let start=register_blocker_dependency(directory,&blocker_head,&target,
        dependent_task_id,None,expected_mode,Some(&stamp))?;
    if start.existing{
        let prior=target.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|t|field(t,"id")==dependent_task_id)
            .ok_or_else(||format!("Dependent task {dependent_task_id} not found"))?;
        let next=start.dependent.get("tasks").and_then(Value::as_array)
            .into_iter().flatten().find(|t|field(t,"id")==dependent_task_id)
            .ok_or("Dependent Task absent after registration")?;
        if prior.get("blockedBy")!=next.get("blockedBy"){
            related.save_task(next)?;
        }
        return Ok(start.relation);
    }
    // Guard the Blocker update within the primary store's durable CAS
    // transaction. A duplicate registration discovered by a concurrent
    // invocation never appends a second relation.
    let mut committed=None;
    blocker.mutate_job(blocker_job_id,&mut |current|{
        let target=related.load_job(dependent_job_id)?;
        let next=register_blocker_dependency(directory,&current,&target,
            dependent_task_id,None,expected_mode,Some(&stamp))?;
        committed=Some(next.clone());
        Ok(next.blocker)
    })?;
    let result=committed.ok_or("Blocker registration did not commit")?;
    let updated=result.dependent.get("tasks").and_then(Value::as_array)
        .into_iter().flatten().find(|t|field(t,"id")==dependent_task_id)
        .ok_or("Registered dependent Task absent")?;
    related.save_task(updated)?;
    Ok(result.relation)
}
pub fn resolve_blocker_dependents(
    directory:&Path,blocker:&mut dyn CrossJobBlockerStore,blocker_job_id:&str,
    resolution:&str,
    mut related:Option<&mut dyn FnMut(&str,u64)->Result<Box<dyn CrossJobBlockerStore>,String>>,
    now:Option<&str>,
)->Result<Value,String>{
    if !matches!(resolution,"merge"|"verified"){
        return Err(format!("Invalid blocker resolution {resolution}"));
    }
    let factory=related.as_mut()
        .ok_or("Related local store factory is required for blocker dependencies")?;
    let prior=blocker.load_job(blocker_job_id)?;
    let stamp=now.map(str::to_string).unwrap_or_else(iso8601_now);
    let mut reads=Vec::<(Value,Value)>::new();
    let summary:BlockerResolutionSummary=resolve_blocker_dependencies(
        directory,&prior,resolution,|relation|{
            let repo=field(relation,"repository");
            let pr=relation.get("prNumber").and_then(Value::as_u64).unwrap_or(0);
            let job=factory(repo,pr)?.load_job(field(relation,"jobId"))?;
            reads.push((relation.clone(),job.clone()));
            Ok(job)
        },Some(&stamp))?;
    // Commit every Graph-authorized dependent Task release first, as in Node.
    // If any related store write fails the Blocker still retains its waiting
    // relation; the next retry can re-evaluate durable Task state.
    for (job_id,after) in &summary.updated_dependents{
        let task_after=after.get("tasks").and_then(Value::as_array)
            .map(Vec::as_slice).unwrap_or(&[]);
        for (relation,before) in reads.iter().filter(|(relation,_)|
            field(relation,"jobId")==job_id){
            let task_id=field(relation,"taskId");
            let updated=task_after.iter().find(|task|field(task,"id")==task_id);
            let original=before.get("tasks").and_then(Value::as_array)
                .into_iter().flatten().find(|task|field(task,"id")==task_id);
            if let Some(updated)=updated.filter(|updated|Some(*updated)!=original){
                let pr=relation.get("prNumber")
                    .and_then(Value::as_u64).unwrap_or(0);
                factory(field(relation,"repository"),pr)?
                    .save_task(updated)?;
            }
        }
    }
    if summary.blocker!=prior{
        blocker.save_job(&summary.blocker)?;
    }
    Ok(json!({"resumed":summary.resumed,"obsolete":summary.obsolete,
        "waiting":summary.waiting,"unblocked":summary.unblocked}))
}
