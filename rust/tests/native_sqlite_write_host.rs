//! Isolated native daemon SQLite host: optimistic CAS and active outbox claims.
//! Tests run on a newly created unified SQLite fixture, never live stores.
use agents_relay_rust2::{
    relayd::{DaemonConfig,DaemonServices},
    relayd_sqlite_write::IsolatedSQLiteWriteHost,
    relay_store::SQLiteRelayStore,
    relayd_control::workspace_control,
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn fixture()->(PathBuf,DaemonConfig){
    let root=std::env::temp_dir().join(format!("rust2-sqlite-write-host-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(root.join("stores")).unwrap();
    let config=DaemonConfig{
        workspace_root:root.join("workspace"),store_directory:root.join("stores"),
        graph_directory:Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        profile_home:root.join("profiles"),policy_path:root.join("routing.json"),
        router_rules_path:root.join("rules.md"),dashboard_asset:root.join("index.html"),
        repositories:vec!["fixture".into()],port:9918,concurrency:1,interval_ms:100,
        lease_ms:300000,no_github:true,event_transport:json!({}),
    };
    (root,config)
}
fn job()->Value{
    json!({"id":"17","repository":"fixture","projectRoot":"/tmp/fixture",
        "state":"DRAFT","prNumber":0,"title":"one",
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[],"plans":[]})
}
#[test]
fn native_daemon_cas_refuses_stale_writer_across_independent_sqlite_connections(){
    let (root,config)=fixture();
    let path=root.join("relay.sqlite");
    let initial=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    initial.save_job(&job()).unwrap();initial.close().unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let old=host.load("17").unwrap();
    let outside=SQLiteRelayStore::open_without_claim_reset(&path,Some("17")).unwrap();
    let mut new=old.clone();new["title"]=json!("external writer");
    outside.save_job(&new).unwrap();
    let mut stale=old.clone();stale["title"]=json!("overwrite attempt");
    let rejection=host.save_exact("17",&old,&stale).unwrap_err();
    assert!(rejection.contains("Concurrent Job mutation"),"{rejection}");
    assert_eq!(outside.load_job("17").unwrap().unwrap()["title"],"external writer");
    let current=host.load("17").unwrap();
    assert_eq!(current["title"],"external writer");
    let mut accepted=current.clone();accepted["title"]=json!("new CAS success");
    assert_eq!(host.save_exact("17",&current,&accepted).unwrap()["title"],"new CAS success");
    assert_eq!(outside.load_job("17").unwrap().unwrap()["title"],"new CAS success");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn live_daemon_http_reads_do_not_reset_outstanding_projection_claims(){
    let (root,config)=fixture();
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&job()).unwrap();
    store.enqueue_projection(&json!({"idempotencyKey":"write:task:17:2",
        "operation":"save_task","payload":{"id":"2"},"priority":1})).unwrap();
    let claimed=store.claim_due_projections(1.0,"2100-01-01T00:00:00.000Z").unwrap();
    assert_eq!(claimed.len(),1);
    let status=|store:&SQLiteRelayStore|->String{
        store.db.query_row("SELECT status FROM projection_outbox WHERE idempotency_key='write:task:17:2'",
            [],|row|row.get::<_,String>(0)).unwrap()
    };
    assert_eq!(status(&store),"processing");
    let mut host=IsolatedSQLiteWriteHost::new(config);
    for _ in 0..5{
        assert_eq!(host.load("17").unwrap()["id"],"17");
    }
    assert_eq!(status(&store),"processing", "HTTP lookup must not reset a live lease");
    let probe=SQLiteRelayStore::open_without_claim_reset(&path,Some("17")).unwrap();
    assert_eq!(status(&probe),"processing");
    fs::remove_dir_all(root).unwrap();
}

fn git(root:&Path,args:&[&str])->String{
    let result=std::process::Command::new("git").arg("-C").arg(root)
        .args(args).output().unwrap();
    assert!(result.status.success(),"git {args:?}: {}",
        String::from_utf8_lossy(&result.stderr));
    String::from_utf8_lossy(&result.stdout).trim().to_string()
}
fn completed_planned_job(repo:&Path,task_kind:&str)->Value{
    let mut job=json!({"id":"17","repository":"project","projectRoot":repo,
        "state":"ACTIVE","prNumber":0,"autoMerge":true,"reviewEnabled":false,
        "title":"Native local Git completion","createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z",
        "plans":[{"id":"1","round":1,"status":"SUCCEEDED","objectiveStatus":"satisfied"}],
        "tasks":[{"id":"2","jobId":"17","kind":"work","agentName":"implementation",
            "state":"SUCCEEDED","output":{"kind":task_kind},
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z"}]});
    if task_kind=="task_pr" {
        job["localMerge"]=json!({"status":"pending",
            "sourceRef":"refs/heads/relay/job-17","targetRef":"refs/heads/main",
            "attempts":0});
    }
    job
}
#[test]
fn planned_non_git_script_job_completes_through_graph_and_sqlite_without_merge(){
    let (root,config)=fixture();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&completed_planned_job(&project,"file")).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    assert!(host.reconcile_git_delivery("17").unwrap());
    let completed=store.load_job("17").unwrap().unwrap();
    assert_eq!(completed["state"],"COMPLETED");
    assert!(host.reconcile_git_delivery("17").is_ok_and(|changed|!changed));
    assert_eq!(store.load_job("17").unwrap().unwrap(),completed);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn planned_source_job_merges_real_git_into_main_and_commits_verified_job_completion(){
    let (root,config)=fixture();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    git(&project,&["config","user.name","Rust2 isolated git merge"]);
    git(&project,&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.md"),"baseline\n").unwrap();
    git(&project,&["add","base.md"]);git(&project,&["commit","-qm","base"]);
    let old=git(&project,&["rev-parse","HEAD"]);
    git(&project,&["branch","relay/job-17"]);
    git(&project,&["checkout","-q","relay/job-17"]);
    fs::write(project.join("delivered.md"),"real source commit\n").unwrap();
    git(&project,&["add","delivered.md"]);
    git(&project,&["commit","-qm","feature"]);
    let source=git(&project,&["rev-parse","HEAD"]);
    git(&project,&["checkout","-q","main"]);
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&completed_planned_job(&project,"task_pr")).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    assert!(host.reconcile_git_delivery("17").unwrap());
    let completed=store.load_job("17").unwrap().unwrap();
    assert_eq!(completed["state"],"COMPLETED","{completed}");
    assert_eq!(completed["localMerge"]["status"],"succeeded");
    assert_eq!(completed["localMerge"]["sourceSha"],source);
    let sha=git(&project,&["rev-parse","refs/heads/main"]);
    assert_ne!(old,sha);
    assert_eq!(completed["localMerge"]["mergedCommitSha"],sha);
    assert_eq!(completed["remoteDelivery"]["status"],"pending");
    assert!(project.join("delivered.md").exists());
    assert_eq!(git(&project,&["rev-list","--parents","-n","1","main"])
        .split_whitespace().count(),3,"Merge must preserve source/target parents");
    let emitted:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'workflow-local-merge-%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(emitted,1,"Verified Git merge must be backed by durable event");
    assert!(host.reconcile_remote_delivery("17","falsified-sha").is_err());
    assert_eq!(store.load_job("17").unwrap().unwrap()["remoteDelivery"]["status"],"pending");
    host.reconcile_remote_delivery("17",&sha).unwrap();
    let delivered=store.load_job("17").unwrap().unwrap();
    assert_eq!(delivered["remoteDelivery"]["status"],"skipped",
        "No origin must be a durable skipped result, never an endless pending retry");
    assert_eq!(delivered["state"],"COMPLETED");
    assert!(host.reconcile_git_delivery("17").is_ok_and(|changed|!changed));
    assert_eq!(git(&project,&["rev-parse","refs/heads/main"]),sha,
        "Duplicate local completion must not create a second Git merge");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn local_merge_never_bypasses_human_review_or_resumes_after_unapproved_head(){
    let (root,config)=fixture();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    git(&project,&["config","user.name","Fixture"]);
    git(&project,&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.txt"),"base\n").unwrap();
    git(&project,&["add","base.txt"]);git(&project,&["commit","-qm","baseline"]);
    git(&project,&["checkout","-qb","relay/job-17"]);
    fs::write(project.join("feature.txt"),"new feature\n").unwrap();
    git(&project,&["add","feature.txt"]);git(&project,&["commit","-qm","feature"]);
    let feature=git(&project,&["rev-parse","HEAD"]);
    git(&project,&["checkout","-q","main"]);
    let main=git(&project,&["rev-parse","HEAD"]);
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    let mut job=completed_planned_job(&project,"task_pr");
    job["reviewEnabled"]=json!(true);
    job["review"]=json!({"outcome":"changes_requested","headSha":feature});
    store.save_job(&job).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    assert!(!host.reconcile_git_delivery("17").unwrap());
    assert_eq!(store.load_job("17").unwrap().unwrap()["state"],"ACTIVE");
    assert_eq!(git(&project,&["rev-parse","HEAD"]),main);
    assert!(!project.join("feature.txt").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn dirty_target_worktree_records_failed_merge_in_sqlite_without_completing_job(){
    let (root,config)=fixture();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    git(&project,&["config","user.name","Fixture"]);
    git(&project,&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.txt"),"base\n").unwrap();
    git(&project,&["add","base.txt"]);git(&project,&["commit","-qm","baseline"]);
    git(&project,&["checkout","-qb","relay/job-17"]);
    fs::write(project.join("feature.txt"),"changed feature\n").unwrap();
    git(&project,&["add","feature.txt"]);git(&project,&["commit","-qm","feature"]);
    git(&project,&["checkout","-q","main"]);
    let original_main=git(&project,&["rev-parse","HEAD"]);
    fs::write(project.join("base.txt"),"uncommitted target edit\n").unwrap();
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&completed_planned_job(&project,"task_pr")).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    assert!(!host.reconcile_git_delivery("17").unwrap());
    let persisted=store.load_job("17").unwrap().unwrap();
    assert_eq!(persisted["state"],"ACTIVE");
    assert_eq!(persisted["localMerge"]["status"],"failed");
    assert_eq!(persisted["localMerge"]["attempts"],1);
    assert!(persisted["localMerge"]["nextAttemptAt"].is_string());
    assert!(persisted["localMerge"]["error"].as_str().unwrap().contains("tracked or index changes"));
    assert_eq!(git(&project,&["rev-parse","HEAD"]),original_main);
    assert!(!project.join("feature.txt").exists());
    let events:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'workflow-local-merge-%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(events,1,"Failed Git merge must emit a durable retryable fact");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn final_review_targeted_request_is_one_atomic_sqlite_graph_child_and_idempotent(){
    let (root,config)=fixture();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    git(&project,&["config","user.name","Fixture"]);
    git(&project,&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.txt"),"baseline\n").unwrap();
    git(&project,&["add","base.txt"]);git(&project,&["commit","-qm","baseline"]);
    git(&project,&["checkout","-qb","relay/job-17"]);
    fs::write(project.join("patch.txt"),"feature\n").unwrap();
    git(&project,&["add","patch.txt"]);git(&project,&["commit","-qm","feature"]);
    let head=git(&project,&["rev-parse","HEAD"]);
    git(&project,&["checkout","-q","main"]);
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    let mut job=completed_planned_job(&project,"task_pr");
    job["reviewEnabled"]=json!(true);
    job["headSha"]=json!(head);
    job["review"]=json!({"taskId":"4","headSha":head,"outcome":"started"});
    job["reviewRevisionRequests"]=json!([]);
    let reviewer=json!({"id":"4","jobId":"17","kind":"work",
        "agentName":"job-acceptance-reviewer","title":"Final Review",
        "state":"RUNNING","executionId":"review-execution-1",
        "reviewHeadSha":head,"createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z"});
    job["tasks"].as_array_mut().unwrap().push(reviewer);
    store.save_job(&job).unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let request=json!({"command":"task.revise","jobId":"17","repository":"project",
        "taskId":"2","reviewTaskId":"4","reviewExecutionId":"review-execution-1",
        "requestId":"request-f1","headSha":head,
        "findings":[{"id":"f1","summary":"Correct source implementation"}]});
    let first=workspace_control(&mut host,&request).unwrap();
    assert_eq!(first["created"],true,"{first}");
    let persisted=store.load_job("17").unwrap().unwrap();
    assert_eq!(persisted["reviewRevisionRequests"].as_array().unwrap().len(),1);
    let child_id=first["request"]["revisionTaskId"].as_str().unwrap();
    assert!(child_id.bytes().all(|b|b.is_ascii_digit()));
    let child=persisted["tasks"].as_array().unwrap().iter()
        .find(|task|task["id"]==child_id).expect("Revision must be durable Task");
    assert_eq!(child["revision"]["originalTaskId"],"2");
    assert_eq!(child["state"],"DRAFT");
    assert!(persisted["tasks"][0]["comments"].as_array().unwrap().iter()
        .any(|comment|comment.to_string().contains("Correct source implementation")));
    let repeated=workspace_control(&mut host,&request).unwrap();
    assert_eq!(repeated["created"],false);
    let identical=store.load_job("17").unwrap().unwrap();
    assert_eq!(identical["tasks"].as_array().unwrap().len(),3);
    assert_eq!(identical["reviewRevisionRequests"].as_array().unwrap().len(),1);
    let mut changed=request.clone();changed["findings"][0]["summary"]=json!("Different finding");
    assert!(workspace_control(&mut host,&changed).is_err());
    let mut stale=request.clone();stale["reviewExecutionId"]=json!("stale-execution");
    assert!(workspace_control(&mut host,&stale).is_err());
    let mut wrong=request.clone();wrong["headSha"]=json!("f".repeat(40));
    assert!(workspace_control(&mut host,&wrong).is_err());
    assert_eq!(store.load_job("17").unwrap().unwrap(),identical,
        "Rejected review requests must not alter Task/Review data");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn copied_sqlite_job_cannot_merge_an_external_git_checkout(){
    let (root,config)=fixture();
    let outside=std::env::temp_dir().join(format!("rust2-external-root-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let project=outside.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&completed_planned_job(&project,"file")).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    let error=host.reconcile_git_delivery("17").unwrap_err();
    assert!(error.contains("outside its own independent Git fixture"),"{error}");
    assert_eq!(store.load_job("17").unwrap().unwrap()["state"],"ACTIVE");
    fs::remove_dir_all(root).unwrap();
    fs::remove_dir_all(outside).unwrap();
}

#[test]
fn local_bare_origin_receives_only_verified_nonforce_postcompletion_delivery(){
    let (root,config)=fixture();let project=root.join("project");let origin=root.join("origin.git");
    fs::create_dir_all(&project).unwrap();
    fs::create_dir_all(&origin).unwrap();
    git(&origin,&["init","--bare","-q"]);
    git(&project,&["init","-q","-b","main"]);
    git(&project,&["config","user.name","Fixture"]);
    git(&project,&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.txt"),"base\n").unwrap();
    git(&project,&["add","base.txt"]);git(&project,&["commit","-qm","baseline"]);
    git(&project,&["remote","add","origin",origin.to_str().unwrap()]);
    git(&project,&["push","-q","origin","main:refs/heads/main"]);
    let previous=git(&origin,&["rev-parse","refs/heads/main"]);
    git(&project,&["checkout","-qb","relay/job-17"]);
    fs::write(project.join("feature.txt"),"new code\n").unwrap();
    git(&project,&["add","feature.txt"]);git(&project,&["commit","-qm","feature"]);
    git(&project,&["checkout","-q","main"]);
    let db=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&completed_planned_job(&project,"task_pr")).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    assert!(host.reconcile_git_delivery("17").unwrap());
    let merged=git(&project,&["rev-parse","main"]);
    assert_ne!(merged,previous);
    assert_eq!(git(&origin,&["rev-parse","refs/heads/main"]),previous,
        "Remote delivery must never precede committed local Graph completion");
    host.reconcile_remote_delivery("17",&merged).unwrap();
    let delivered=store.load_job("17").unwrap().unwrap();
    assert_eq!(delivered["state"],"COMPLETED");
    assert_eq!(delivered["remoteDelivery"]["status"],"succeeded","{delivered}");
    assert_eq!(git(&origin,&["rev-parse","refs/heads/main"]),merged);
    host.reconcile_remote_delivery("17",&merged).unwrap();
    assert_eq!(git(&origin,&["rev-parse","refs/heads/main"]),merged);
    assert_eq!(store.load_job("17").unwrap().unwrap()["remoteDelivery"]["status"],"succeeded");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn isolated_daemon_refuses_pushing_to_an_external_git_origin(){
    let (root,config)=fixture();
    let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    git(&project,&["config","user.name","Fixture"]);
    git(&project,&["config","user.email","fixture@example.invalid"]);
    fs::write(project.join("base.txt"),"base\n").unwrap();
    git(&project,&["add","base.txt"]);git(&project,&["commit","-qm","baseline"]);
    git(&project,&["checkout","-qb","relay/job-17"]);
    fs::write(project.join("feature.txt"),"code\n").unwrap();
    git(&project,&["add","feature.txt"]);git(&project,&["commit","-qm","feature"]);
    git(&project,&["checkout","-q","main"]);
    let external=std::env::temp_dir().join(format!("rust2-forbidden-origin-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&external).unwrap();
    git(&external,&["init","--bare","-q"]);
    git(&project,&["remote","add","origin",external.to_str().unwrap()]);
    let db=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&completed_planned_job(&project,"task_pr")).unwrap();
    let host=IsolatedSQLiteWriteHost::new(config);
    assert!(host.reconcile_git_delivery("17").unwrap());
    let merged=git(&project,&["rev-parse","main"]);
    let error=host.reconcile_remote_delivery("17",&merged).unwrap_err();
    assert!(error.contains("outside its own Git fixture"),"{error}");
    assert_eq!(store.load_job("17").unwrap().unwrap()["remoteDelivery"]["status"],"pending");
    assert!(std::process::Command::new("git").arg("-C").arg(&external)
        .args(["show-ref","--verify","refs/heads/main"]).output().unwrap()
        .status.success()==false);
    fs::remove_dir_all(root).unwrap();fs::remove_dir_all(external).unwrap();
}

#[test]
fn correlated_model_worker_event_stream_is_graph_sqlite_durable_and_replay_fenced(){
    use agents_relay_rust2::{events::event_for,
        execution_event_identity::execution_event_source};
    let (root,config)=fixture();
    let project=root.join("project");fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    let execution="11111111-2222-3333-4444-555555555555";
    let job=json!({"id":"17","repository":"project","projectRoot":project,
        "title":"Model Worker native event ingestion","state":"ACTIVE","prNumber":0,
        "reviewEnabled":false,"priority":"P2","tasks":[{
            "id":"2","jobId":"17","kind":"work","adapter":"chatgpt","agentName":"implementation",
            "title":"Model Worker","state":"QUEUED","attempt":1,"maxAttempts":1,
            "leaseOwner":"isolated-native","leaseExpiresAt":"2099-01-01T00:00:00.000Z",
            "executionId":execution,"gitDeliveryRequired":false,"dependencies":[],
            "routing":{"decisionId":"decision-17-worker","provider":"chatgpt",
                "model":"account-defaults","profile":"default","reasoning":"medium"},
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
            "output":{"kind":"file","path":root.join("result.json")}}],
        "plans":[],"createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z"});
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    store.save_job(&job).unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let source=json!({"id":execution_event_source("17","2",execution),
        "agent":"implementation","component":"agents-relay"});
    let generated=|kind,status,message:&str|{
        event_for("17","2",None,kind,status,message,Some("orchestrator"),
            Some(json!({"test":"isolated-model"})),Some(source.clone()))
    };
    let forged=event_for("17","2",None,"task.completed","completed","fake pre-start success",
        Some("orchestrator"),Some(json!({"ok":true})),Some(source.clone()));
    assert!(host.accept_model_worker_event("17","2",execution,&forged).is_err(),
        "Task cannot complete without a verified start/active generation");
    let audit_path=root.join("decision-audit.jsonl");
    assert!(!audit_path.exists(),"Denied terminal event must not append audit");
    assert_eq!(store.load_job("17").unwrap().unwrap()["tasks"][0]["state"],"QUEUED");
    let mut foreign=generated("task.started","started","wrong task");
    foreign["task_id"]=json!("3");
    assert!(host.accept_model_worker_event("17","2",execution,&foreign).is_err());
    let mut forged_source=generated("task.started","started","forged source");
    forged_source["source"]["id"]=json!("job/17/task/2/execution/fake");
    assert!(host.accept_model_worker_event("17","2",execution,&forged_source).is_err());
    let started=generated("task.started","started","model actually started");
    let started_state=host.accept_model_worker_event("17","2",execution,&started).unwrap();
    assert_eq!(started_state["tasks"][0]["state"],"RUNNING");
    assert!(host.accept_model_worker_event("17","2",execution,&started).is_err(),
        "Repeated start does not duplicate a durable Graph transition");
    std::thread::sleep(std::time::Duration::from_millis(4));
    let progress=generated("task.progress","running","genuine work progress");
    let progress_state=host.accept_model_worker_event("17","2",execution,&progress).unwrap();
    assert_eq!(progress_state["tasks"][0]["state"],"RUNNING");
    assert!(progress_state["tasks"][0]["lastProgressEventAt"].is_string());
    // Same durable event identity + modified payload must fail the SQLite
    // collision fence, rolling back any speculative progress mutation.
    std::thread::sleep(std::time::Duration::from_millis(10));
    let mut colliding=generated("task.progress","running","different progress content");
    colliding["event_id"]=progress["event_id"].clone();
    let collision=host.accept_model_worker_event("17","2",execution,&colliding).unwrap_err();
    assert!(collision.contains("workflow event key collision"),"{collision}");
    assert_eq!(store.load_job("17").unwrap().unwrap(),progress_state,
        "Colliding progress event must not mutate the committed Task snapshot");
    let completed=generated("task.completed","completed","verified model result");
    let complete_state=host.accept_model_worker_event("17","2",execution,&completed).unwrap();
    assert_eq!(complete_state["tasks"][0]["state"],"SUCCEEDED");
    assert!(complete_state["tasks"][0]["executionId"].is_null());
    assert_eq!(complete_state["tasks"][0]["result"]["summary"],"verified model result");
    let audit=fs::read_to_string(&audit_path).unwrap();
    let records=audit.lines().map(|line|serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(records.len(),1,"Only a committed terminal event creates an audit");
    assert_eq!(records[0]["record_type"],"outcome");
    assert_eq!(records[0]["decision_id"],"decision-17-worker");
    assert_eq!(records[0]["kind"],"success");
    assert_eq!(records[0]["evidence"]["execution_id"],execution);
    assert!(host.accept_model_worker_event("17","2",execution,&completed).is_err(),
        "Once terminal, stale model generation cannot finish twice");
    assert_eq!(fs::read_to_string(&audit_path).unwrap(),audit,
        "Failed duplicate execution must not append a second audit");
    let durable=store.load_job("17").unwrap().unwrap();
    assert_eq!(durable,complete_state);
    let journal:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'model-event/17/2/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(journal,3,"one start, progress and finish event must commit atomically");
    let status=agents_relay_rust2::relayd::DaemonServices::status(&mut host);
    assert_eq!(status["wakeCount"],1,
        "Only a durably committed terminal model event wakes the native scheduler");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn source_commit_required_model_task_rejects_false_completion_receipt(){
    use agents_relay_rust2::{events::event_for,
        execution_event_identity::execution_event_source};
    let (root,config)=fixture();
    let project=root.join("project");fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    let execution="11111111-2222-3333-4444-555555555555";
    let path=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&path,Some("17")).unwrap();
    let mut job=job();job["projectRoot"]=json!(project);
    job["state"]=json!("ACTIVE");
    job["tasks"]=json!([{"id":"2","jobId":"17","kind":"work","adapter":"codex",
        "agentName":"implementation","state":"RUNNING","attempt":1,"maxAttempts":1,
        "executionId":execution,"leaseOwner":"isolated-native",
        "gitDeliveryRequired":true,"output":{"kind":"task_pr"},
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z"}]);
    store.save_job(&job).unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let event=event_for("17","2",None,"task.completed","completed","fake stdout success",
        Some("orchestrator"),Some(json!({"ok":true})),
        Some(json!({"id":execution_event_source("17","2",execution),
            "agent":"implementation","component":"agents-relay"})));
    assert!(host.accept_model_worker_event("17","2",execution,&event).is_err(),
        "No verified Git source receipt means Task Graph must refuse success");
    let after=store.load_job("17").unwrap().unwrap();
    assert_eq!(after["tasks"][0]["state"],"RUNNING");
    assert_eq!(after["tasks"][0]["gitDeliveryRequired"],true);
    let status=agents_relay_rust2::relayd::DaemonServices::status(&mut host);
    assert_eq!(status["wakeCount"],0,
        "Unverified source completion cannot wake the Job as completed");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_managed_task_update_is_live_sqlite_graph_control_with_exact_cas_and_postcommit_wake(){
    let (root,config)=fixture();let project=root.join("project");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    let db=root.join("relay.sqlite");
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    let original_stamp="2026-11-18T00:00:00.000Z";
    let mut snapshot=job();snapshot["projectRoot"]=json!(project);
    snapshot["repository"]=json!("project");
    snapshot["state"]=json!("ACTIVE");
    snapshot["tasks"]=json!([{"id":"2","jobId":"17","kind":"work",
        "agentName":"implementation","title":"Edit safely","state":"DRAFT",
        "priority":"P2","adapter":"script","attempt":0,"maxAttempts":2,
        "dependencies":[],"input":"Original","routing":{"provider":"test"},
        "workerSelection":{"adapter":"script","selectedAt":original_stamp},
        "updatedAt":original_stamp,"createdAt":original_stamp}]);
    store.save_job(&snapshot).unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let mut proposed=snapshot["tasks"][0].clone();
    proposed["priority"]=json!("P1");
    proposed["input"]=json!("Revised objective");
    proposed["routing"]=json!({"provider":"verified-test"});
    let request=json!({"command":"task.update","jobId":"17",
        "repository":"project","taskId":"2",
        "expectedUpdatedAt":original_stamp,"task":proposed});
    let updated=workspace_control(&mut host,&request).unwrap();
    assert_eq!(updated["tasks"][0]["input"],"Revised objective");
    assert_eq!(updated["tasks"][0]["priority"],"P1");
    assert!(updated["tasks"][0].get("workerSelection").is_none());
    assert_eq!(updated["tasks"][0]["state"],"DRAFT");
    assert_eq!(store.load_job("17").unwrap().unwrap(),updated);
    let status=agents_relay_rust2::relayd::DaemonServices::status(&mut host);
    assert_eq!(status["wakeCount"],1,"wake follows the authoritative committed change");
    assert!(workspace_control(&mut host,&request).is_err(),
        "An old updatedAt must reject another Task update");
    assert_eq!(store.load_job("17").unwrap().unwrap(),updated);
    assert_eq!(agents_relay_rust2::relayd::DaemonServices::status(&mut host)["wakeCount"],1,
        "CAS failure must never signal a phantom Task change");
    let mut prohibited=request.clone();
    prohibited["task"]["id"]=json!("another-task");
    assert!(workspace_control(&mut host,&prohibited).is_err());
    assert_eq!(store.load_job("17").unwrap().unwrap(),updated);
    fs::remove_dir_all(root).unwrap();
}


// Original Node src/cli-coordinator.ts: real native control ingress must
// atomically bind Coordinator roots, accept a valid Graph transition and
// reject stale or malformed retries without phantom wake notifications.
#[test]
fn native_coordinator_job_run_is_one_sqlite_graph_transition_with_retry_fences(){
    let (root,config)=fixture();
    let project=root.join("fixture");
    fs::create_dir_all(&project).unwrap();
    git(&project,&["init","-q","-b","main"]);
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("17")).unwrap();
    let mut snapshot=job();
    snapshot["projectRoot"]=json!(project);
    snapshot["tasks"]=json!([{
        "id":"2","jobId":"17","kind":"work","title":"Coordinator",
        "agentName":"coordinator","state":"DRAFT","attempt":0,"maxAttempts":3,
        "dependencies":[],"agentGraph":"flowchart TD\nA[agent:developer]",
        "createdAt":"2026-11-18T00:00:00.000Z",
        "updatedAt":"2026-11-18T00:00:00.000Z"
    }]);
    store.save_job(&snapshot).unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let request=json!({"command":"job.run","jobId":"17","taskId":"2",
        "workspaceRoot":root});
    let receipt=workspace_control(&mut host,&request).unwrap();
    assert_eq!(receipt["state"],"ACTIVE");
    assert_eq!(receipt["graphRuntime"],"tasks");
    assert_eq!(receipt["scheduled"],true);
    let stored=store.load_job("17").unwrap().unwrap();
    assert_eq!(stored["state"],"ACTIVE");
    assert_eq!(stored["tasks"][0]["state"],"QUEUED");
    assert_eq!(stored["graphStartContext"]["projectRoot"],json!(fs::canonicalize(&project).unwrap()));
    assert_eq!(stored["graphStartContext"]["workspaceRoot"],json!(fs::canonicalize(&root).unwrap()));
    assert_eq!(DaemonServices::status(&mut host)["wakeCount"],1);
    assert!(workspace_control(&mut host,&json!({
        "command":"job.run","jobId":"17","taskId":"wrong",
        "workspaceRoot":root})).is_err());
    assert!(workspace_control(&mut host,&json!({
        "command":"job.run","jobId":"17","taskId":"2",
        "workspaceRoot":root,"graphOverride":"graph TD\nBroken"})).is_err());
    let other=root.join("other");
    fs::create_dir_all(&other).unwrap();
    let conflict=workspace_control(&mut host,&json!({
        "command":"job.run","jobId":"17","taskId":"2",
        "workspaceRoot":other})).unwrap_err();
    assert!(conflict.contains("original binding"),"{conflict}");
    assert_eq!(DaemonServices::status(&mut host)["wakeCount"],1);
    assert_eq!(store.load_job("17").unwrap().unwrap(),stored);
    // Retry with identical immutable binding is allowed and idempotent.
    let retry=workspace_control(&mut host,&request).unwrap();
    assert_eq!(retry["state"],"ACTIVE");
    assert_eq!(store.load_job("17").unwrap().unwrap(),stored);
    fs::remove_dir_all(root).unwrap();
}

// Node src/job-pause.ts: real daemon CLI ingress must commit the Graph pause
// of all running tasks and live Plan execution in one SQLite CAS transaction.
// A terminal Job fails closed and cannot wake/partially mutate the store.
#[test]
fn native_pause_resume_persists_graph_task_snapshots_and_rollback(){
    let (root,config)=fixture();
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("17")).unwrap();
    let original=json!({
        "id":"17","repository":"fixture","projectRoot":"/tmp/fixture",
        "state":"ACTIVE","prNumber":0,"title":"pause/resume fixture",
        "tasks":[
            {"id":"2","jobId":"17","kind":"work","agentName":"developer",
                "state":"RUNNING","attempt":2,"maxAttempts":2,
                "executionId":"execution-a","leaseOwner":"runner",
                "leaseExpiresAt":"2100-01-01T00:00:00.000Z"},
            {"id":"3","jobId":"17","kind":"work","state":"SUCCEEDED",
                "attempt":1,"maxAttempts":2},
            {"id":"4","jobId":"17","kind":"planner","state":"RUNNING",
                "executionId":"planner-task","leaseOwner":"planner"}],
        "plans":[{"id":"5","jobId":"17","status":"PLANNING",
            "executionId":"planning-execution","leaseOwner":"planner",
            "leaseExpiresAt":"2100-01-01T00:00:00.000Z"}],
        "updatedAt":"2026-11-18T00:00:00.000Z"
    });
    store.save_job(&original).unwrap();
    let baseline=store.load_job("17").unwrap().unwrap();
    let mut host=IsolatedSQLiteWriteHost::new(config);
    let paused=workspace_control(&mut host,&json!({
        "command":"job.pause","jobId":"17"})).unwrap();
    assert_eq!(paused["state"],"ACTIVE");
    assert_eq!(paused["tasks"][0]["state"],"QUEUED");
    assert_eq!(paused["tasks"][0]["pausedExecution"]["id"],"execution-a");
    assert_eq!(paused["tasks"][0]["pausedExecution"]["state"],"RUNNING");
    assert_eq!(paused["tasks"][0]["leaseOwner"],Value::Null);
    assert_eq!(paused["tasks"][1],baseline["tasks"][1]);
    assert_eq!(paused["tasks"][2],baseline["tasks"][2],"planner Task is not paused");
    assert_eq!(paused["plans"][0]["pausedExecutionId"],"planning-execution");
    assert_eq!(paused["plans"][0]["leaseOwner"],Value::Null);
    assert_eq!(store.load_job("17").unwrap().unwrap(),paused);
    let resumed=workspace_control(&mut host,&json!({
        "command":"job.resume","jobId":"17"})).unwrap();
    assert!(resumed.get("pause").is_none());
    assert!(resumed["tasks"][0].get("pausedExecution").is_none());
    assert_eq!(resumed["tasks"][0]["maxAttempts"],3);
    assert!(resumed["plans"][0].get("pausedExecutionId").is_none());
    assert_eq!(store.load_job("17").unwrap().unwrap(),resumed);
    assert_eq!(DaemonServices::status(&mut host)["wakeCount"],2);
    let mut terminal=resumed.clone();
    terminal["state"]=json!("COMPLETED");
    store.save_job(&terminal).unwrap();
    assert!(workspace_control(&mut host,&json!({
        "command":"job.pause","jobId":"17"})).unwrap_err()
            .contains("Cannot pause terminal Job"));
    assert_eq!(store.load_job("17").unwrap().unwrap(),terminal);
    assert_eq!(DaemonServices::status(&mut host)["wakeCount"],2);
    fs::remove_dir_all(root).unwrap();
}
