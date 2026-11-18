// Node provenance: src/local-authority-store.ts. Local SQLite is the
// authoritative Job/Plan/Task boundary; external GitHub projections are
// optional collaboration effects. Never hydrate lifecycle truth from GitHub.
use crate::{
    local_commit_events::publish_local_commit,
    relay_job_merge::merge_inbound_job_snapshot,
    relay_store::SQLiteRelayStore,
    store_task_definition::{same_plan_definition,same_task_definition},
};
use serde_json::{json,Value};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn state_order(state:&str)->u8{
    match state{
        "DRAFT"=>0,"QUEUED"=>1,"RUNNING"=>2,
        "AWAITING_DECISION"=>3,"BLOCKED"=>4,
        "SUCCEEDED"|"FAILED"|"CANCELLED"=>5,_=>0,
    }
}
fn tasks(job:&Value)->&[Value] {
    job.get("tasks").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
pub struct LocalAuthorityDurableStore {
    pub authority:SQLiteRelayStore,
    pub no_github:bool,
}
impl LocalAuthorityDurableStore {
    pub fn new(authority:SQLiteRelayStore,no_github:bool)->Self{
        Self{authority,no_github}
    }
    pub fn load(&self,job_id:&str)->Result<Value,String>{
        self.authority.load_job(job_id)?
            .ok_or_else(||format!("Local authoritative Job {job_id} not found"))
    }
    pub fn mutate_job<F>(&self,job_id:&str,mutate:F)->Result<Value,String>
    where F:FnOnce(Value)->Result<Value,String>{
        let result=self.authority.mutate_job(job_id,mutate)?;
        publish_local_commit(&result);
        Ok(result)
    }
    pub fn save_job(&self,job:&Value)->Result<Value,String>{
        let incoming=job.clone();
        let id=field(job,"id").to_owned();
        if self.authority.load_job(&id)?.is_none(){
            self.authority.save_job(&incoming)?;
            publish_local_commit(&incoming);
            return Ok(incoming);
        }
        self.mutate_job(&id,|current|{
            let children=merge_inbound_job_snapshot(&current,&incoming);
            let terminal=matches!(field(&current,"state"),"COMPLETED"|"CANCELLED")
                &&!matches!(field(&incoming,"state"),"COMPLETED"|"CANCELLED");
            let activation=field(&current,"state")=="ACTIVE"
                &&field(&incoming,"state")=="DRAFT";
            let review=match(current.get("review"),incoming.get("review")){
                (Some(old),Some(new)) if field(old,"updatedAt")>field(new,"updatedAt")
                    =>Some(old.clone()),
                (Some(_),Some(new))=>Some(new.clone()),
                (Some(old),None)=>Some(old.clone()),
                (None,Some(new))=>Some(new.clone()),
                _=>None
            };
            let source=if field(&incoming,"updatedAt")>field(&current,"updatedAt"){
                &incoming
            }else{&current};
            let mut result=current.clone();
            if let Some(dst)=result.as_object_mut(){
                for (key,value) in source.as_object().into_iter().flatten(){
                    dst.insert(key.clone(),value.clone());
                }
            }
            result["state"]=if terminal||activation{current["state"].clone()}
                else{source["state"].clone()};
            result["updatedAt"]=json!(field(&current,"updatedAt")
                .max(field(&incoming,"updatedAt")));
            result["tasks"]=children["tasks"].clone();
            if let Some(plans)=children.get("plans"){
                result["plans"]=plans.clone();
            }
            if let Some(review)=review{result["review"]=review;}
            Ok(result)
        })
    }
    pub fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>{
        self.authority.create_job_if_absent(job)
    }
    pub fn append_plan(&self,plan:&Value)->Result<(),String>{
        let id=field(plan,"jobId");
        self.mutate_job(id,|mut job|{
            let found=job.get("plans").and_then(Value::as_array)
                .into_iter().flatten().find(|p|p.get("id")==plan.get("id"));
            if let Some(prior)=found{
                if same_plan_definition(prior,plan){return Ok(job);}
                return Err(format!(
                    "Plan {} already exists with a different definition",field(plan,"id")));
            }
            let next=job.get_mut("plans").and_then(Value::as_array_mut);
            if let Some(plans)=next{
                plans.push(plan.clone());
                plans.sort_by_key(|item|item.get("round").and_then(Value::as_i64)
                    .unwrap_or(0));
            }else{job["plans"]=json!([plan]);}
            Ok(job)
        })?;
        Ok(())
    }
    pub fn save_plan(&self,plan:&Value)->Result<(),String>{
        let id=field(plan,"jobId");
        self.mutate_job(id,|mut job|{
            let plans=job.get_mut("plans").and_then(Value::as_array_mut);
            if let Some(plans)=plans {
                if let Some(index)=plans.iter().position(|p|p.get("id")==plan.get("id")){
                    if field(&plans[index],"updatedAt")<=field(plan,"updatedAt"){
                        plans[index]=plan.clone();
                    }
                }else{plans.push(plan.clone());}
                plans.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
            }else{job["plans"]=json!([plan]);}
            Ok(job)
        })?;
        Ok(())
    }
    pub fn append_task(&self,task:&Value)->Result<(),String>{
        let id=field(task,"jobId");
        if id.is_empty(){return Err("Local authoritative task requires jobId".into());}
        self.mutate_job(id,|mut job|{
            if let Some(prior)=tasks(&job).iter()
                .find(|t|t.get("id")==task.get("id")){
                if same_task_definition(prior,task){return Ok(job);}
                return Err(format!(
                    "Task {} already exists with a different definition",field(task,"id")));
            }
            job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Authoritative job.tasks is not an array")?
                .push(task.clone());
            Ok(job)
        })?;
        Ok(())
    }
    pub fn save_task(&self,task:&Value)->Result<(),String>{
        let id=field(task,"jobId");
        if id.is_empty(){return Err("Local authoritative task requires jobId".into());}
        self.mutate_job(id,|mut job|{
            let index=tasks(&job).iter().position(|t|t.get("id")==task.get("id"))
                .ok_or_else(||format!("Local authoritative Task {} not found",field(task,"id")))?;
            let current=&job["tasks"][index];
            let old_attempt=current.get("attempt").and_then(Value::as_u64).unwrap_or(0);
            let new_attempt=task.get("attempt").and_then(Value::as_u64).unwrap_or(0);
            if old_attempt>new_attempt
                ||field(current,"updatedAt")>field(task,"updatedAt"){
                return Ok(job);
            }
            if old_attempt==new_attempt
                &&field(current,"updatedAt")==field(task,"updatedAt")
                &&state_order(field(current,"state"))>=state_order(field(task,"state")){
                return Ok(job);
            }
            let mut incoming=task.clone();
            if let Some(comments)=current.get("comments").filter(|v|!v.is_null()){
                incoming["comments"]=comments.clone();
            }
            job["tasks"][index]=incoming;
            Ok(job)
        })?;
        Ok(())
    }
    // Public DurableStore delegation: Graph selects the mutation, the SQLite
    // transaction is the sole durable authority. A failed write never emits
    // a local-commit wake or a false completion receipt.
    pub fn reserve_workflow_launch(&self,identity:&Value)->Result<bool,String>{
        self.authority.reserve_workflow_launch(identity)
    }
    pub fn verify_workflow_launch(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<String,String>{
        self.authority.verify_workflow_launch(job_id,task_id,execution_id)
    }
    pub fn commit_workflow_mutation_and_events<F>(
        &self,job_id:&str,mutate:F,events:&[Value],
    )->Result<Value,String>
    where F:FnOnce(Value)->Result<Value,String>{
        let committed=self.authority.commit_workflow_mutation_and_events(
            job_id,mutate,events)?;
        publish_local_commit(&committed);
        Ok(committed)
    }
    pub fn commit_workflow_mutation_with_events<F>(
        &self,job_id:&str,mutate:F,
    )->Result<Value,String>
    where F:FnOnce(Value)->Result<(Value,Vec<Value>),String>{
        let committed=self.authority.commit_workflow_mutation_with_events(job_id,mutate)?;
        publish_local_commit(&committed);
        Ok(committed)
    }
    pub async fn drain_workflow_events<Publish,Fut>(
        &self,publish:Publish,
    )->Result<usize,String>
    where Publish:FnMut(Value)->Fut,Fut:std::future::Future<Output=Result<(),String>>{
        self.authority.drain_workflow_events(publish).await
    }
    pub fn record_host_invocation_event(
        &self,delivery:&Value,outcome:&str,fingerprint:&str,
    )->Result<(),String>{
        self.authority.record_host_invocation_event(delivery,outcome,fingerprint)
    }
    pub fn has_host_invocation_decision(
        &self,job_id:&str,task_id:&str,invocation_id:&str,
        fingerprint:Option<&str>,
    )->Result<bool,String>{
        self.authority.has_host_invocation_decision(
            job_id,task_id,invocation_id,fingerprint)
    }
    pub fn record_execution_process(&self,record:&Value)->Result<(),String>{
        self.authority.record_execution_process(record)
    }
    pub fn load_execution_process(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<Option<Value>,String>{
        self.authority.load_execution_process(job_id,task_id,execution_id)
    }
    pub fn finish_execution_process(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<(),String>{
        self.authority.finish_execution_process(job_id,task_id,execution_id,None)
    }
    pub fn apply_pull_request_facts(&self,facts:&Value)->Result<(),String>{
        self.authority.save_pull_request_facts(facts)
    }
    pub fn list_agents(&self)->Result<Vec<Value>,String>{self.load_agents()}
    pub fn load_agents(&self)->Result<Vec<Value>,String>{
        Ok(self.authority.load_agents()?.unwrap_or_default())
    }
    pub fn save_agent(&self,agent:&Value)->Result<(),String>{
        self.authority.upsert_agent(agent)
    }
    pub fn pull_request_state(&self)->Result<String,String>{
        if self.no_github{return Ok("UNKNOWN".into());}
        Ok(self.authority.load_pull_request_facts()?
            .as_ref().map(|v|field(v,"state").to_owned())
            .unwrap_or_else(||"UNKNOWN".into()))
    }
    pub fn pull_request_head(&self)->Result<Option<Value>,String>{
        if self.no_github{return Ok(None);}
        Ok(self.authority.load_pull_request_facts()?
            .and_then(|v|v.get("head").filter(|v|!v.is_null()).cloned()))
    }
    pub fn head_sha(&self)->Result<Option<String>,String>{
        Ok(self.pull_request_head()?.as_ref().and_then(|h|h.get("sha"))
            .and_then(Value::as_str).map(str::to_owned))
    }
    pub fn merge_pull_request(&self,expected_head:Option<&str>)
        ->Result<bool,String>{
        if self.no_github{
            return Err("Remote merge unavailable with --no-github; local Graph completion is separate".into());
        }
        let Some(head)=expected_head.filter(|s|!s.is_empty())
            else{return Err("External merge requires immutable expected head SHA".into());};
        let facts=self.authority.load_pull_request_facts()?;
        if facts.as_ref().is_some_and(|v|field(v,"state")=="MERGED"){
            return Ok(false);
        }
        if facts.as_ref().is_some_and(|v|field(v,"state")=="CLOSED"){
            return Err("Cannot merge a PR already known closed".into());
        }
        self.authority.enqueue_external_action_once(&json!({
            "idempotencyKey":format!("merge_pull_request:{head}"),
            "operation":"merge_pull_request",
            "payload":{"operation":"merge_pull_request","expectedHeadSha":head},
            "priority":200
        }))
    }
    pub fn close_pull_request(&self)->Result<bool,String>{
        if self.no_github{return Ok(false);}
        let facts=self.authority.load_pull_request_facts()?;
        if facts.as_ref().is_some_and(|v|field(v,"state")=="MERGED"){
            return Err("Cannot close a PR already merged".into());
        }
        if facts.as_ref().is_some_and(|v|field(v,"state")=="CLOSED"){
            return Ok(false);
        }
        self.authority.enqueue_external_action_once(&json!({
            "idempotencyKey":"close_pull_request",
            "operation":"close_pull_request",
            "payload":{"operation":"close_pull_request"},"priority":200
        }))
    }
    pub fn record_host_invocation_decision(
        &mut self,delivery:&Value,fingerprint:&str,
    )->Result<Value,String>{
        let result=self.authority.record_host_invocation_decision(delivery,fingerprint)?;
        if field(&result,"outcome")=="accepted"{
            let job=self.load(field(delivery,"jobId"))?;
            publish_local_commit(&job);
        }
        Ok(result)
    }
    pub fn comments(&self)->Vec<Value>{Vec::new()}
    pub fn hydrate(&self,_job:&Value){} // never hydrate from GitHub
}
