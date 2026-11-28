// Direct port of Node src/git-delivery.ts: execution-bound local Git proof.
// Git is read-only evidence; SQLite and the canonical Task Graph own success.
use crate::{
    final_review_role::is_final_review_agent,local_merge_lock::iso8601_now,
    owned_process::{OwnedProcessManager,OwnedProcessOptions,TerminationReason},
};
use regex::Regex;
use serde_json::{json,Value};
use std::{fs,io::Read,path::{Path,PathBuf},thread,time::{Duration,Instant}};

fn field<'a>(value:&'a Value,name:&str)->&'a str{
    value.get(name).and_then(Value::as_str).unwrap_or("")
}
fn git(root:&Path,args:&[&str])->Result<String,String>{
    // All Git subprocesses are disposable owned processes, not unconstrained
    // Command::output calls. The supervisor fences their original process group
    // on crash, timeout and parent termination; there is no shell expansion.
    let mut manager=OwnedProcessManager::default();
    let root_text=root.to_str().ok_or("Git delivery root is not UTF-8")?;
    let mut argv=vec!["-C",root_text];argv.extend(args);
    let process=manager.spawn_owned_process_piped("git",&argv,OwnedProcessOptions{
        invocation:"git-delivery-readonly".into(),cwd:None,timeout_ms:Some(8000),
        grace_ms:150,supervisor_path:None,
    })?;
    let stdout=process.take_stdout().ok_or("Git stdout pipe unavailable")?;
    let stderr=process.take_stderr().ok_or("Git stderr pipe unavailable")?;
    let out=thread::spawn(move||{
        let mut output=Vec::new();
        stdout.take(1024*1024+1).read_to_end(&mut output).map(|_|output)
    });
    let err=thread::spawn(move||{
        let mut output=Vec::new();
        stderr.take(1024*1024+1).read_to_end(&mut output).map(|_|output)
    });
    let started=Instant::now();
    let status=loop{
        if let Some(status)=process.exit_status()?{break status;}
        if started.elapsed()>=Duration::from_millis(8000){
            process.terminate(TerminationReason::Timeout,Some(0));
            // The owned process group has been signalled; fail closed without
            // blocking on a large stdout or a stuck external Git process.
            return Err("Git delivery command timed out after 8000ms".into());
        }
        thread::sleep(Duration::from_millis(8));
    };
    let out=out.join().map_err(|_|"Git stdout reader failed")?
        .map_err(|e|e.to_string())?;
    let err=err.join().map_err(|_|"Git stderr reader failed")?
        .map_err(|e|e.to_string())?;
    if out.len()>1024*1024||err.len()>1024*1024{
        return Err("Git delivery command exceeded 1 MB buffer".into());
    }
    if !status.success(){
        let details=String::from_utf8_lossy(&err).trim().to_string();
        let command=format!("git -C {} {}",root.display(),args.join(" "));
        return Err(if details.is_empty(){format!("Command failed: {command}")}else{
            format!("Command failed: {command}\n{details}\n")
        });
    }
    Ok(String::from_utf8_lossy(&out).trim().to_string())
}

fn canonical_root(job:&Value)->Result<PathBuf,String>{
    if field(job,"projectRoot").is_empty()||field(job,"repository").is_empty(){
        return Err("Git delivery requires a canonical Job projectRoot".into());
    }
    let root=fs::canonicalize(field(job,"projectRoot")).map_err(|e|e.to_string())?;
    let toplevel=git(&root,&["rev-parse","--show-toplevel"])?;
    let actual=fs::canonicalize(toplevel).map_err(|e|e.to_string())?;
    if actual!=root{return Err("Git delivery projectRoot is not the canonical Git root".into());}
    Ok(root)
}
fn source_ref(job:&Value)->Result<&str,String>{
    let ref_name=job.pointer("/localMerge/sourceRef").and_then(Value::as_str).unwrap_or("");
    let valid=ref_name.strip_prefix("refs/heads/").is_some_and(|name|
        Regex::new(r"^[A-Za-z0-9][A-Za-z0-9._/-]*$").unwrap().is_match(name));
    if !valid||ref_name.contains("..")||ref_name.ends_with(".lock"){
        return Err("Git delivery requires a configured local Job source branch".into());
    }
    Ok(ref_name)
}
fn sha_valid(value:&str)->bool{
    (40..=64).contains(&value.len()) && value.bytes().all(|b|b.is_ascii_hexdigit())
}
fn source_worktree(root:&Path,branch:&str)->Result<PathBuf,String>{
    let out=git(root,&["worktree","list","--porcelain"])?;
    let paths=out.split("\n\n").filter_map(|entry|{
        let mut path=None;
        let mut current=None;
        for line in entry.lines(){
            if let Some(value)=line.strip_prefix("worktree "){path=Some(value);}
            if let Some(value)=line.strip_prefix("branch "){current=Some(value);}
        }
        if current==Some(branch){path}else{None}
    }).collect::<Vec<_>>();
    if paths.len()!=1{return Err("Git delivery requires exactly one checked-out source branch worktree".into());}
    let path=fs::canonicalize(paths[0]).map_err(|e|e.to_string())?;
    if git(&path,&["symbolic-ref","HEAD"])?!=branch{
        return Err("Git delivery branch changed".into());
    }
    Ok(path)
}

pub fn source_commit_required(task:&Value)->bool{
    let agent=task.get("agentName").and_then(Value::as_str);
    let graph_present=match task.get("agentGraph"){
        None|Some(Value::Null|Value::Bool(false))=>false,
        Some(Value::String(s))=>!s.is_empty(),
        Some(Value::Number(n))=>n.as_f64().unwrap_or_default()!=0.,
        Some(_)=>true,
    };
    task.pointer("/output/kind")==Some(&json!("task_pr"))
        &&field(task,"kind")!="planner" &&!graph_present
        &&!is_final_review_agent(agent)
        &&!matches!(agent,Some("troubleshooter"|"planner"|"review-chair"))
}

pub fn source_commit_sha(job:&Value)->Result<String,String>{
    let root=canonical_root(job)?;
    git(&root,&["rev-parse","--verify",&format!("{}^{{commit}}",source_ref(job)?)])
}

pub fn started_source_baseline(job:&Value,task_id:&str)->Result<Option<String>,String>{
    let required=job.get("tasks").and_then(Value::as_array).into_iter().flatten()
        .find(|task|field(task,"id")==task_id)
        .is_some_and(|task|task["gitDeliveryRequired"]==true);
    if required{source_commit_sha(job).map(Some)}else{Ok(None)}
}

pub fn bind_source_baseline(task:&mut Value,sha:Option<&str>){
    if task["gitDeliveryRequired"]==true{
        if let (Some(sha),Some(execution))=(sha.filter(|s|!s.is_empty()),
            task.get("executionId").and_then(Value::as_str).filter(|s|!s.is_empty())){
            let execution=execution.to_owned();
            task["gitDeliveryBaseline"]=json!({"executionId":execution,"sha":sha});
            if let Some(map)=task.as_object_mut(){map.remove("gitDelivery");}
        }
    }
}

pub fn verify_source_commit(job:&Value,task:&Value,execution_id:&str,commit_sha:&str)
    ->Result<Value,String>{
    verify_source_commit_inner(job,task,execution_id,commit_sha,true)
}

/// Read-only provenance for a revision's own new HEAD before its completion
/// receipt. A dirty worktree does not invalidate an already committed tip.
/// This never records a delivery or authorizes completion.
pub fn revision_owns_head(job:&Value,task:&Value,head:&str)->bool{
    let execution=field(task,"executionId");
    if execution.is_empty(){return false;}
    verify_source_commit_inner(job,task,execution,head,false).is_ok()
        &&source_commit_sha(job).is_ok_and(|actual|actual==head)
}
fn verify_source_commit_inner(job:&Value,task:&Value,execution_id:&str,commit_sha:&str,
    require_clean:bool)->Result<Value,String>{
    if task["gitDeliveryRequired"]!=true||task["state"]!="RUNNING"
        ||field(task,"executionId")!=execution_id{
        return Err("Git delivery requires an active source Task execution".into());
    }
    let base=task.pointer("/gitDeliveryBaseline/sha").and_then(Value::as_str).unwrap_or("");
    if task.pointer("/gitDeliveryBaseline/executionId").and_then(Value::as_str)!=Some(execution_id)
        ||!sha_valid(base){
        return Err("Git delivery is missing the current execution start baseline".into());
    }
    if !sha_valid(commit_sha){return Err("Git delivery requires a full commit SHA".into());}
    let actual=source_commit_sha(job)?;
    if commit_sha==base{return Err("Git delivery requires a new committed source branch HEAD".into());}
    let project=canonical_root(job)?;
    let path=source_worktree(&project,source_ref(job)?)?;
    if git(&path,&["rev-parse","--verify","HEAD"])?!=actual{
        return Err("Git delivery source worktree HEAD differs from branch".into());
    }
    if require_clean && !git(&path,&["status","--porcelain=v1","--untracked-files=all"])?.is_empty(){
        return Err("Git delivery source worktree has uncommitted or untracked changes".into());
    }
    if git(&path,&["merge-base","--is-ancestor",base,commit_sha]).is_err(){
        return Err("Git delivery commit does not descend from execution baseline".into());
    }
    if git(&path,&["merge-base","--is-ancestor",commit_sha,&actual]).is_err(){
        return Err("Git delivery commit is not on the current Job source branch".into());
    }
    let message=git(&path,&["log","-1","--format=%B",commit_sha])?;
    let trailers=message.lines().map(str::trim).collect::<Vec<_>>();
    if !trailers.contains(&format!("Relay-Task: {}",field(task,"id")).as_str())
        ||!trailers.contains(&format!("Relay-Execution: {execution_id}").as_str()){
        return Err("Git delivery commit must contain exact Relay-Task and Relay-Execution trailers".into());
    }
    if git(&path,&["diff-tree","--no-commit-id","--name-only","-r",commit_sha])?.is_empty(){
        return Err("Git delivery requires a nonempty code commit".into());
    }
    Ok(json!({"executionId":execution_id,"baseSha":base,"commitSha":commit_sha,
        "worktree":path.to_string_lossy(),"verifiedAt":iso8601_now()}))
}

pub fn source_completion_verified(job:&Value,task:&Value,execution_id:Option<&str>)->bool{
    if task["gitDeliveryRequired"]!=true{return true;}
    let Some(execution)=execution_id.filter(|s|!s.is_empty())else{return false;};
    if task.pointer("/gitDelivery/executionId").and_then(Value::as_str)!=Some(execution){return false;}
    let commit=task.pointer("/gitDelivery/commitSha").and_then(Value::as_str).unwrap_or("");
    match verify_source_commit(job,task,execution,commit){
        Ok(receipt)=>receipt["baseSha"]==task["gitDelivery"]["baseSha"]
            &&receipt["worktree"]==task["gitDelivery"]["worktree"],
        Err(_)=>false,
    }
}
