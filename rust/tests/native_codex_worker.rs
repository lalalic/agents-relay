use agents_relay_rust2::reconciler_context::WorkerContextRoots;
// Disposable fake Codex provider: successful exit is not Graph success.
use agents_relay_rust2::{
    native_codex_execution::{execute_claimed_codex,native_codex_managed_prompt},
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{fs,path::PathBuf,time::{SystemTime,UNIX_EPOCH}};
fn fixture()->PathBuf{
    let root=std::env::temp_dir().join(format!(
        "r2-owned-codex-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(root.join("agents")).unwrap();
    fs::write(root.join("agents/fixture.agent.md"),
        "---\nname: fixture\ncapabilities: [model, local_repo]\n---\n# Test-only real Agent contract\n").unwrap();
    root
}
fn job(root:&PathBuf)->Value{
    json!({"id":"9001","repository":"fixture","projectRoot":root,
        "title":"Owned Codex false success regression","state":"ACTIVE",
        "prNumber":0,"createdAt":"2026-11-21T00:00:00Z",
        "updatedAt":"2026-11-21T00:00:00Z",
        "plans":[],"tasks":[{
            "id":"9002","jobId":"9001","kind":"work","adapter":"codex",
            "agentName":"fixture","state":"QUEUED","attempt":1,"maxAttempts":3,
            "executionId":"test-source-generation-1","leaseOwner":"unit-lease",
            "leaseExpiresAt":"2099-01-01T00:00:00Z",
            "executionHistory":[{"id":"test-source-generation-1","attempt":1}],
            "routing":{"provider":"openai","model":"test-owned"},
            "input":"Test-only Worker prompt; do not modify any source",
            "output":{"kind":"file","path":root.join("out.json")},
            "createdAt":"2026-11-21T00:00:00Z",
            "updatedAt":"2026-11-21T00:00:00Z"}]})
}
#[test]
fn codex_port_refuses_to_launch_without_authentic_leased_graph_generation(){
    let root=fixture();let db=root.join("relay.sqlite");
    let mut record=job(&root);
    let store=SQLiteRelayStore::open(&db,Some("9001")).unwrap();
    store.save_job(&record).unwrap();store.close().unwrap();
    let executable=PathBuf::from("/bin/sh");
    record["tasks"][0]["executionId"]=Value::Null;
    let error=execute_claimed_codex(&db,&record,&record["tasks"][0],
        &executable,&root,&WorkerContextRoots::isolated(&root)).unwrap_err();
    assert!(error.contains("committed Task lease"),"{error}");
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("9001")).unwrap();
    let saved=store.load_job("9001").unwrap().unwrap();
    assert_eq!(saved["tasks"][0]["state"],"QUEUED");
    assert_eq!(saved["tasks"][0]["attempt"],1);
    drop(store);fs::remove_dir_all(root).unwrap();
}
#[test]
fn native_codex_uses_trusted_managed_prompt_and_correlated_event_contract(){
    let root=fixture();let db=root.join("relay.sqlite");
    let record=job(&root);
    let store=SQLiteRelayStore::open(&db,Some("9001")).unwrap();
    store.save_job(&record).unwrap();store.close().unwrap();
    let prompt=native_codex_managed_prompt(&db,&record,&record["tasks"][0],&root,&WorkerContextRoots::isolated(&root))
        .expect("managed prompt must resolve real Agent and task binding");
    assert!(prompt.contains("job/9001/task/9002/execution/test-source-generation-1"));
    assert!(prompt.contains("task.started"));
    assert!(prompt.contains("task.completed"));
    assert!(prompt.contains("task.progress"));
    assert!(prompt.contains("task-job-contract.md"));
    assert!(!prompt.starts_with("Test-only Worker prompt"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn native_codex_worker_gets_unrestricted_access_without_approval_prompts(){
    use std::os::unix::fs::PermissionsExt;
    let root=fixture();let db=root.join("relay.sqlite");
    let capture=root.join("codex-argv.txt");
    let executable=root.join("fake-codex-argv");
    fs::write(&executable,format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nprintf '{{\"type\":\"turn.completed\"}}\\n'\nexit 0\n",capture.display())).unwrap();
    fs::set_permissions(&executable,fs::Permissions::from_mode(0o700)).unwrap();
    let record=job(&root);
    let store=SQLiteRelayStore::open(&db,Some("9001")).unwrap();
    store.save_job(&record).unwrap();store.close().unwrap();
    let failure=execute_claimed_codex(&db,&record,&record["tasks"][0],&executable,&root,&WorkerContextRoots::isolated(&root))
        .expect_err("provider exit without terminal Graph event is not success");
    assert!(failure.contains("without verified Task terminal event"),"{failure}");
    let args=fs::read_to_string(&capture).unwrap();
    let argv:Vec<&str>=args.lines().collect();
    assert_eq!(argv.first(),Some(&"exec"));
    assert!(argv.contains(&"--json"),"{argv:?}");
    assert_eq!(argv.iter().filter(|&&v|
        v=="--dangerously-bypass-approvals-and-sandbox").count(),1,"{argv:?}");
    assert!(!argv.contains(&"--sandbox"),"{argv:?}");
    assert!(!argv.contains(&"workspace-write"),"{argv:?}");
    assert!(!argv.contains(&"sandbox_workspace_write.network_access=true"),"{argv:?}");
    assert_eq!(argv.iter().filter(|&&v|v=="-m").count(),1,"{argv:?}");
    drop(failure);fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn successful_codex_cli_exit_cannot_fabricate_graph_task_completion(){
    use std::os::unix::fs::PermissionsExt;
    let root=fixture();let db=root.join("relay.sqlite");
    let script=root.join("fake-native-codex");
    fs::write(&script,"#!/bin/sh\nprintf '{\"type\":\"turn.completed\"}\\n'\nexit 0\n").unwrap();
    fs::set_permissions(&script,fs::Permissions::from_mode(0o700)).unwrap();
    let record=job(&root);
    let store=SQLiteRelayStore::open(&db,Some("9001")).unwrap();
    store.save_job(&record).unwrap();store.close().unwrap();
    let failure=execute_claimed_codex(&db,&record,&record["tasks"][0],
        &script,&root,&WorkerContextRoots::isolated(&root)).unwrap_err();
    assert!(failure.contains("without verified Task terminal event"),"{failure}");
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("9001")).unwrap();
    let persisted=store.load_job("9001").unwrap().unwrap();
    assert_eq!(persisted["tasks"][0]["state"],"QUEUED");
    assert_eq!(persisted["tasks"][0]["executionId"],"test-source-generation-1");
    assert_eq!(persisted["tasks"][0]["attempt"],1);
    drop(store);fs::remove_dir_all(root).unwrap();
}

#[test]
fn codex_review_handoff_requires_exact_live_host_binding_not_completion(){
    use agents_relay_rust2::native_codex_execution::valid_codex_review_handoff;
    use serde_json::json;
    let run="actual-model-generation";
    let valid=json!({"state":"AWAITING_DECISION",
        "interactiveInvocation":{"status":"awaiting_decision",
          "executionId":run,"invocationId":run,"revision":run}});
    assert!(valid_codex_review_handoff(&valid,run));
    assert!(!valid_codex_review_handoff(&valid,"different-generation"));
    for state in ["RUNNING","QUEUED","SUCCEEDED","FAILED"]{
        let mut changed=valid.clone();changed["state"]=json!(state);
        assert!(!valid_codex_review_handoff(&changed,run));
    }
    for field in ["status","executionId","invocationId","revision"]{
        let mut changed=valid.clone();changed["interactiveInvocation"][field]=json!("unknown");
        assert!(!valid_codex_review_handoff(&changed,run));
    }
}

#[test]
#[cfg(unix)]
fn long_stdout_preserves_real_graph_completion_and_thread_identity(){
    use agents_relay_rust2::{
        events::event_for,execution_event_identity::execution_event_source,
        native_worker_event_ingress::apply_verified_worker_event,
    };
    use std::{os::unix::fs::PermissionsExt,path::Path,time::{Duration,Instant}};
    let root=fixture();let db=root.join("relay.sqlite");
    let script=root.join("fake-native-codex");
    let thread_id="38f84f9e-410d-4e36-96e0-a420594a102d";
    let execution="test-source-generation-1";
    fs::write(&script,format!(r#"#!/bin/sh
set -e
printf '%s\n' '{{"type":"thread.started","thread_id":"{thread_id}"}}'
awk 'BEGIN {{printf "{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\""; for(i=0;i<3100000;i++)printf "x"; print "\"}}}}"}}'
touch ready
i=0
while [ ! -f done ] && [ "$i" -lt 150 ]; do sleep 0.1; i=$((i+1)); done
[ -f done ]
printf '%s\n' '{{"type":"turn.completed"}}'
"#)).unwrap();
    fs::set_permissions(&script,fs::Permissions::from_mode(0o700)).unwrap();
    let record=job(&root);
    let store=SQLiteRelayStore::open(&db,Some("9001")).unwrap();
    store.save_job(&record).unwrap();store.close().unwrap();
    std::thread::scope(|scope|{
        let worker=scope.spawn(||execute_claimed_codex(&db,&record,&record["tasks"][0],
            &script,&root,&WorkerContextRoots::isolated(&root)));
        let deadline=Instant::now()+Duration::from_secs(10);
        loop{
            let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("9001")).unwrap();
            let saved=store.load_job("9001").unwrap().unwrap();
            if root.join("ready").exists()&&saved["tasks"][0]["threadId"]==thread_id{break;}
            assert!(Instant::now()<deadline,"Worker did not drain long stdout");
            std::thread::sleep(Duration::from_millis(30));
        }
        let source=json!({"id":execution_event_source("9001","9002",execution),
            "agent":"fixture","component":"agents-relay"});
        let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
        let started=event_for("9001","9002",None,"task.started","started",
            "fixture Graph start",None,None,Some(source.clone()));
        let completed=event_for("9001","9002",None,"task.completed","completed",
            "fixture Graph completion",None,None,Some(source));
        apply_verified_worker_event(&db,&graph,"9001","9002",execution,&started).unwrap();
        apply_verified_worker_event(&db,&graph,"9001","9002",execution,&completed).unwrap();
        fs::write(root.join("done"),"done").unwrap();
        worker.join().unwrap().expect("long stdout must not override durable completion");
    });
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("9001")).unwrap();
    let saved=store.load_job("9001").unwrap().unwrap();
    assert_eq!(saved["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(saved["tasks"][0]["threadId"],thread_id);
    drop(store);fs::remove_dir_all(root).unwrap();
}
