//! Node-shaped Job lifecycle CLI backed by the existing Relay V2 SQLite authority.
//! Writes are intentionally fenced to disposable marked stores until daemon
//! writer coordination is available for production stores.
use agents_relay_rust::authority::{NativeObjectiveJobSpec, RelayAuthority};
use agents_relay_rust::graph::{Decision, Graph, GraphInput};
use agents_relay_rust::native_daemon::{
    authorized_project, canonical_live_mode, isolated_store_root,
};
use agents_relay_rust::native_job::{create_dag_job, DagJobRequest};
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
    if action == "create" {
        for flag in [
            "--shortcut-local",
            "--content-only",
            "--no-content-only",
            "--shortcut-execution",
            "--mode",
            "--execution-mode",
        ] {
            if args.iter().any(|a| a == flag) {
                return Err(format!(
                    "{flag} is deprecated or removed; use a Coordinator Graph or an ordinary Job lifecycle"
                ));
            }
        }
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
        "--idempotency-key",
        "--github-repo",
        "--tag",
        "--creator-thread-id",
        "--reviewer-thread-id",
        "--implementation-thread-id",
        "--continue-kind",
        "--continue-target",
        "--continue-input",
        "--coordinator-graph",
        "--coordinator-graph-file",
        "--coordinator-input",
        "--coordinator-input-file",
        "--coordinator-output-path",
        "--coordinator-project-root",
        "--coordinator-shared-root",
        "--coordinator-workspace-root",
    ];
    let flags = [
        "--review",
        "--no-review",
        "--auto-merge",
        "--no-auto-merge",
        "--no-github",
        "--initial-plan",
    ];
    let o = parse(args, &allowed, &flags)?;
    let path = db(&o)?;
    let live_socket_mode =
        std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live");
    if live_socket_mode {
        agents_relay_rust::native_daemon::live_store_root(&path)?;
        if !matches!(
            action,
            "create" | "update" | "pause" | "resume" | "cancel" | "unblock"
        ) {
            return Err(format!("unsupported native live Job action {action}"));
        }
    } else {
        ensure_isolated(&path)?;
    }
    let (repo, id) = identity(&o, action == "create")?;
    if live_socket_mode && action != "create" {
        // Explicit per-verb option allowlist: no unported CLI parameter can
        // vanish when handing off a mutation to the daemon.
        let allowed: &[&str] = match action {
            "update" => &[
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
                "--review",
                "--no-review",
                "--auto-merge",
                "--no-auto-merge",
            ],
            "pause" | "resume" => &["--db", "--id", "--job-id", "--repo"],
            "cancel" | "unblock" => &["--db", "--id", "--job-id", "--repo", "--reason"],
            _ => unreachable!(),
        };
        if let Some(key) = o.keys().find(|key| !allowed.contains(&key.as_str())) {
            return Err(format!(
                "live Job {action} does not support {key}; refusing to discard the option"
            ));
        }
        if o.contains_key("--review") && o.contains_key("--no-review")
            || o.contains_key("--auto-merge") && o.contains_key("--no-auto-merge")
            || o.contains_key("--objective") && o.contains_key("--objective-file")
        {
            return Err("conflicting Job update flags".into());
        }
        let mut changes = serde_json::Map::new();
        if action == "update" {
            for (flag, key) in [
                ("--title", "title"),
                ("--objective", "objective"),
                ("--project-root", "projectRoot"),
                ("--project-path", "projectPath"),
                ("--priority", "priority"),
            ] {
                if let Some(value) = o.get(flag) {
                    changes.insert(key.into(), json!(value));
                }
            }
            if let Some(file) = o.get("--objective-file") {
                let canonical = Path::new(file)
                    .canonicalize()
                    .map_err(|e| format!("objective-file: {e}"))?;
                let store = isolated_store_root(&path)?;
                if !canonical.is_file() || !canonical.starts_with(&store) {
                    return Err("objective file must be inside the Rust live store root".into());
                }
                let contents = std::fs::read_to_string(&canonical).map_err(|e| e.to_string())?;
                changes.insert("objective".into(), json!(contents));
            }
            for (positive, negative, key) in [
                ("--review", "--no-review", "reviewEnabled"),
                ("--auto-merge", "--no-auto-merge", "autoMerge"),
            ] {
                if o.contains_key(positive) {
                    changes.insert(key.into(), json!(true));
                }
                if o.contains_key(negative) {
                    changes.insert(key.into(), json!(false));
                }
            }
            if changes.is_empty() {
                return Err("job update requires at least one mutable option".into());
            }
        }
        return agents_relay_rust::native_control::request(
            &path,
            &agents_relay_rust::native_control::ControlRequest {
                version: 1,
                operation: format!("job.{action}"),
                repository: repo.into(),
                id: id.into(),
                title: String::new(),
                objective: String::new(),
                project_root: String::new(),
                project_path: None,
                priority: String::new(),
                review_enabled: false,
                auto_merge: false,
                changes: if action == "update" {
                    Some(Value::Object(changes))
                } else {
                    None
                },
                reason: o.get("--reason").cloned(),
                task_id: None,
                message: None,
                recovery_task_id: None,
                diagnosis: None,
                classification: None,
                escalation: None,
                human_response: None,
                task_create: None,
            },
        );
    }
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
            let isolated = isolated_store_root(&path)?;
            let allowed = if canonical_live_mode() {
                let project = o
                    .get("--coordinator-project-root")
                    .or_else(|| o.get("--project-root"))
                    .ok_or("objective-file needs an authorized project root")?;
                authorized_project(&isolated, Path::new(project))?
            } else {
                isolated
            };
            if !p.starts_with(&allowed) || !p.is_file() {
                return Err("objective file must be inside authorized project root".into());
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
            .get("--coordinator-project-root")
            .or_else(|| o.get("--project-root"))
            .map(String::as_str)
            .ok_or("job create requires --project-root")?;
        if !Path::new(root).is_absolute() {
            return Err("--project-root must be absolute".into());
        }
        if live_socket_mode {
            let supported = [
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
                "--review",
                "--no-review",
                "--auto-merge",
                "--no-auto-merge",
            ];
            if let Some(key) = o.keys().find(|key| !supported.contains(&key.as_str())) {
                return Err(format!("live job create {key} requires a daemon control protocol extension; refusing to discard field"));
            }

            if id.is_empty() {
                return Err(
                    "live job create requires an explicit --id for restart-safe deduplication"
                        .into(),
                );
            }
            #[cfg(unix)]
            {
                return agents_relay_rust::native_control::request(
                    &path,
                    &agents_relay_rust::native_control::ControlRequest {
                        version: 1,
                        operation: "job.create".into(),
                        repository: repo.into(),
                        id: id.into(),
                        title: o
                            .get("--title")
                            .map(String::as_str)
                            .unwrap_or("Agents Relay job")
                            .into(),
                        objective,
                        project_root: root.into(),
                        project_path: o.get("--project-path").cloned(),
                        priority: o
                            .get("--priority")
                            .map(String::as_str)
                            .unwrap_or("P2")
                            .into(),
                        review_enabled: !o.contains_key("--no-review"),
                        auto_merge: !o.contains_key("--no-auto-merge"),
                        changes: None,
                        reason: None,
                        task_id: None,
                        message: None,
                        recovery_task_id: None,
                        diagnosis: None,
                        classification: None,
                        escalation: None,
                        human_response: None,
                        task_create: None,
                    },
                );
            }
            #[cfg(not(unix))]
            return Err("native daemon control socket requires Unix".into());
        }

        if o.contains_key("--continue-kind") != o.contains_key("--continue-target") {
            return Err("--continue-kind and --continue-target must be supplied together".into());
        }
        let continuation = if let (Some(kind), Some(target)) =
            (o.get("--continue-kind"), o.get("--continue-target"))
        {
            if !matches!(kind.as_str(), "command" | "webhook" | "codex-thread")
                || target.trim().is_empty()
            {
                return Err("invalid continuation kind or target".into());
            }
            Some(
                serde_json::json!({"kind":kind,"target":target,"input":o.get("--continue-input").filter(|s|!s.is_empty())}),
            )
        } else {
            if o.contains_key("--continue-input") {
                return Err("--continue-input requires continuation kind and target".into());
            }
            None
        };
        let coordinator_requested = [
            "--coordinator-graph",
            "--coordinator-graph-file",
            "--coordinator-input",
            "--coordinator-input-file",
            "--coordinator-output-path",
            "--coordinator-project-root",
            "--coordinator-shared-root",
            "--coordinator-workspace-root",
        ]
        .iter()
        .any(|key| o.contains_key(*key));
        if coordinator_requested {
            if o.contains_key("--initial-plan") {
                return Err("Coordinator starts directly without a Planner".into());
            }
            let graph_inline = o.get("--coordinator-graph");
            let graph_file = o.get("--coordinator-graph-file");
            let input_inline = o.get("--coordinator-input");
            let input_file = o.get("--coordinator-input-file");
            if graph_inline.is_some() == graph_file.is_some()
                || input_inline.is_some() == input_file.is_some()
            {
                return Err("Coordinator requires exactly one of --coordinator-graph/--coordinator-graph-file and exactly one of --coordinator-input/--coordinator-input-file".into());
            }
            for key in [
                "--coordinator-output-path",
                "--coordinator-project-root",
                "--coordinator-workspace-root",
            ] {
                if !o.contains_key(key) {
                    return Err(format!("Coordinator requires {key}"));
                }
            }
            let db_path = db(&o)?;
            if !id.is_empty() && o.contains_key("--idempotency-key") {
                return Err(
                    "--id and --idempotency-key cannot be combined for native Coordinator creation"
                        .into(),
                );
            }
            if let Some(file) = o.get("--coordinator-graph-file") {
                let path = Path::new(file).canonicalize().map_err(|e| e.to_string())?;
                let isolated = isolated_store_root(&db_path)?;
                let allowed = if canonical_live_mode() {
                    authorized_project(&isolated, Path::new(root))?
                } else {
                    isolated
                };
                if !path.starts_with(&allowed) {
                    return Err(
                        "Coordinator graph file must be inside authorized project root".into(),
                    );
                }
            }
            if let Some(file) = o.get("--coordinator-input-file") {
                let path = Path::new(file).canonicalize().map_err(|e| e.to_string())?;
                let isolated = isolated_store_root(&db_path)?;
                let allowed = if canonical_live_mode() {
                    authorized_project(&isolated, Path::new(root))?
                } else {
                    isolated
                };
                if !path.starts_with(&allowed) {
                    return Err(
                        "Coordinator input file must be inside authorized project root".into(),
                    );
                }
            }
            let output = PathBuf::from(o.get("--coordinator-output-path").unwrap());
            let graph_file = o
                .get("--coordinator-graph-file")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let input_file = o
                .get("--coordinator-input-file")
                .map(PathBuf::from)
                .unwrap_or_else(|| PathBuf::from("."));
            let generated_key = uuid::Uuid::new_v4().to_string();
            let coordinator_tag = o
                .get("--tag")
                .map(|v| serde_json::from_str::<Value>(v).map_err(|_| "--tag must be valid JSON"))
                .transpose()?;
            let coordinator_continuation = continuation.as_ref();
            return create_dag_job(DagJobRequest {
                db: &db_path,
                project: Path::new(root),
                project_path: o.get("--project-path").map(String::as_str),
                graph_file: &graph_file,
                input_file: &input_file,
                output_file: &output,
                title: o
                    .get("--title")
                    .map(String::as_str)
                    .unwrap_or("Agents Relay job"),
                repository: repo,
                request_key: o
                    .get("--idempotency-key")
                    .map(String::as_str)
                    .unwrap_or(&generated_key),
                id: if id.is_empty() { None } else { Some(id) },
                priority,
                graph: graph_inline.map(String::as_str),
                input: input_inline.map(String::as_str),
                workspace_root: o.get("--coordinator-workspace-root").map(Path::new),
                shared_root: o.get("--coordinator-shared-root").map(Path::new),
                github_repo: o.get("--github-repo").map(String::as_str),
                tag: coordinator_tag.as_ref(),
                creator_thread_id: o.get("--creator-thread-id").map(String::as_str),
                reviewer_thread_id: o.get("--reviewer-thread-id").map(String::as_str),
                implementation_thread_id: o.get("--implementation-thread-id").map(String::as_str),
                continuation: coordinator_continuation,
                no_github: o.contains_key("--no-github"),
                review_enabled: !o.contains_key("--no-review"),
                auto_merge: !o.contains_key("--no-auto-merge"),
            });
        }
        if o.contains_key("--initial-plan") {
            return Err("--initial-plan requires a configured native Planner runtime; Rust job create does not fabricate Planner rounds".into());
        }
        let isolated_root = isolated_store_root(&path)?;
        let canonical_project = authorized_project(&isolated_root, Path::new(root))?;
        if let Some(relative) = o.get("--project-path") {
            let candidate = canonical_project
                .join(relative)
                .canonicalize()
                .map_err(|e| e.to_string())?;
            if !candidate.starts_with(&canonical_project) {
                return Err("--project-path must resolve inside --project-root".into());
            }
        }
        let now = agents_relay_rust::supervised_script::current_time();
        let mut a = RelayAuthority::open_existing(&path)?;
        let job = a.create_native_objective_job(NativeObjectiveJobSpec {
            repository: repo,
            id: if id.is_empty() { None } else { Some(id) },
            title,
            objective: &objective,
            project_root: &canonical_project.to_string_lossy(),
            project_path: o.get("--project-path").map(String::as_str),
            priority,
            review_enabled: !o.contains_key("--no-review"),
            auto_merge: !o.contains_key("--no-auto-merge"),
            idempotency_key: o.get("--idempotency-key").map(String::as_str),
            tag: o
                .get("--tag")
                .map(|v| serde_json::from_str::<Value>(v).map_err(|_| "--tag must be valid JSON"))
                .transpose()?
                .as_ref(),
            github_repo: o.get("--github-repo").map(String::as_str),
            creator_thread_id: o.get("--creator-thread-id").map(String::as_str),
            reviewer_thread_id: o.get("--reviewer-thread-id").map(String::as_str),
            implementation_thread_id: o.get("--implementation-thread-id").map(String::as_str),
            continuation: continuation.as_ref(),
            no_github: o.contains_key("--no-github"),
            at: &now,
        })?;
        return Ok(json!({"job":job,"created":true}));
    }
    if !matches!(action, "update" | "pause" | "resume" | "cancel") {
        if action == "unblock" {
            return Err("job unblock requires native daemon-controlled Graph authority".into());
        }
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

#[cfg(test)]
mod create_tests {
    use super::*;
    use agents_relay_rust::{native_job::init_isolated_store, store::RelayReader};
    use std::fs;

    #[test]
    fn native_create_coordinator_round_trip_and_fail_closed_cases() {
        std::env::set_var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY", "isolated-test");
        let dir = tempfile::Builder::new()
            .prefix("relay-rust-authority-")
            .tempdir()
            .unwrap();
        fs::write(
            dir.path().join(".relay-rust-authority-isolated-test"),
            "test",
        )
        .unwrap();
        let db = dir.path().join("relay.sqlite");
        init_isolated_store(&db).unwrap();
        let project = dir.path().join("project");
        fs::create_dir(&project).unwrap();
        let graph_file = dir.path().join("graph.mmd");
        fs::write(&graph_file,"flowchart TD\n  S[agent:source] --> A[agent:left]\n  S --> B[agent:right]\n  A --> J[agent:join]\n  B --> J\n").unwrap();
        let input_file = dir.path().join("input.md");
        let original = "# Original request\n\nKeep every decision and constraint intact.";
        fs::write(&input_file, original).unwrap();
        let output = dir.path().join("output.json");
        let argv = |extra: &[&str]| -> Vec<String> {
            let mut values = vec![
                "--db".into(),
                db.to_string_lossy().into_owned(),
                "--repo".into(),
                "demo".into(),
                "--objective".into(),
                "standalone objective".into(),
                "--coordinator-graph-file".into(),
                graph_file.to_string_lossy().into_owned(),
                "--coordinator-input-file".into(),
                input_file.to_string_lossy().into_owned(),
                "--coordinator-output-path".into(),
                output.to_string_lossy().into_owned(),
                "--coordinator-project-root".into(),
                project.to_string_lossy().into_owned(),
                "--coordinator-workspace-root".into(),
                project.to_string_lossy().into_owned(),
                "--idempotency-key".into(),
                "coordinator-test-1".into(),
                "--no-github".into(),
            ];
            values.extend(extra.iter().map(|v| v.to_string()));
            values
        };
        let created = run("create", &argv(&[])).unwrap();
        assert_eq!(created["created"], true);
        assert_eq!(created["state"], "DRAFT");
        let again = run("create", &argv(&[])).unwrap();
        assert_eq!(again["created"], false);
        assert_eq!(again["jobId"], created["jobId"]);
        let reader = RelayReader::open(&db).unwrap();
        let job = reader
            .get_job(created["jobId"].as_str().unwrap())
            .unwrap()
            .unwrap()
            .job;
        assert_eq!(job["state"], "DRAFT");
        assert_eq!(job["objective"], original);
        assert_eq!(
            job["projectRoot"],
            project.canonicalize().unwrap().to_string_lossy().as_ref()
        );
        assert_eq!(job["tasks"][0]["state"], "QUEUED");
        assert_eq!(job["tasks"][0]["input"], original);
        assert!(job["tasks"][0]["agentGraph"]
            .as_str()
            .unwrap()
            .contains("agent:join"));
        assert_eq!(job["tasks"].as_array().unwrap().len(), 1);
        let initial = argv(&["--initial-plan"]);
        assert!(run("create", &initial)
            .unwrap_err()
            .contains("Coordinator starts directly"));
        let incomplete = vec![
            "--db".into(),
            db.to_string_lossy().into_owned(),
            "--repo".into(),
            "demo".into(),
            "--objective".into(),
            "x".into(),
            "--project-root".into(),
            project.to_string_lossy().into_owned(),
            "--coordinator-input".into(),
            "input".into(),
        ];
        assert!(run("create", &incomplete)
            .unwrap_err()
            .contains("Coordinator requires"));
        let unsupported = vec![
            "--db".into(),
            db.to_string_lossy().into_owned(),
            "--repo".into(),
            "demo".into(),
            "--objective".into(),
            "x".into(),
            "--shortcut-local".into(),
        ];
        assert!(run("create", &unsupported)
            .unwrap_err()
            .contains("deprecated or removed"));
        std::env::remove_var("RELAY_RUST_EXPERIMENTAL_TEST_ONLY");
    }
}
