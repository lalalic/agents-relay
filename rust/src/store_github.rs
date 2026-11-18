// Node provenance: src/store-github.ts. PR/comment-backed GitHub Store.
// This is an external projection/compatibility transport; SQLite is the
// authoritative lifecycle store. Mutations use immutable marker identities.
use crate::{
    local_merge_lock::iso8601_now,
    markers::{
        parse_agent,parse_job,parse_plan,parse_task,render_agent_comment,
        render_job_body,render_plan_comment,render_task_comment,JOB_MARKER,
    },
    store_task_definition::{is_task_for_job,same_plan_definition,same_task_definition},
};
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn nested<'a>(v:&'a Value,path:&str)->&'a str{
    v.pointer(path).and_then(Value::as_str).unwrap_or("")
}
pub trait GitHubApi {
    fn graphql(&mut self,query:&str,variables:&Value)->Result<Value,String>;
    fn request(&mut self,path:&str,method:&str,body:Option<&Value>)
        ->Result<Value,String>;
}
pub struct GitHubStore<C:GitHubApi>{
    pub client:C,
    pub repository:String,
    pub pr_number:u64,
    pub trusted_authors:HashSet<String>,
    pub pr_node_cache:Option<Value>,
    pub comments_cache:Option<Vec<Value>>,
    pub task_overlay:HashMap<String,Value>,
    pub plan_overlay:HashMap<String,Value>,
}
impl<C:GitHubApi> GitHubStore<C>{
    pub fn new(client:C,repository:&str,pr_number:u64,
        trusted_authors:HashSet<String>,seed:Option<&Value>)->Self{
        let pr_node_cache=seed.and_then(|s|s.get("prNode"))
            .filter(|v|v.is_object()&&v.as_object().is_some_and(|o|!o.is_empty()))
            .cloned();
        let comments_cache=seed.and_then(|s|s.get("comments"))
            .and_then(Value::as_array).cloned();
        Self{client,repository:repository.into(),pr_number,trusted_authors,
            pr_node_cache,comments_cache,task_overlay:HashMap::new(),
            plan_overlay:HashMap::new()}
    }
    fn repo_parts(&self)->Result<(&str,&str),String>{
        let (owner,name)=self.repository.split_once('/')
            .ok_or_else(||format!("Invalid GitHub repository {}",self.repository))?;
        if owner.is_empty()||name.is_empty(){
            return Err(format!("Invalid GitHub repository {}",self.repository));
        }
        Ok((owner,name))
    }
    fn task_key(&self,task:&Value)->String{
        format!("{}#{}:{}/{}",self.repository,self.pr_number,
            field(task,"jobId"),field(task,"id"))
    }
    fn plan_key(&self,plan:&Value)->String{
        format!("{}#{}:{}/{}",self.repository,self.pr_number,
            field(plan,"jobId"),field(plan,"id"))
    }
    fn is_trusted(&self,comment:&Value)->bool{
        comment.get("authorLogin").and_then(Value::as_str)
            .is_some_and(|login|self.trusted_authors.contains(login))
    }
    pub fn clear_read_snapshot(&mut self){
        self.pr_node_cache=None;
        self.comments_cache=None;
    }
    pub fn pr_node(&mut self)->Result<Value,String>{
        if let Some(cached)=self.pr_node_cache.as_ref(){return Ok(cached.clone());}
        let (owner,name)=self.repo_parts()?;
        let variables=json!({"owner":owner,"name":name,"number":self.pr_number});
        let result=self.client.graphql(
            "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id state merged mergedAt closedAt body headRefName headRefOid}}}",
            &variables)?;
        let pr=result.pointer("/repository/pullRequest")
            .filter(|v|v.is_object()).cloned()
            .ok_or_else(||format!("Pull request #{} not found in {}",
                self.pr_number,self.repository))?;
        self.pr_node_cache=Some(pr.clone());
        Ok(pr)
    }
    pub fn pull_request_body(&mut self)->Result<String,String>{
        Ok(field(&self.pr_node()?,"body").to_string())
    }
    fn overlay_key(&self,body:&str,kind:&str)->Option<String>{
        match kind{
            "task"=>parse_task(body).map(|v|self.task_key(&v)),
            "plan"=>parse_plan(body).map(|v|self.plan_key(&v)),
            _=>None
        }
    }
    fn overlay_writes(&mut self,comments:Vec<Value>,kind:&str)->Vec<Value>{
        let map=if kind=="task"{self.task_overlay.clone()}
            else{self.plan_overlay.clone()};
        let mut result=comments;
        for (key,overlay) in map{
            let index=result.iter().position(|comment|
                self.overlay_key(field(comment,"body"),kind)==Some(key.clone()));
            if let Some(index)=index{
                let remote=&result[index];
                if !field(remote,"updatedAt").is_empty()
                    &&!field(&overlay,"updatedAt").is_empty()
                    &&field(remote,"updatedAt")>=field(&overlay,"updatedAt"){
                    if kind=="task"{self.task_overlay.remove(&key);}
                    else{self.plan_overlay.remove(&key);}
                    continue;
                }
                let mut revised=remote.clone();
                for value in ["body","updatedAt","authorLogin"]{
                    if let Some(v)=overlay.get(value){revised[value]=v.clone();}
                }
                result[index]=revised;
            }else if kind=="task"{self.task_overlay.remove(&key);}
            else{self.plan_overlay.remove(&key);}
        }
        result
    }
    pub fn list(&mut self)->Result<Vec<Value>,String>{
        let records=if let Some(cache)=self.comments_cache.as_ref(){
            cache.clone()
        }else{
            let (owner,name)=self.repo_parts()?;
            let variables=json!({"owner":owner,"name":name,"number":self.pr_number});
            let mut comments=Vec::new();
            let mut cursor=Value::Null;
            loop{
                let mut input=variables.clone();
                input["cursor"]=cursor;
                let response=self.client.graphql(
                    "query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){comments(first:100,after:$cursor){nodes{id databaseId url body updatedAt author{login}} pageInfo{hasNextPage endCursor}}}}}",
                    &input)?;
                let next=response.pointer("/repository/pullRequest/comments");
                for item in next.and_then(|v|v.get("nodes"))
                    .and_then(Value::as_array).into_iter().flatten(){
                    comments.push(json!({
                        "id":item.get("databaseId").and_then(Value::as_i64).unwrap_or(0),
                        "nodeId":item.get("id"),"url":item.get("url"),
                        "body":field(item,"body"),"updatedAt":field(item,"updatedAt"),
                        "authorLogin":item.pointer("/author/login")
                    }));
                }
                let more=next.and_then(|v|v.pointer("/pageInfo/hasNextPage"))
                    .and_then(Value::as_bool)==Some(true);
                cursor=next.and_then(|v|v.pointer("/pageInfo/endCursor"))
                    .cloned().unwrap_or(Value::Null);
                if !more||cursor.is_null(){break;}
            }
            self.comments_cache=Some(comments.clone());
            comments
        };
        let records=self.overlay_writes(records,"task");
        Ok(self.overlay_writes(records,"plan"))
    }
    pub fn comments(&mut self)->Result<Vec<Value>,String>{self.list()}
    pub fn pull_request_state(&mut self)->Result<&'static str,String>{
        let pr=self.pr_node()?;
        Ok(if pr.get("merged")==Some(&Value::Bool(true))
            ||pr.get("mergedAt").and_then(Value::as_str).is_some(){"MERGED"}
        else if field(&pr,"state").eq_ignore_ascii_case("closed"){"CLOSED"}
        else{"OPEN"})
    }
    pub fn pull_request_head(&mut self)->Result<Option<Value>,String>{
        let pr=self.pr_node()?;
        let head=field(&pr,"headRefName");
        let sha=field(&pr,"headRefOid");
        Ok(if head.is_empty()||sha.is_empty(){None}
            else{Some(json!({"ref":head,"sha":sha}))})
    }
    pub fn head_sha(&mut self)->Result<Option<String>,String>{
        Ok(self.pull_request_head()?.and_then(|head|
            head.get("sha").and_then(Value::as_str).map(str::to_owned)))
    }
    fn mutations_endpoint(&self)->String{
        format!("repos/{}/pulls/{}",self.repository,self.pr_number)
    }
    pub fn merge_pull_request(&mut self,expected_head:Option<&str>)
        ->Result<(),String>{
        let mut input=json!({"merge_method":"squash"});
        if let Some(sha)=expected_head.filter(|s|!s.is_empty()){
            input["sha"]=json!(sha);
        }
        let attempt=self.client.request(
            &format!("{}/merge",self.mutations_endpoint()),
            "PUT",Some(&input));
        match attempt{
            Ok(answer) if answer.get("merged")==Some(&Value::Bool(true))=>{},
            Err(error)=>{
                self.clear_read_snapshot();
                if self.pull_request_state().ok()!=Some("MERGED"){return Err(error);}
            },
            Ok(answer)=>{
                self.clear_read_snapshot();
                if self.pull_request_state().ok()!=Some("MERGED"){
                    return Err(answer.get("message").and_then(Value::as_str)
                        .map(str::to_owned).unwrap_or_else(||format!(
                            "Pull request #{} was not merged",self.pr_number)));
                }
            }
        }
        self.clear_read_snapshot();
        Ok(())
    }
    pub fn close_pull_request(&mut self)->Result<(),String>{
        self.client.request(&self.mutations_endpoint(),"PATCH",
            Some(&json!({"state":"closed"})))?;
        self.clear_read_snapshot();Ok(())
    }
    pub fn update_pull_request_body(&mut self,body:&str)->Result<(),String>{
        self.client.request(&self.mutations_endpoint(),"PATCH",
            Some(&json!({"body":body})))?;
        if let Some(pr)=self.pr_node_cache.as_mut(){pr["body"]=json!(body);}
        Ok(())
    }
    pub fn load(&mut self,job_id:&str)->Result<Value,String>{
        let comments=self.list()?.into_iter().filter(|row|self.is_trusted(row))
            .collect::<Vec<_>>();
        let body=parse_job(&self.pull_request_body()?);
        let jobs:Vec<Value>=body.map(|value|vec![value]).unwrap_or_else(||
            comments.iter().filter_map(|row|parse_job(field(row,"body")))
                .filter(|job|!field(job,"id").is_empty()).collect());
        let Some(mut job)=jobs.iter().find(|value|field(value,"id")==job_id)
            .cloned() else{
                self.clear_read_snapshot();
                if let Some(conflicting)=jobs.first(){
                    return Err(format!("JOB_ID_MISMATCH: PR #{} is bound to {}, not {job_id}",
                        self.pr_number,field(conflicting,"id")));
                }
                return Err(format!("JOB_MARKER_MISSING: Managed GitHub job {job_id} has no durable {} marker in PR #{}",
                    JOB_MARKER,self.pr_number));
            };
        let sole=jobs.len()==1;
        let mut plans=Vec::new();let mut tasks=Vec::new();
        for comment in &comments{
            if let Some(mut plan)=parse_plan(field(comment,"body")){
                if field(&plan,"jobId")!=job_id{continue;}
                if let Some(url)=comment.get("url").and_then(Value::as_str)
                    .filter(|s|!s.is_empty()){
                    plan["planUrl"]=json!(url);
                }
                plans.push(plan);
            }
            if let Some(mut task)=parse_task(field(comment,"body")){
                if !is_task_for_job(&task,job_id,sole){continue;}
                if let Some(url)=comment.get("url").and_then(Value::as_str)
                    .filter(|s|!s.is_empty()){
                    task["taskUrl"]=json!(url);
                }
                tasks.push(task);
            }
        }
        plans.sort_by_key(|p|p.get("round").and_then(Value::as_i64).unwrap_or(0));
        job["plans"]=json!(plans);job["tasks"]=json!(tasks);
        Ok(job)
    }
    pub fn validate_job_binding(&mut self,job_id:&str)->Result<(),String>{
        let body=self.pull_request_body()?;
        let marker=format!("<!-- {JOB_MARKER} ");
        let parsed=parse_job(&body);
        if body.contains(&marker)&&parsed.is_none(){
            return Err(format!("JOB_MARKER_MALFORMED: PR #{} body contains a {JOB_MARKER} marker that cannot be parsed",
                self.pr_number));
        }
        if let Some(bound)=parsed{
            return if field(&bound,"id")==job_id{Ok(())}
            else{Err(format!("JOB_ID_MISMATCH: PR #{} is bound to {}, not {job_id}",
                self.pr_number,field(&bound,"id")))};
        }
        let comments=self.list()?.into_iter().filter(|row|self.is_trusted(row))
            .filter(|row|field(row,"body").contains(JOB_MARKER))
            .collect::<Vec<_>>();
        let mut found=Vec::new();let mut malformed=0;
        for comment in comments{
            if let Some(job)=parse_job(field(&comment,"body")){found.push(job);}
            else{malformed+=1;}
        }
        if malformed>0{
            return Err(format!("JOB_MARKER_MALFORMED: PR #{} contains {malformed} trusted {JOB_MARKER} marker(s) that cannot be parsed",
                self.pr_number));
        }
        let matches=found.iter().filter(|job|field(job,"id")==job_id).count();
        if matches==0{
            return if found.is_empty(){
                Err(format!("JOB_MARKER_MISSING: Managed GitHub job {job_id} has no durable {JOB_MARKER} marker in PR #{}",
                    self.pr_number))
            }else{Err(format!("JOB_ID_MISMATCH: PR #{} is bound to {}, not {job_id}",
                self.pr_number,found.iter().map(|j|field(j,"id")).collect::<Vec<_>>().join(", ")))};
        }
        if matches>1{
            return Err(format!("JOB_MARKER_DUPLICATED: PR #{} contains {matches} trusted {JOB_MARKER} markers for job {job_id}",
                self.pr_number));
        }
        if found.len()>1{
            return Err(format!("JOB_BINDING_CONFLICT: PR #{} contains trusted {JOB_MARKER} markers for multiple job ids",
                self.pr_number));
        }
        Ok(())
    }
    fn comment(&mut self,body:&str)->Result<Value,String>{
        let pr=self.pr_node()?;
        let data=self.client.graphql(
            "mutation($subjectId:ID!,$body:String!){addComment(input:{subjectId:$subjectId,body:$body}){commentEdge{node{id databaseId url body updatedAt author{login}}}}}",
            &json!({"subjectId":pr.get("id"),"body":body}))?;
        let node=data.pointer("/addComment/commentEdge/node")
            .ok_or("GitHub addComment returned no comment node")?;
        let comment=json!({
            "id":node.get("databaseId").and_then(Value::as_i64).unwrap_or(0),
            "nodeId":node.get("id"),"url":node.get("url"),
            "body":node.get("body").cloned().unwrap_or(json!(body)),
            "updatedAt":node.get("updatedAt").and_then(Value::as_str)
                .unwrap_or(""),
            "authorLogin":node.pointer("/author/login")
                .or_else(||self.trusted_authors.iter().next().map(|s|s as &str)
                    .map(|s|{let _=s;&Value::Null}))
        });
        if let Some(cache)=self.comments_cache.as_mut(){cache.push(comment.clone());}
        Ok(comment)
    }
    fn update_comment(&mut self,comment:&Value,body:&str)
        ->Result<Value,String>{
        let node=field(comment,"nodeId");
        if node.is_empty(){
            return Err("GitHub comment node id is required for GraphQL update".into());
        }
        let data=self.client.graphql(
            "mutation($id:ID!,$body:String!){updateIssueComment(input:{id:$id,body:$body}){issueComment{id databaseId url body updatedAt author{login}}}}",
            &json!({"id":node,"body":body}))?;
        let updated=data.pointer("/updateIssueComment/issueComment")
            .ok_or("GitHub updateIssueComment returned no result")?;
        let mut value=comment.clone();
        for (source,dest) in [
            ("id","nodeId"),("databaseId","id"),
            ("url","url"),("body","body"),("updatedAt","updatedAt")
        ] {
            if let Some(update)=updated.get(source){value[dest]=update.clone();}
        }
        value["authorLogin"]=updated.pointer("/author/login")
            .cloned().unwrap_or_else(||comment.get("authorLogin")
                .cloned().unwrap_or(Value::Null));
        if let Some(cache)=self.comments_cache.as_mut(){
            if let Some(old)=cache.iter_mut().find(|row|
                row.get("nodeId")==comment.get("nodeId")){
                *old=value.clone();
            }
        }
        Ok(value)
    }
    fn delete_comment(&mut self,comment:&Value)->Result<(),String>{
        let node=field(comment,"nodeId");
        if node.is_empty(){return Err(
            "GitHub comment node id is required for GraphQL delete".into());}
        self.client.graphql(
            "mutation($id:ID!){deleteIssueComment(input:{id:$id}){clientMutationId}}",
            &json!({"id":node}))?;
        if let Some(cache)=self.comments_cache.as_mut(){
            cache.retain(|row|row.get("nodeId")!=comment.get("nodeId"));
        }
        Ok(())
    }
    fn trusted_comments(&mut self)->Result<Vec<Value>,String>{
        Ok(self.list()?.into_iter().filter(|comment|self.is_trusted(comment))
            .collect())
    }
    pub fn save_job(&mut self,job:&Value)->Result<(),String>{
        let body=self.pull_request_body()?;
        let bound=parse_job(&body);
        if bound.as_ref().is_some_and(|value|value.get("id")!=job.get("id")){
            return Err(format!("PR #{} body already has a different {JOB_MARKER} marker",
                self.pr_number));
        }
        let comments=self.trusted_comments()?;
        let historical:Vec<Value>=comments.into_iter().filter(|row|
            parse_job(field(row,"body")).is_some()).collect();
        if historical.iter().any(|row|parse_job(field(row,"body"))
            .is_some_and(|existing|existing.get("id")!=job.get("id"))){
            return Err(format!("PR #{} already has a different {JOB_MARKER} marker",
                self.pr_number));
        }
        let next=render_job_body(job);
        if body!=next{
            self.update_pull_request_body(&next)?;
            if parse_job(&self.pull_request_body()?).is_none_or(|stored|
                stored.get("id")!=job.get("id")){
                return Err(format!("Failed to persist {JOB_MARKER} marker in PR #{} body for job {}",
                    self.pr_number,field(job,"id")));
            }
        }
        for prior in historical{
            self.delete_comment(&prior)?;
        }
        Ok(())
    }
    pub fn append_plan(&mut self,plan:&Value)->Result<(),String>{
        self.load(field(plan,"jobId"))?;
        let comments=self.trusted_comments()?;
        let matches:Vec<Value>=comments.into_iter().filter(|row|
            parse_plan(field(row,"body")).is_some_and(|prior|
                prior.get("jobId")==plan.get("jobId")
                    &&prior.get("id")==plan.get("id"))).collect();
        if matches.is_empty(){
            let body=render_plan_comment(plan);
            let saved=self.comment(&body)?;
            self.plan_overlay.insert(self.plan_key(plan),json!({
                "body":body,"updatedAt":saved.get("updatedAt")}));
            return Ok(());
        }
        if !matches.iter().all(|row|parse_plan(field(row,"body"))
            .is_some_and(|prior|same_plan_definition(&prior,plan))){
            return Err(format!("Plan {} already exists with a different definition",
                field(plan,"id")));
        }
        for duplicate in matches.iter().skip(1){self.delete_comment(duplicate)?;}
        Ok(())
    }
    pub fn save_plan(&mut self,plan:&Value)->Result<(),String>{
        self.load(field(plan,"jobId"))?;
        let comments=self.trusted_comments()?;
        let matches:Vec<Value>=comments.into_iter().filter(|row|
            parse_plan(field(row,"body")).is_some_and(|prior|
                prior.get("jobId")==plan.get("jobId")
                    &&prior.get("id")==plan.get("id"))).collect();
        if matches.is_empty(){return self.append_plan(plan);}
        let body=render_plan_comment(plan);
        let saved=self.update_comment(&matches[0],&body)?;
        self.plan_overlay.insert(self.plan_key(plan),json!({
            "body":body,"updatedAt":saved.get("updatedAt")}));
        for duplicate in matches.iter().skip(1){self.delete_comment(duplicate)?;}
        Ok(())
    }
    pub fn append_task(&mut self,task:&Value)->Result<(),String>{
        let id=field(task,"jobId");
        if id.is_empty(){return Err("GitHub task requires jobId".into());}
        self.load(id)?;
        let comments=self.trusted_comments()?;
        let matches:Vec<Value>=comments.into_iter().filter(|row|
            parse_task(field(row,"body")).is_some_and(|prior|
                prior.get("jobId")==task.get("jobId")
                    &&prior.get("id")==task.get("id"))).collect();
        if matches.is_empty(){
            let body=render_task_comment(task);
            let saved=self.comment(&body)?;
            self.task_overlay.insert(self.task_key(task),json!({
                "body":body,"updatedAt":saved.get("updatedAt")}));
            return Ok(());
        }
        if !matches.iter().all(|row|parse_task(field(row,"body"))
            .is_some_and(|prior|same_task_definition(&prior,task))){
            return Err(format!("Task {} already exists with a different definition",
                field(task,"id")));
        }
        for duplicate in matches.iter().skip(1){self.delete_comment(duplicate)?;}
        Ok(())
    }
    pub fn save_task(&mut self,task:&Value)->Result<(),String>{
        let comments=self.trusted_comments()?;
        let matches:Vec<Value>=comments.into_iter().filter(|row|
            parse_task(field(row,"body")).is_some_and(|prior|
                prior.get("jobId")==task.get("jobId")
                    &&prior.get("id")==task.get("id"))).collect();
        if matches.is_empty(){return self.append_task(task);}
        let body=render_task_comment(task);
        let saved=self.update_comment(&matches[0],&body)?;
        self.task_overlay.insert(self.task_key(task),json!({
            "body":body,"updatedAt":saved.get("updatedAt")}));
        for duplicate in matches.iter().skip(1){self.delete_comment(duplicate)?;}
        Ok(())
    }
    pub fn list_agents(&mut self)->Result<Vec<Value>,String>{
        Ok(self.trusted_comments()?.iter().filter_map(|row|
            parse_agent(field(row,"body"))).collect())
    }
    pub fn save_agent(&mut self,agent:&Value)->Result<(),String>{
        let matches=self.trusted_comments()?.into_iter().filter(|row|
            parse_agent(field(row,"body")).is_some_and(|prior|
                prior.get("id")==agent.get("id"))).collect::<Vec<_>>();
        let body=render_agent_comment(agent);
        if let Some(existing)=matches.first(){
            self.update_comment(existing,&body)?;
        }else{self.comment(&body)?;}
        Ok(())
    }
    pub fn append_task_history_comment(&mut self,comment:&Value)
        ->Result<(),String>{
        let key=field(comment,"idempotencyKey");
        let task=field(comment,"taskId");
        if key.is_empty()||task.is_empty()||field(comment,"jobId").is_empty(){
            return Err("Task history projection requires durable identity".into());
        }
        let marker=format!("<!-- agents-relay:task-comment:v1 key={key} -->");
        if self.trusted_comments()?.iter().any(|c|field(c,"body").contains(&marker)){
            return Ok(());
        }
        let body=format!("{marker}\n**Task {task} · {}**\n\n{}",
            comment.get("kind").and_then(Value::as_str)
                .unwrap_or("history"),field(comment,"text"));
        if let Err(err)=self.comment(&body){
            self.clear_read_snapshot();
            return Err(err);
        }
        Ok(())
    }
}

impl<C:GitHubApi> crate::blocker_store_port::CrossJobBlockerStore for GitHubStore<C>{
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        GitHubStore::load(self,id)
    }
    fn save_job(&mut self,job:&Value)->Result<(),String>{
        GitHubStore::save_job(self,job)
    }
    fn save_task(&mut self,task:&Value)->Result<(),String>{
        GitHubStore::save_task(self,task)
    }
    fn mutate_job(&mut self,id:&str,
        update:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        // Node GitHub DurableStore has no native atomic mutateJob.
        // It uses exactly the read -> computed update -> write fallback.
        let current=GitHubStore::load(self,id)?;
        let next=update(current)?;
        GitHubStore::save_job(self,&next)?;
        Ok(next)
    }
}
impl<C:GitHubApi> GitHubStore<C>{
    pub fn register_blocker_dependent(
        &mut self,directory:&std::path::Path,job_id:&str,dependent:&Value,
        related:Option<&mut dyn crate::blocker_store_port::CrossJobBlockerStore>,
        now:Option<&str>,
    )->Result<(),String>{
        crate::blocker_store_port::register_blocker_dependent(
            directory,self,job_id,dependent,related,now).map(|_|())
    }
    pub fn resolve_blocker_dependents(
        &mut self,directory:&std::path::Path,job_id:&str,resolution:&str,
        related:Option<&mut dyn FnMut(&str,u64)->Result<
            Box<dyn crate::blocker_store_port::CrossJobBlockerStore>,String>>,
        now:Option<&str>,
    )->Result<Value,String>{
        crate::blocker_store_port::resolve_blocker_dependents(
            directory,self,job_id,resolution,related,now)
    }
}
