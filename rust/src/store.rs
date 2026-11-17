// Node provenance: src/store.ts. The Store is an interface; SQLite is the
// sole production authority, while InMemoryStore is an isolated test adapter.
// GitHub is optional metadata, never lifecycle truth.
use crate::{
    markers::{
        parse_agent, parse_job, parse_plan, parse_task, render_agent_comment,
        render_job_comment, render_plan_comment, render_task_comment,
    },
    legacy_blocked_task_migration::normalize_legacy_task_lifecycle,
    store_task_definition::{is_task_for_job, same_task_definition, same_plan_definition},
};
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
const COMPLETED_JOB_HISTORY_LIMIT:usize=10;
pub fn dashboard_managed_jobs(items:&[Value])->Vec<Value>{
    let mut unfinished=Vec::new();
    let mut finished=Vec::new();
    for item in items{
        if matches!(item.pointer("/job/state").and_then(Value::as_str),
            Some("COMPLETED"|"CANCELLED")){
            finished.push(item.clone());
        }else{unfinished.push(item.clone());}
    }
    let completed_at=|overview:&Value|->String{
        let mut dates=vec![
            field(&overview["job"],"updatedAt"),
            field(overview,"mergedAt"),field(overview,"closedAt")];
        dates.retain(|v|!v.is_empty());
        dates.into_iter().max().unwrap_or("").to_string()
    };
    finished.sort_by(|a,b|completed_at(b).cmp(&completed_at(a))
        .then_with(||b.pointer("/job/prNumber").and_then(Value::as_i64)
            .unwrap_or(0).cmp(&a.pointer("/job/prNumber")
                .and_then(Value::as_i64).unwrap_or(0))));
    unfinished.extend(finished.into_iter().take(COMPLETED_JOB_HISTORY_LIMIT));
    unfinished
}
/// A readonly source snapshot; Task/Plan comments are accepted only when
/// authored by the trusted identity, and PR content is fallback metadata.
pub fn load_managed_github_pull_request_snapshot_graphql(
    repository:&str,pr_number:u64,trusted_authors:&HashSet<String>,
    graphql_response:&Value,
)->Value{
    let split=repository.split('/').collect::<Vec<_>>();
    if split.len()<2||split[0].is_empty()||split[1].is_empty()||pr_number==0{
        return json!({"overviews":[],"seed":{"prNode":{},"comments":null}});
    }
    let pr=&graphql_response["repository"]["pullRequest"];
    if pr.is_null(){
        return json!({"overviews":[],"seed":{"prNode":{},"comments":null}});
    }
    let rows=pr.pointer("/comments/nodes").and_then(Value::as_array)
        .cloned().unwrap_or_default();
    let total=pr.pointer("/comments/totalCount")
        .and_then(Value::as_u64).unwrap_or(rows.len() as u64);
    let seed_comments=if total<=rows.len() as u64{
        Value::Array(rows.iter().map(|row|json!({
            "id":row.get("databaseId").and_then(Value::as_i64).unwrap_or(0),
            "nodeId":row.get("id"),"url":row.get("url"),
            "body":field(row,"body"),"updatedAt":field(row,"updatedAt"),
            "authorLogin":row.pointer("/author/login")
        })).collect())
    }else{Value::Null};
    let trusted:Vec<&Value>=rows.iter().filter(|row|row.pointer("/author/login")
        .and_then(Value::as_str).is_some_and(|name|trusted_authors.contains(name)))
        .collect();
    let body_job=parse_job(field(pr,"body"));
    let comment_jobs:Vec<Value>=trusted.iter()
        .filter_map(|row|parse_job(field(row,"body"))).collect();
    let jobs=body_job.map(|job|vec![job]).unwrap_or(comment_jobs);
    let publication=rows.iter().filter(|row|row.pointer("/author/login")
        .and_then(Value::as_str).is_some_and(|name|
            trusted_authors.contains(name)||matches!(name,"github-actions[bot]"|"github-actions")))
        .filter_map(|row|crate::github_webhook::parse_package_publication_marker(
            field(row,"body")))
        .last();
    let plans:Vec<Value>=trusted.iter().filter_map(|row|{
        let mut plan=parse_plan(field(row,"body"))?;
        if let Some(url)=row.get("url").and_then(Value::as_str)
            .filter(|s|!s.is_empty()){
            plan["planUrl"]=json!(url);
        }else if let Some(id)=row.get("databaseId").and_then(Value::as_u64){
            plan["planUrl"]=json!(format!(
                "https://github.com/{repository}/pull/{pr_number}#issuecomment-{id}"));
        }
        Some(plan)
    }).collect();
    let tasks:Vec<Value>=trusted.iter().filter_map(|row|{
        let mut task=parse_task(field(row,"body"))?;
        if let Some(url)=row.get("url").and_then(Value::as_str)
            .filter(|s|!s.is_empty()){
            task["taskUrl"]=json!(url);
        }else if let Some(id)=row.get("databaseId").and_then(Value::as_u64){
            task["taskUrl"]=json!(format!(
                "https://github.com/{repository}/pull/{pr_number}#issuecomment-{id}"));
        }
        Some(task)
    }).collect();
    let state=field(pr,"state").to_ascii_uppercase();
    let github_state=if pr.get("merged")==Some(&Value::Bool(true)){"MERGED"}
        else if state=="CLOSED"{"CLOSED"}else{"OPEN"};
    let mut overviews=Vec::new();
    for mut job in jobs{
        let job_id=field(&job,"id").to_string();
        let mut associated:Vec<Value>=plans.iter()
            .filter(|plan|field(plan,"jobId")==job_id).cloned().collect();
        associated.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
        job["plans"]=json!(associated);
        job["tasks"]=json!(tasks.iter().filter(|task|
            field(task,"jobId")==job_id||field(task,"jobId").is_empty())
            .cloned().collect::<Vec<_>>());
        if field(&job,"description").is_empty()&&!field(pr,"body").is_empty(){
            job["description"]=pr["body"].clone();
        }
        if !field(pr,"headRefOid").is_empty(){
            job["headSha"]=pr["headRefOid"].clone();
        }
        overviews.push(json!({
            "job":job,"githubState":github_state,
            "draft":pr.get("isDraft")==Some(&Value::Bool(true)),
            "mergedAt":pr.get("mergedAt"),"closedAt":pr.get("closedAt"),
            "publication":publication
        }));
    }
    json!({"overviews":overviews,"seed":{"prNode":pr,"comments":seed_comments}})
}
pub fn managed_github_pull_request_query()->&'static str{
    "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state isDraft merged mergedAt closedAt body headRefName headRefOid comments(last:100){totalCount nodes{id databaseId url updatedAt author{login} body}}}}}"
}
/// In-memory fixture reproduces the Node comment-marker store's semantics.
/// Deliberately not used for live Relay storage.
#[derive(Default,Clone)]
pub struct InMemoryStore {
    values:HashMap<String,String>,
    order:Vec<String>,
}
impl InMemoryStore {
    fn put(&mut self,key:String,body:String){
        if !self.values.contains_key(&key){self.order.push(key.clone());}
        self.values.insert(key,body);
    }
    pub fn new(job:Option<&Value>)->Self{
        let mut store=Self::default();
        if let Some(job)=job{
            store.save_job(job);
            for plan in job.get("plans").and_then(Value::as_array)
                .into_iter().flatten(){
                store.put(format!("PLAN:{}:{}",field(plan,"jobId"),field(plan,"id")),
                    render_plan_comment(plan));
            }
            for task in job.get("tasks").and_then(Value::as_array)
                .into_iter().flatten(){
                store.put(format!("TASK:{}:{}",field(task,"jobId"),field(task,"id")),
                    render_task_comment(task));
            }
        }
        store
    }
    fn bodies(&self)->Vec<&str>{
        self.order.iter().filter_map(|key|self.values.get(key))
            .map(String::as_str).collect()
    }
    pub fn load(&self,job_id:&str)->Result<Value,String>{
        let mut job=self.bodies().into_iter()
            .filter_map(parse_job)
            .find(|job|field(job,"id")==job_id)
            .ok_or_else(||format!("Job {job_id} not found"))?;
        let jobs=self.bodies().into_iter().filter_map(parse_job).collect::<Vec<_>>();
        let sole=jobs.len()==1;
        let mut plans=self.bodies().into_iter().filter_map(parse_plan)
            .filter(|plan|field(plan,"jobId")==job_id).collect::<Vec<_>>();
        plans.sort_by_key(|plan|plan.get("round").and_then(Value::as_i64).unwrap_or(0));
        job["plans"]=json!(plans);
        job["tasks"]=json!(self.bodies().into_iter().filter_map(parse_task)
            .filter(|task|is_task_for_job(task,job_id,sole))
            .map(|task|normalize_legacy_task_lifecycle(&task))
            .collect::<Vec<_>>());
        Ok(job)
    }
    pub fn mutate_job(
        &mut self,job_id:&str,mutate:impl FnOnce(Value)->Result<Value,String>
    )->Result<Value,String>{
        let existing=self.load(job_id)?;
        let next=mutate(existing)?;
        self.save_job(&next);
        for plan in next.get("plans").and_then(Value::as_array)
            .into_iter().flatten(){
            self.put(format!("PLAN:{job_id}:{}",field(plan,"id")),
                render_plan_comment(plan));
        }
        for task in next.get("tasks").and_then(Value::as_array)
            .into_iter().flatten(){
            self.put(format!("TASK:{}:{}",task.get("jobId")
                .and_then(Value::as_str).unwrap_or(job_id),field(task,"id")),
                render_task_comment(task));
        }
        Ok(next)
    }
    pub fn save_job(&mut self,job:&Value){
        self.put(format!("JOB:{}",field(job,"id")),render_job_comment(job));
    }
    pub fn append_plan(&mut self,plan:&Value)->Result<(),String>{
        let key=format!("PLAN:{}:{}",field(plan,"jobId"),field(plan,"id"));
        if let Some(current)=self.values.get(&key){
            if parse_plan(current).is_some_and(|prior|same_plan_definition(&prior,plan)){
                return Ok(());
            }
            return Err(format!("Plan {} already exists with a different definition",field(plan,"id")));
        }
        self.put(key,render_plan_comment(plan));Ok(())
    }
    pub fn save_plan(&mut self,plan:&Value){
        self.put(format!("PLAN:{}:{}",field(plan,"jobId"),field(plan,"id")),
            render_plan_comment(plan));
    }
    pub fn append_task(&mut self,task:&Value)->Result<(),String>{
        let key=format!("TASK:{}:{}",field(task,"jobId"),field(task,"id"));
        if let Some(current)=self.values.get(&key){
            if parse_task(current).is_some_and(|prior|same_task_definition(&prior,task)){
                return Ok(());
            }
            return Err(format!("Task {} already exists with a different definition",field(task,"id")));
        }
        self.put(key,render_task_comment(task));Ok(())
    }
    pub fn save_task(&mut self,task:&Value){
        self.put(format!("TASK:{}:{}",field(task,"jobId"),field(task,"id")),
            render_task_comment(task));
    }
    pub fn list_agents(&self)->Vec<Value>{
        self.bodies().into_iter().filter_map(parse_agent).collect()
    }
    pub fn save_agent(&mut self,agent:&Value){
        self.put(format!("AGENT:{}",field(agent,"id")),render_agent_comment(agent));
    }
    pub fn comments(&self)->Vec<Value>{
        self.bodies().into_iter().enumerate().map(|(index,body)|json!({
            "id":index+1,"body":body,"updatedAt":crate::local_merge_lock::iso8601_now(),
            "authorLogin":"local"
        })).collect()
    }
    pub fn head_sha(&self)->Option<String>{
        self.bodies().into_iter().filter_map(parse_job).next()
            .and_then(|job|job.get("headSha").and_then(Value::as_str)
                .or_else(||job.pointer("/review/headSha").and_then(Value::as_str))
                .map(str::to_owned))
    }
}
