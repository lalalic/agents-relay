// Node provenance: src/workspace.ts. Canonical local Git roots, stable
// per-Job worktrees and conservative cleanup. Never resets dirty worktrees,
// never switches the user's primary Git checkout and never requires GitHub.
use crate::{
    continuation::{run_delivery_owned_process,DeliveryProcessOptions},
    owned_process::OwnedProcessManager,
};
use regex::Regex;
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{
    collections::HashMap,
    fs,path::{Path,PathBuf},
};
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn project_root<'a>(job:&'a Value)->&'a str{
    field(job,"projectRoot")
}
fn to_abs(raw:&Path)->Result<PathBuf,String>{
    let input=if raw.is_absolute(){raw.to_path_buf()}else{
        std::env::current_dir().map_err(|e|e.to_string())?.join(raw)
    };
    let mut normalized=PathBuf::new();
    for component in input.components(){
        use std::path::Component::*;
        match component {
            ParentDir=>{normalized.pop();},
            CurDir=>{},
            other=>normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
fn git(repo:&Path,args:&[&str])->Result<String,String>{
    let mut manager=OwnedProcessManager::default();
    let mut argv=vec!["-C".to_string(),repo.to_string_lossy().into_owned()];
    argv.extend(args.iter().map(|s|(*s).into()));
    let refs=argv.iter().map(String::as_str).collect::<Vec<_>>();
    let response=run_delivery_owned_process(
        &mut manager,"git",&refs,None,"workspace.git",
        DeliveryProcessOptions{timeout:None,cancelled:None,
            supervisor_path:None,environment:None})?;
    if response.code!=0 {
        return Err(if response.stderr.trim().is_empty(){
            format!("git exited {}",response.code)
        }else{response.stderr.trim().to_string()});
    }
    Ok(response.stdout.trim().to_string())
}
fn git_ok(repo:&Path,args:&[&str])->bool{git(repo,args).is_ok()}
pub fn validate_project_root(
    root:&Path,repository:&str,
)->Result<PathBuf,String>{
    if !root.is_absolute(){
        return Err("Job projectRoot must be absolute".into());
    }
    let canonical=fs::canonicalize(root).map_err(|e|e.to_string())?;
    let reported=git(&canonical,&["rev-parse","--show-toplevel"])?;
    let real_root=fs::canonicalize(&reported).map_err(|e|e.to_string())?;
    if canonical!=real_root{
        return Err(format!("Job projectRoot must be the canonical Git root: {}",
            real_root.display()));
    }
    let git_dir=git(&canonical,&["rev-parse","--absolute-git-dir"])?;
    let common=git(&canonical,&["rev-parse","--path-format=absolute",
        "--git-common-dir"])?;
    let git_dir=fs::canonicalize(git_dir).map_err(|e|e.to_string())?;
    let common=fs::canonicalize(common).map_err(|e|e.to_string())?;
    if git_dir!=common{
        return Err("Job projectRoot must be the primary Git checkout, not a linked worktree".into());
    }
    let basename=real_root.file_name().and_then(|s|s.to_str()).unwrap_or("");
    if basename!=repository{
        return Err(format!("Local repository identity {repository} does not match Git root name {basename}"));
    }
    Ok(real_root)
}
pub fn optional_github_repository(project:&Path)->Option<String>{
    github_repository_from_remote(&git(project,&["remote","get-url","origin"]).ok()?)
}
pub fn github_repository_from_remote(remote:&str)->Option<String>{
    let raw=remote.trim().trim_end_matches(".git");
    let regex=Regex::new(r"(?i)github\.com[/:]([^/]+)/([^/]+)$").ok()?;
    let caps=regex.captures(raw)?;
    Some(format!("{}/{}",&caps[1],&caps[2]))
}
pub fn default_workspace_root()->PathBuf{
    PathBuf::from(std::env::var("HOME").unwrap_or_default()).join("Workspace")
}
pub fn resolve_workspace_root(
    explicit:Option<&str>,
)->Result<PathBuf,String>{
    let configured=explicit.map(str::to_owned)
        .or_else(||std::env::var("AGENTS_RELAY_WORKSPACE_ROOT").ok());
    let Some(configured)=configured else{return Ok(default_workspace_root());};
    let candidate=to_abs(Path::new(&configured))?;
    if !candidate.is_dir(){
        return Err(format!("Configured Workspace Root is not an accessible directory: {}",
            candidate.display()));
    }
    fs::canonicalize(&candidate).map_err(|_|
        format!("Configured Workspace Root is not an accessible directory: {}",
            candidate.display()))
}
fn walk(root:&Path,results:&mut Vec<PathBuf>){
    if root.join(".git").exists(){results.push(root.to_path_buf());}
    let Ok(entries)=fs::read_dir(root)else{return;};
    for entry in entries.flatten(){
        let name=entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.')||matches!(name.as_str(),
            "node_modules"|"runs"|"dist"|"build"|"vendor"|"coverage"|".worktrees"){
            continue;
        }
        if entry.file_type().is_ok_and(|ty|ty.is_dir()){
            walk(&entry.path(),results);
        }
    }
}
pub fn discover_git_repositories(root:&Path)->Vec<PathBuf>{
    let mut result=Vec::new();
    let root=to_abs(root).unwrap_or_else(|_|root.to_path_buf());
    walk(&root,&mut result);
    result.sort_by(|a,b|a.strip_prefix(&root).unwrap_or(a)
        .cmp(b.strip_prefix(&root).unwrap_or(b)));
    result
}
pub fn discover_workspace_repositories(root:&Path)->Result<Vec<Value>,String>{
    let mut by_name=HashMap::<String,String>::new();
    let mut entries=Vec::new();
    for repo in discover_git_repositories(root){
        let actual=fs::canonicalize(&repo).map_err(|e|e.to_string())?;
        let name=repo.file_name().and_then(|s|s.to_str()).unwrap_or("").to_string();
        let path=actual.to_string_lossy().to_string();
        if let Some(previous)=by_name.get(&name){
            if previous!=&path{
                return Err(format!("Local repository identity collision {name}: {previous} and {path}"));
            }
        }
        by_name.insert(name.clone(),path.clone());
        entries.push(json!({"path":path,"repository":name}));
    }
    entries.sort_by(|a,b|field(a,"repository").cmp(field(b,"repository")));
    Ok(entries)
}
pub fn resolve_workspace_repository_path(
    repository:&str,root:&Path,
)->Result<PathBuf,String>{
    let match_repo=discover_workspace_repositories(root)?
        .into_iter().find(|entry|field(entry,"repository")==repository);
    match match_repo {
        Some(entry)=>Ok(PathBuf::from(field(&entry,"path"))),
        None=>Err(format!("Repository {repository} not found under workspace {}; provide the canonical Git root explicitly",
            to_abs(root)?.display()))
    }
}
pub fn resolve_managed_project_path(
    repository:Option<&str>,explicit:Option<&str>,
    root:&Path,cwd:&Path,
)->Result<PathBuf,String>{
    if let Some(explicit)=explicit.filter(|s|!s.is_empty()){
        return to_abs(Path::new(explicit));
    }
    if let Some(repository)=repository{
        return resolve_workspace_repository_path(repository,root);
    }
    to_abs(cwd)
}
pub fn resolve_job_project_root(job:&Value)->Result<PathBuf,String>{
    let raw=project_root(job);
    if raw.is_empty(){
        return Err(format!("Job {} is missing its immutable local projectRoot",
            field(job,"id")));
    }
    validate_project_root(Path::new(raw),field(job,"repository"))
}
pub fn is_project_run_path(path:Option<&str>)->bool{
    let Some(path)=path.filter(|s|!s.is_empty())else{return false;};
    let normalized=path.replace('\\',"/");
    let normalized=normalized.strip_prefix("./").unwrap_or(&normalized);
    normalized=="runs"||normalized.starts_with("runs/")
}
pub fn task_uses_canonical_project_run(task:&Value,tasks:&[Value])->bool{
    let mut seen=std::collections::HashSet::new();
    let mut current=Some(task);
    while let Some(item)=current{
        if !seen.insert(field(item,"id")){break;}
        if item.pointer("/output/kind").and_then(Value::as_str)==Some("file")
            &&is_project_run_path(item.pointer("/output/path").and_then(Value::as_str)){
            return true;
        }
        current=item.get("parentTaskId").and_then(Value::as_str)
            .and_then(|id|tasks.iter().find(|candidate|field(candidate,"id")==id));
    }
    false
}
pub fn managed_job_worktree_path(
    repository:&str,pr_number:u64,workspace:&Path,
)->Result<PathBuf,String>{
    let pattern=Regex::new(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
        .expect("managed GitHub repository syntax");
    if !pattern.is_match(repository)||pr_number==0{
        return Err("Invalid managed Job checkout identity".into());
    }
    Ok(workspace.join(".worktrees").join("agents-relay").join(
        format!("{}-pr-{pr_number}",repository.replace('/',"-"))).join("job"))
}
pub fn managed_local_job_worktree_path(
    repository:&str,job_id:&str,workspace:&Path,
)->Result<PathBuf,String>{
    let repo=Regex::new(r"^[A-Za-z0-9_.-]+$").expect("local repository syntax");
    if !repo.is_match(repository)||job_id.trim().is_empty(){
        return Err("Invalid local Job checkout identity".into());
    }
    let safe=Regex::new(r"[^A-Za-z0-9_.-]+").unwrap()
        .replace_all(job_id,"-").chars().take(72).collect::<String>();
    let safe=if safe.is_empty(){"job"}else{safe.as_str()};
    let digest=format!("{:x}",Sha256::digest(job_id.as_bytes()));
    Ok(workspace.join(".worktrees").join("agents-relay").join(
        format!("{repository}-job-{safe}-{}",&digest[..12])).join("job"))
}
pub fn job_requires_managed_worktree(job:&Value)->bool{
    job.pointer("/localMerge/sourceRef")
        .and_then(Value::as_str).is_some_and(|s|!s.is_empty())
        ||job.get("tasks").and_then(Value::as_array).into_iter().flatten()
            .any(|task|task.pointer("/output/kind").and_then(Value::as_str)==Some("task_pr"))
}
pub fn task_requires_managed_worktree(job:&Value,task:Option<&Value>)->bool{
    job_requires_managed_worktree(job)
        &&!task.is_some_and(|task|
            task_uses_canonical_project_run(task,job.get("tasks")
                .and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])))
}
fn is_source_ref(value:&str)->bool{
    let regex=Regex::new(r"^refs/heads/[A-Za-z0-9][A-Za-z0-9._/-]*$")
        .expect("Git source ref regex");
    regex.is_match(value)&&!value.contains("..")&&!value.ends_with(".lock")
}
fn owner_match(primary:&Path,job:&Value)->Result<(),String>{
    let root=fs::canonicalize(git(primary,&["rev-parse","--show-toplevel"])?)
        .map_err(|e|e.to_string())?;
    let expected=fs::canonicalize(project_root(job)).map_err(|e|e.to_string())?;
    let name=root.file_name().and_then(|s|s.to_str()).unwrap_or("");
    if root!=expected||name!=field(job,"repository"){
        return Err(format!("Job {} projectRoot identity mismatch",field(job,"id")));
    }
    Ok(())
}
pub fn ensure_local_job_source_branch(
    project:&Path,job:&Value,
)->Result<String,String>{
    let existing=field(&job["localMerge"],"sourceRef");
    if !existing.is_empty(){
        if job.pointer("/localMerge/targetRef").and_then(Value::as_str)
            !=Some("refs/heads/main"){
            return Err("Local Job target must be main".into());
        }
        return Ok(existing.into());
    }
    let raw=field(job,"id");
    let safe=Regex::new(r"[^A-Za-z0-9_.-]+").unwrap()
        .replace_all(raw,"-").chars().take(48).collect::<String>();
    let digest=format!("{:x}",Sha256::digest(raw.as_bytes()));
    let source=format!("refs/heads/relay/job-{safe}-{}",&digest[..12]);
    let primary=PathBuf::from(git(project,&["rev-parse","--show-toplevel"])?);
    owner_match(&primary,job)?;
    let main=git(&primary,&["rev-parse","--verify","refs/heads/main"])?;
    if !git_ok(&primary,&["show-ref","--verify","--quiet",&source]){
        if git(&primary,&["update-ref",&source,&main,
            "0000000000000000000000000000000000000000"]).is_err()
            &&!git_ok(&primary,&["show-ref","--verify",&source]){
            return Err("Concurrent source branch creation did not preserve branch".into());
        }
    }
    Ok(source)
}
pub fn prepare_local_job_execution_worktree(
    project:&Path,job:&Value,workspace:&Path,
)->Result<PathBuf,String>{
    let source=field(&job["localMerge"],"sourceRef");
    if source.is_empty(){return resolve_job_project_root(job);}
    if !is_source_ref(source){
        return Err("Local Job execution requires a valid refs/heads sourceRef".into());
    }
    let primary=PathBuf::from(git(project,&["rev-parse","--show-toplevel"])?);
    owner_match(&primary,job)?;
    let source_sha=git(&primary,&["rev-parse","--verify",source])?;
    let current_branch=git(&primary,&["symbolic-ref","-q","HEAD"])
        .unwrap_or_default();
    if current_branch==source{
        let current_sha=git(&primary,&["rev-parse","HEAD"])?;
        if current_sha!=source_sha{
            return Err(format!("Canonical source branch {source} changed while preparing execution checkout"));
        }
        return Ok(primary);
    }
    let checkout=managed_local_job_worktree_path(
        field(job,"repository"),field(job,"id"),workspace)?;
    let parent=checkout.parent().ok_or("Local worktree missing parent")?;
    fs::create_dir_all(parent).map_err(|e|e.to_string())?;
    if checkout.exists(){
        let existing=git(&checkout,&["rev-parse","--show-toplevel"])?;
        if fs::canonicalize(existing).map_err(|e|e.to_string())?
            !=fs::canonicalize(&checkout).map_err(|e|e.to_string())?{
            return Err(format!("Worktree ownership mismatch: {}",checkout.display()));
        }
        let branch=git(&checkout,&["symbolic-ref","HEAD"])?;
        if branch!=source{
            return Err(format!("Local Job worktree is bound to {branch}, expected {source}"));
        }
        let current=git(&checkout,&["rev-parse","HEAD"])?;
        if current!=source_sha{
            if !git(&checkout,&["status","--porcelain"])?.is_empty(){
                return Err(format!("Local Job worktree has changes while source ref advanced: {}",
                    checkout.display()));
            }
            if !git_ok(&checkout,&["merge-base","--is-ancestor",&current,&source_sha]){
                return Err(format!("Local Job worktree has non-fast-forward history; preserve commits: {}",
                    checkout.display()));
            }
            git(&checkout,&["merge","--ff-only",&source_sha])?;
        }
        return Ok(checkout);
    }
    git(&primary,&["worktree","add",&checkout.to_string_lossy(),
        source.trim_start_matches("refs/heads/")])?;
    Ok(checkout)
}
pub fn cleanup_completed_job_worktree(
    project:&Path,job:&Value,workspace:&Path,
)->Result<Value,String>{
    if field(job,"state")!="COMPLETED"
        ||job.pointer("/localMerge/status").and_then(Value::as_str)!=Some("succeeded"){
        return Ok(json!({"status":"blocked","reason":"Job is not merged and completed"}));
    }
    let source_sha=job.pointer("/localMerge/sourceSha").and_then(Value::as_str).unwrap_or("");
    let merged_sha=job.pointer("/localMerge/mergedCommitSha").and_then(Value::as_str).unwrap_or("");
    let branch=field(&job["localMerge"],"sourceRef");
    if source_sha.is_empty()||merged_sha.is_empty()||branch.is_empty(){
        return Ok(json!({"status":"blocked","reason":"No immutable merge delivery evidence"}));
    }
    let primary=fs::canonicalize(project).map_err(|e|e.to_string())?;
    let checkout=managed_local_job_worktree_path(
        field(job,"repository"),field(job,"id"),workspace)?;
    if !checkout.exists(){return Ok(json!({"status":"absent"}));}
    if fs::canonicalize(&checkout).map_err(|e|e.to_string())? ==primary {
        return Ok(json!({"status":"blocked","reason":"Refuses to remove primary checkout"}));
    }
    let registered=git(&primary,&["worktree","list","--porcelain"])?;
    let owned=fs::canonicalize(&checkout).map_err(|e|e.to_string())?;
    let registered_paths:Vec<PathBuf>=registered.lines()
        .filter_map(|line|line.strip_prefix("worktree "))
        .filter_map(|path|fs::canonicalize(path).ok()).collect();
    if !registered_paths.contains(&owned){
        return Ok(json!({"status":"blocked",
            "reason":"Worktree is not registered with the canonical repository"}));
    }
    let head=git(&checkout,&["rev-parse","HEAD"])?;
    if head!=source_sha{
        return Ok(json!({"status":"blocked",
            "reason":"Worktree contains unique or stale commits"}));
    }
    if !git(&checkout,&["status","--porcelain"])?.is_empty(){
        return Ok(json!({"status":"blocked",
            "reason":"Worktree has uncommitted or untracked changes"}));
    }
    git(&primary,&["worktree","remove",&checkout.to_string_lossy()])?;
    Ok(json!({"status":"removed"}))
}
pub fn assert_clean_worktree_at_head(
    project:&Path,head_sha:&str,
)->Result<(),String>{
    let actual=git(project,&["rev-parse","HEAD"])?;
    if actual!=head_sha{
        return Err(format!("Review checkout has stale HEAD: {actual}, expected {head_sha}"));
    }
    if !git(project,&["status","--porcelain"])?.is_empty(){
        return Err(format!("Review checkout has uncommitted changes: {}",
            project.display()));
    }
    Ok(())
}
