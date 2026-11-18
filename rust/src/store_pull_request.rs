// Node provenance: src/store.ts resolvePullRequest. This module owns only the
// GitHub collaboration PR lookup/create compatibility transport, not Task or
// Job lifecycle. A GitHubApi port provides actual effects (in tests, a mock).
use crate::store_github::GitHubApi;
use serde_json::{json,Value};

fn field<'a>(item:&'a Value,key:&str)->&'a str{
    item.get(key).and_then(Value::as_str).unwrap_or("")
}
fn repository_parts(repo:&str)->Result<(&str,&str),String>{
    let (owner,name)=repo.split_once('/').ok_or_else(||
        format!("Invalid GitHub repository {repo}"))?;
    if owner.is_empty()||name.is_empty(){
        Err(format!("Invalid GitHub repository {repo}"))
    }else{Ok((owner,name))}
}
fn parse_pr(value:&Value)->Result<Value,String>{
    let number=value.get("number").and_then(Value::as_i64)
        .or_else(||value.get("number").and_then(Value::as_str)
            .and_then(|number|number.parse::<i64>().ok()))
        .unwrap_or(0);
    let head=value.get("headRefName").and_then(Value::as_str)
        .or_else(||value.pointer("/head/ref").and_then(Value::as_str))
        .unwrap_or("");
    let base=value.get("baseRefName").and_then(Value::as_str)
        .or_else(||value.pointer("/base/ref").and_then(Value::as_str))
        .unwrap_or("");
    if number<=0||head.is_empty()||base.is_empty(){
        return Err("Invalid GitHub pull request response".into());
    }
    Ok(json!({"number":number,"title":field(value,"title"),
        "body":field(value,"body"),"state":field(value,"state"),
        "head":head,"base":base}))
}
fn gql<C:GitHubApi>(client:&mut C,query:&str,variables:&Value)
    ->Result<Value,String>{client.graphql(query,variables)}
const BY_NUMBER:&str="query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){number title body state headRefName baseRefName}}}";
const FIND:&str="query($owner:String!,$name:String!,$head:String!,$base:String!){repository(owner:$owner,name:$name){pullRequests(first:20,states:OPEN,headRefName:$head,baseRefName:$base){nodes{number title body state headRefName baseRefName}}}}";
const REF:&str="query($owner:String!,$name:String!,$head:String!,$base:String!){repository(owner:$owner,name:$name){head:ref(qualifiedName:$head){target{... on Commit{oid tree{oid}}}} base:ref(qualifiedName:$base){target{... on Commit{oid tree{oid}}}}}}";
const REPO:&str="query($owner:String!,$name:String!){repository(owner:$owner,name:$name){id}}";
const CREATE:&str="mutation($repositoryId:ID!,$base:String!,$head:String!,$title:String!,$body:String!){createPullRequest(input:{repositoryId:$repositoryId,baseRefName:$base,headRefName:$head,title:$title,body:$body}){pullRequest{number title body state headRefName baseRefName}}}";
fn find<C:GitHubApi>(client:&mut C,owner:&str,name:&str,head:&str,base:&str)
    ->Result<Option<Value>,String>{
    let found=gql(client,FIND,&json!({
        "owner":owner,"name":name,"head":head,"base":base}))?;
    let rows=found.pointer("/repository/pullRequests/nodes")
        .and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    // Node parses each candidate before testing identity, so malformed PRs
    // must fail closed instead of silently being ignored.
    for row in rows{
        let pr=parse_pr(row)?;
        if pr["head"]==head&&pr["base"]==base{return Ok(Some(pr));}
    }
    Ok(None)
}
fn compare_no_ahead<C:GitHubApi>(
    client:&mut C,repository:&str,base:&str,head:&str,
)->Result<bool,String>{
    let escaped=|v:&str|url::form_urlencoded::byte_serialize(v.as_bytes())
        .collect::<String>();
    let path=format!("repos/{repository}/compare/{}...{}",
        escaped(base),escaped(head));
    match client.request(&path,"GET",None){
        Ok(response)=>{
            // Node Number(undefined) is NaN, so missing ahead_by is not zero.
            let ahead=response.get("ahead_by").and_then(Value::as_i64)
                .or_else(||response.get("ahead_by").and_then(Value::as_str)
                    .and_then(|s|s.parse::<i64>().ok()));
            Ok(ahead==Some(0))
        },
        Err(error) if error.to_ascii_lowercase().contains("404")
            ||error.to_ascii_lowercase().contains("not found")=>Ok(true),
        Err(error)=>Err(error)
    }
}
fn bootstrap<C:GitHubApi>(
    client:&mut C,repository:&str,owner:&str,name:&str,base:&str,head:&str,
)->Result<(),String>{
    let result=gql(client,REF,&json!({"owner":owner,"name":name,
        "head":format!("refs/heads/{head}"),
        "base":format!("refs/heads/{base}")}))?;
    let head_ref=&result["repository"]["head"];
    let target=if head_ref.is_null(){
        &result["repository"]["base"]["target"]
    }else{&head_ref["target"]};
    let oid=field(target,"oid");
    let tree=target.pointer("/tree/oid").and_then(Value::as_str).unwrap_or("");
    if oid.is_empty()||tree.is_empty(){
        return Err(format!("Unable to resolve head branch {head} or base branch {base}"));
    }
    if head_ref.is_null(){
        client.request(&format!("repos/{repository}/git/refs"),"POST",Some(
            &json!({"ref":format!("refs/heads/{head}"),"sha":oid})))?;
    }
    let created=client.request(&format!("repos/{repository}/git/commits"),
        "POST",Some(&json!({"message":"chore: bootstrap Agents Relay job",
            "tree":tree,"parents":[oid]})))?;
    let sha=field(&created,"sha");
    if sha.is_empty(){return Err(format!(
        "Unable to create bootstrap commit for {head}"));}
    client.request(&format!("repos/{repository}/git/refs/heads/{head}"),
        "PATCH",Some(&json!({"sha":sha,"force":false})))?;
    Ok(())
}
fn create<C:GitHubApi>(
    client:&mut C,repository_id:&str,head:&str,base:&str,title:&str,body:&str,
)->Result<Value,String>{
    let result=gql(client,CREATE,&json!({"repositoryId":repository_id,
        "base":base,"head":head,"title":title,"body":body}))?;
    let pr=result.pointer("/createPullRequest/pullRequest")
        .filter(|pr|pr.is_object())
        .ok_or("GitHub createPullRequest returned no pull request")?;
    parse_pr(pr)
}
/// Real GraphQL/Get/POST/PATCH operations, including compare/bootstrap/race
/// recovery. Network side effects require explicit injected GitHubApi client.
pub fn resolve_pull_request<C:GitHubApi>(
    client:&mut C,repository:&str,options:&Value,
)->Result<Value,String>{
    let (owner,name)=repository_parts(repository)?;
    if let Some(number)=options.get("prNumber").and_then(Value::as_i64)
        .filter(|number|*number!=0){
        let query=gql(client,BY_NUMBER,&json!({
            "owner":owner,"name":name,"number":number}))?;
        let pr=query.pointer("/repository/pullRequest")
            .filter(|value|value.is_object())
            .ok_or_else(||format!("Pull request #{number} not found"))?;
        return parse_pr(pr);
    }
    let head=options.get("head").and_then(Value::as_str)
        .filter(|head|!head.is_empty())
        .ok_or("--head is required when --pr is not provided")?;
    let base=options.get("base").and_then(Value::as_str)
        .filter(|base|!base.is_empty()).unwrap_or("main");
    if let Some(existing)=find(client,owner,name,head,base)?{
        return Ok(existing);
    }
    let title=options.get("title").and_then(Value::as_str)
        .filter(|value|!value.is_empty())
        .ok_or("--title is required when creating a pull request")?;
    if compare_no_ahead(client,repository,base,head)?{
        bootstrap(client,repository,owner,name,base,head)?;
        if let Some(created)=find(client,owner,name,head,base)?{
            return Ok(created);
        }
    }
    let repository_data=gql(client,REPO,&json!({
        "owner":owner,"name":name}))?;
    let repository_id=repository_data.pointer("/repository/id")
        .and_then(Value::as_str).ok_or_else(||
            format!("Repository {repository} not found"))?;
    match create(client,repository_id,head,base,title,
        options.get("body").and_then(Value::as_str).unwrap_or("")){
        Ok(value)=>Ok(value),
        Err(error)=>{
            if let Some(existing)=find(client,owner,name,head,base)?{
                return Ok(existing);
            }
            if error.to_ascii_lowercase().contains("no commits between"){
                bootstrap(client,repository,owner,name,base,head)?;
                if let Some(existing)=find(client,owner,name,head,base)?{
                    return Ok(existing);
                }
                return create(client,repository_id,head,base,title,
                    options.get("body").and_then(Value::as_str).unwrap_or(""));
            }
            Err(error)
        }
    }
}
