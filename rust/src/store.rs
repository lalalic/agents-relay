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
        // Node maps nodeId/url to undefined when not strings; JSON wire omits
        // those keys instead of emitting nulls.
        Value::Array(rows.iter().map(|row|{
            let mut comment=json!({
                "id":row.get("databaseId").and_then(Value::as_i64).unwrap_or(0),
                "body":field(row,"body"),"updatedAt":field(row,"updatedAt"),
                "authorLogin":row.pointer("/author/login"),
            });
            if let Some(object)=comment.as_object_mut(){
                if let Some(id)=row.get("id").and_then(Value::as_str){
                    object.insert("nodeId".into(),json!(id));
                }
                if let Some(url)=row.get("url").and_then(Value::as_str){
                    object.insert("url".into(),json!(url));
                }
            }
            comment
        }).collect())
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
            &json!(field(row,"body"))))
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
    // Node adopts jobId-less tasks only when exactly one job was resolved.
    let sole_job=jobs.len()==1;
    let mut overviews=Vec::new();
    for mut job in jobs{
        let job_id=field(&job,"id").to_string();
        let mut associated:Vec<Value>=plans.iter()
            .filter(|plan|field(plan,"jobId")==job_id).cloned().collect();
        associated.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
        job["plans"]=json!(associated);
        job["tasks"]=json!(tasks.iter().filter(|task|
            field(task,"jobId")==job_id
                ||(field(task,"jobId").is_empty()&&sole_job))
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
    // Node InMemoryStore offers two lifecycle-neutral GitHub projection no-ops.
    // Live Relay never uses this test-only fixture for GitHub writes.
    pub fn close_pull_request(&mut self) {}
    pub fn update_pull_request_body(&mut self,_body:&str) {}
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

// Public GitHub metadata readers. Production Task/Job authority remains SQLite;
// these methods read remote collaboration data through the explicit GitHub port.
pub fn load_managed_github_pull_request_graphql<C:crate::store_github::GitHubApi>(
    client:&mut C,repository:&str,pr_number:u64,
    trusted_authors:&HashSet<String>,
)->Result<Vec<Value>,String>{
    let parts=repository.split('/').collect::<Vec<_>>();
    // Original Node snapshot short-circuits before any remote request.
    if parts.len()<2||parts[0].is_empty()||parts[1].is_empty()||pr_number==0{
        return Ok(Vec::new());
    }
    let variables=json!({"owner":parts[0],"name":parts[1],"number":pr_number});
    let result=client.graphql(managed_github_pull_request_query(),&variables)?;
    Ok(load_managed_github_pull_request_snapshot_graphql(
        repository,pr_number,trusted_authors,&result
    )["overviews"].as_array().cloned().unwrap_or_default())
}
pub fn load_managed_github_job_graphql<C:crate::store_github::GitHubApi>(
    client:&mut C,repository:&str,pr_number:u64,job_id:&str,
    trusted_authors:&HashSet<String>,
)->Result<Option<Value>,String>{
    Ok(load_managed_github_pull_request_graphql(
        client,repository,pr_number,trusted_authors)?
        .into_iter().find(|item|field(&item["job"],"id")==job_id))
}
/// A request-context adapter must restore the caller's context in a finally
/// path, even for errors. The client port decides whether contexts are enabled.
pub fn with_github_request_context<T,Work,Context>(
    context:&str,mut work:Work,context_port:Option<Context>,
)->Result<T,String>
where
    Work:FnMut()->Result<T,String>,
    Context:FnOnce(&str,&mut dyn FnMut()->Result<T,String>)->Result<T,String>,
{
    if let Some(with_context)=context_port{
        with_context(context,&mut work)
    }else{
        work()
    }
}

/// Read only the GitHub PR metadata projection. Pagination and a finite
/// seen-cursor set prevent a misbehaving GitHub endpoint from looping forever.
pub fn list_managed_github_jobs<C:crate::store_github::GitHubApi>(
    client:&mut C,repository:&str,trusted_authors:&HashSet<String>,
)->Result<Vec<Value>,String>{
    let (owner,name)=repository.split_once('/').ok_or_else(||
        format!("Invalid GitHub repository {repository}"))?;
    if owner.is_empty()||name.is_empty(){
        return Err(format!("Invalid GitHub repository {repository}"));
    }
    const FIRST:&str="query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){open:pullRequests(first:50,after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}} recentMerged:pullRequests(first:20,states:MERGED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}}} recentClosed:pullRequests(first:20,states:CLOSED,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}}}}}";
    const NEXT:&str="query($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){open:pullRequests(first:50,after:$cursor,states:OPEN,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{number body state isDraft merged mergedAt closedAt comments(first:100){nodes{author{login} body}}} pageInfo{hasNextPage endCursor}}}}";
    let mut cursor:Option<String>=None;
    let mut first=true;
    let mut visited=HashSet::<String>::new();
    let mut numbers=HashSet::<i64>::new();
    let mut result=Vec::<Value>::new();
    loop{
        let variables=json!({"owner":owner,"name":name,"cursor":cursor});
        let data=client.graphql(if first{FIRST}else{NEXT},&variables)?;
        let repo=&data["repository"];
        let mut collect=|items:&Value|{
            for pr in items.as_array().into_iter().flatten(){
                let number=pr.get("number").and_then(Value::as_i64)
                    .or_else(||pr.get("number").and_then(Value::as_str)
                        .and_then(|s|s.parse::<i64>().ok()))
                    .unwrap_or(0);
                if number<=0 || !numbers.insert(number){continue;}
                let rows=pr.pointer("/comments/nodes").and_then(Value::as_array)
                    .map(Vec::as_slice).unwrap_or(&[]);
                let trusted=rows.iter().filter(|comment|
                    comment.pointer("/author/login").and_then(Value::as_str)
                    .is_some_and(|name|trusted_authors.contains(name))
                ).collect::<Vec<_>>();
                let publication=rows.iter().filter(|comment|
                    comment.pointer("/author/login").and_then(Value::as_str)
                    .is_some_and(|name|trusted_authors.contains(name)
                        ||matches!(name,"github-actions[bot]"|"github-actions")))
                    .filter_map(|comment|crate::github_webhook::parse_package_publication_marker(
                        &json!(field(comment,"body")))).last();
                let from_body=parse_job(field(pr,"body"));
                let from_comments=trusted.iter().filter_map(|comment|
                    parse_job(field(comment,"body"))).collect::<Vec<_>>();
                let jobs=from_body.map(|job|vec![job]).unwrap_or(from_comments);
                let tasks=trusted.iter().filter_map(|comment|
                    parse_task(field(comment,"body"))).collect::<Vec<_>>();
                let state=field(pr,"state").to_ascii_uppercase();
                let github_state=if pr.get("merged")==Some(&Value::Bool(true))
                    ||state=="MERGED"{"MERGED"}else if state=="CLOSED"{"CLOSED"}else{"OPEN"};
                let count=jobs.len();
                for mut job in jobs{
                    let job_id=field(&job,"id").to_owned();
                    if field(&job,"description").is_empty()&&!field(pr,"body").is_empty(){
                        job["description"]=pr["body"].clone();
                    }
                    job["prNumber"]=json!(number);
                    job["repository"]=json!(repository);
                    job["tasks"]=json!(tasks.iter().filter(|task|
                        field(task,"jobId")==job_id
                            ||(field(task,"jobId").is_empty()&&count==1))
                        .cloned().collect::<Vec<_>>());
                    result.push(json!({"job":job,"githubState":github_state,
                        "draft":pr.get("isDraft")==Some(&Value::Bool(true)),
                        "mergedAt":pr.get("mergedAt"),
                        "closedAt":pr.get("closedAt"),
                        "publication":publication}));
                }
            }
        };
        collect(&repo["open"]["nodes"]);
        if first{
            collect(&repo["recentMerged"]["nodes"]);
            collect(&repo["recentClosed"]["nodes"]);
        }
        let page=&repo["open"]["pageInfo"];
        let next=if page["hasNextPage"]==true{
            page.get("endCursor").and_then(Value::as_str).map(str::to_owned)
        }else{None};
        first=false;
        match next{
            Some(value) if visited.insert(value.clone())=>{
                cursor=Some(value);
            },
            Some(_)=>return Err("GitHub GraphQL pagination repeated a cursor".into()),
            None=>break,
        }
    }
    result.sort_by(|a,b|b.pointer("/job/prNumber").and_then(Value::as_i64)
        .unwrap_or(0).cmp(&a.pointer("/job/prNumber")
        .and_then(Value::as_i64).unwrap_or(0)));
    Ok(result)
}

// Public Store facade uses the dedicated PR effect module.
pub use crate::store_pull_request::resolve_pull_request;
