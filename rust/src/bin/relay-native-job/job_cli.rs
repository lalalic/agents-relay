//! Node-shaped Job lifecycle CLI backed by the existing Relay V2 SQLite authority.
//! Writes are intentionally fenced to disposable marked stores until daemon
//! writer coordination is available for production stores.
use agents_relay_rust::authority::{NativeObjectiveJobSpec, RelayAuthority};
use agents_relay_rust::graph::{Decision, Graph, GraphInput};
use agents_relay_rust::native_daemon::isolated_store_root;
use agents_relay_rust::supervised_script::after_time;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
};

fn parse(
    args: &[String],
    allowed: &[&str],
    flags: &[&str],
) -> Result<HashMap<String, String>, String> {
    let mut out = HashMap::new();
    let mut i = 0;
    while i < args.len() {
        let k = args[i].as_str();
        if !allowed.contains(&k) && !flags.contains(&k) {
            return Err(format!("unrecognized Job option {k}"));
        }
        if out.contains_key(k) {
            return Err(format!("duplicate option {k}"));
        }
        if flags.contains(&k) {
            out.insert(k.into(), "true".into());
            i += 1;
            continue;
        }
        let v = args
            .get(i + 1)
            .filter(|v| !v.starts_with("--"))
            .ok_or_else(|| format!("missing value for {k}"))?;
        out.insert(k.into(), v.clone());
        i += 2;
    }
    Ok(out)
}
fn db(o: &HashMap<String, String>) -> Result<PathBuf, String> {
    let p = PathBuf::from(
        o.get("--db")
            .ok_or("missing --db (explicit isolated DB required)")?,
    );
    if !p.is_absolute() {
        return Err("absolute DB path required".into());
    }
    Ok(p)
}
fn identity(o: &HashMap<String, String>, create: bool) -> Result<(&str, &str), String> {
    let repo = o
        .get("--repo")
        .map(String::as_str)
        .ok_or("missing --repo")?;
    let id = o
        .get("--id")
        .or_else(|| o.get("--job-id"))
        .map(String::as_str)
        .unwrap_or("");
    if !create && id.is_empty() {
        return Err("--id is required".into());
    }
    if o.contains_key("--id") && o.contains_key("--job-id") {
        return Err("use only one of --id or --job-id".into());
    }
    Ok((repo, id))
}
fn check_repo(job: &Value, repo: &str) -> Result<(), String> {
    if job["repository"].as_str() != Some(repo) {
        Err("Local Job/PR binding mismatch".into())
    } else {
        Ok(())
    }
}
fn ensure_isolated(db: &Path) -> Result<(), String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("native Job lifecycle writes are unavailable while a production daemon may own this Job".into());
    }
    isolated_store_root(db).map(|_| ())
}
pub fn run(action: &str, args: &[String]) -> Result<Value, String> {
    if action == "unblock" {
        return Err("job unblock is incomplete: native Troubleshooter response authorization and recovery effects are not implemented".into());
    }
    let allowed = [
        "--db",
        "--id",
        "--job-id",
        "--repo",
        "--title",
        "--objective",
        "--objective-file",
        "--project-root",
        "--project-path",
        "--priority",
        "--reason",
    ];
    let flags = ["--review", "--no-review", "--auto-merge", "--no-auto-merge"];
    let o = parse(args, &allowed, &flags)?;
    let path = db(&o)?;
    ensure_isolated(&path)?;
    let (repo, id) = identity(&o, action == "create")?;
    if action == "create" {
        if o.contains_key("--review") && o.contains_key("--no-review")
            || o.contains_key("--auto-merge") && o.contains_key("--no-auto-merge")
        {
            return Err("conflicting Job flags".into());
        }
        let objective = if let Some(s) = o.get("--objective") {
            s.clone()
        } else if let Some(p) = o.get("--objective-file") {
            let p = Path::new(p).canonicalize().map_err(|e| e.to_string())?;
            let root = isolated_store_root(&path)?;
            if !p.starts_with(&root) || !p.is_file() {
                return Err("objective file must be inside isolated store root".into());
            }
            std::fs::read_to_string(p).map_err(|e| e.to_string())?
        } else {
            return Err("job create requires --objective or --objective-file".into());
        };
        let title = o
            .get("--title")
            .map(String::as_str)
            .unwrap_or("Agents Relay job");
        let priority = o.get("--priority").map(String::as_str).unwrap_or("P2");
        let root = o
            .get("--project-root")
            .map(String::as_str)
            .ok_or("job create requires --project-root")?;
        if !Path::new(root).is_absolute() {
            return Err("--project-root must be absolute".into());
        }
        let now = agents_relay_rust::supervised_script::current_time();
        let mut a = RelayAuthority::open_existing(&path)?;
        let job = a.create_native_objective_job(NativeObjectiveJobSpec {
            repository: repo,
            id: if id.is_empty() { None } else { Some(id) },
            title,
            objective: &objective,
            project_root: root,
            project_path: o.get("--project-path").map(String::as_str),
            priority,
            review_enabled: !o.contains_key("--no-review"),
            auto_merge: !o.contains_key("--no-auto-merge"),
            at: &now,
        })?;
        return Ok(json!({"job":job,"created":true}));
    }
    if !matches!(action, "update" | "pause" | "resume" | "cancel") {
        return Err(format!("unsupported native Job action {action}"));
    }
    let mut a = RelayAuthority::open_existing(&path)?;
    let old = a.read_job(id)?.ok_or("unknown Job")?;
    check_repo(&old, repo)?;
    let at = after_time(old["updatedAt"].as_str().ok_or("Job timestamp missing")?)?;
    let result=a.commit_job(id,&at,|prior|{
        let mut next=prior.clone();
        match action {
            "update"=>{
                if !["--title","--objective","--objective-file","--project-root","--project-path","--priority","--review","--no-review","--auto-merge","--no-auto-merge"].iter().any(|k|o.contains_key(*k)){return Err("job update requires at least one mutable option".into());}
                if let Some(v)=o.get("--title"){if v.trim().is_empty()||v.len()>200{return Err("--title must be nonempty and at most 200 bytes".into());}next["title"]=json!(v);}
                if let Some(v)=o.get("--objective"){if v.trim().is_empty(){return Err("Job objective cannot be empty".into());}next["objective"]=json!(v);}
                if let Some(v)=o.get("--objective-file"){let p=Path::new(v).canonicalize().map_err(|e|e.to_string())?;let root=isolated_store_root(&path)?;if !p.starts_with(root)||!p.is_file(){return Err("objective file must be inside isolated store root".into());}let s=std::fs::read_to_string(p).map_err(|e|e.to_string())?;if s.trim().is_empty(){return Err("Job objective cannot be empty".into());}next["objective"]=json!(s);}
                if let Some(v)=o.get("--priority"){if !matches!(v.as_str(),"P0"|"P1"|"P2"|"P3"){return Err("--priority must be P0, P1, P2, or P3".into());}next["priority"]=json!(v);}
                for (opt,key) in [("--project-root","projectRoot"),("--project-path","projectPath")] {if let Some(v)=o.get(opt){if opt=="--project-root"&&!Path::new(v).is_absolute(){return Err("--project-root must be absolute".into());}next[key]=json!(v);}}
                if o.contains_key("--review")&&o.contains_key("--no-review")||o.contains_key("--auto-merge")&&o.contains_key("--no-auto-merge"){return Err("conflicting Job flags".into());}
                if o.contains_key("--review"){next["reviewEnabled"]=json!(true);}
                else if o.contains_key("--no-review"){next["reviewEnabled"]=json!(false);}
                if o.contains_key("--auto-merge"){next["autoMerge"]=json!(true);}
                else if o.contains_key("--no-auto-merge"){next["autoMerge"]=json!(false);}
            },
            "pause"=>{
                if matches!(prior["state"].as_str(),Some("COMPLETED"|"CANCELLED")){return Err("Cannot pause terminal Job".into());}
                if !prior.get("pause").is_some_and(|v|!v.is_null()) {
                    for t in prior["tasks"].as_array().into_iter().flatten(){if t["state"]=="RUNNING"||t.get("leaseOwner").is_some_and(|v|!v.is_null())||t.get("executionId").is_some_and(|v|!v.is_null()){return Err("pause requires daemon-coordinated cancellation of active executions; refusing to clear a live lease".into());}}
                    next["pause"]=json!({"generation":1,"requestedAt":at});
                }
            },
            "resume"=>{if next.get("pause").is_some_and(|v|!v.is_null()){next.as_object_mut().unwrap().remove("pause");}},
            "cancel"=>{
                let graph=Graph::parse(include_str!("../../../../workflow/job-lifecycle.mmd"))?;
                let state=prior["state"].as_str().ok_or("Job state missing")?;
                let d=graph.decide(state,GraphInput{transport:"event".into(),id:"cancel".into(),payload:json!({})},&HashMap::new())?;
                let Decision::Accepted{target,actions,..}=d else{return Err("canonical Job Graph denied cancellation".into())};
                if target!="CANCELLED"||!actions.iter().any(|x|x.id=="effect.cancelActiveTasks"){return Err("canonical Job Graph selected unsupported cancellation effect".into());}
                if prior.get("plans").and_then(Value::as_array).is_some_and(|ps|ps.iter().any(|p|p["status"]=="PLANNING")){return Err("cancel with active Planner lease is not supported by native CLI".into());}
                let task_graph = Graph::parse(include_str!("../../../../workflow/task-lifecycle.mmd"))?;
                for t in next["tasks"].as_array_mut().into_iter().flatten(){
                    if matches!(t["state"].as_str(),Some("RUNNING"|"AWAITING_DECISION"))||t.get("executionId").is_some_and(|v|!v.is_null())||t.get("leaseOwner").is_some_and(|v|!v.is_null()) {return Err("cancel with active execution requires daemon-owned process cancellation; refusing to mark success".into());}
                    if matches!(t["state"].as_str(),Some("DRAFT"|"QUEUED"|"BLOCKED")) {
                        if !matches!(t["state"].as_str(),Some("DRAFT"|"QUEUED")){return Err("native Job cancellation does not yet support BLOCKED Troubleshooter Tasks".into());}
                        let state=t["state"].as_str().ok_or("Task state missing")?;
                        let task_decision=task_graph.decide(state,GraphInput{transport:"event".into(),id:"cancel".into(),payload:json!({})},&HashMap::new())?;
                        let Decision::Accepted{target,..}=task_decision else{return Err(format!("canonical Task Graph denied cancellation for Task {}",t["id"].as_str().unwrap_or("?")))};
                        if target!="CANCELLED"{return Err("canonical Task Graph selected unexpected cancellation state".into());}
                        t["state"]=json!(target);t["error"]=json!(o.get("--reason").map(String::as_str).unwrap_or("Job cancelled"));t["updatedAt"]=json!(at);
                    } else if !matches!(t["state"].as_str(),Some("SUCCEEDED"|"FAILED"|"CANCELLED")) {return Err("native Job cancellation encountered unsupported Task state".into());}
                }
                next["state"]=json!(target);
            },_=>unreachable!()
        }
        next["updatedAt"]=json!(at);Ok((next,vec![]))
    })?;
    Ok(json!({"job":result.job}))
}
