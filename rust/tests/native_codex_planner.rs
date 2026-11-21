//! Native Codex Planner: a subprocess cannot fabricate a Plan Apply receipt.
//! No Codex account, external provider, Node relayd, or production SQLite is used.
use agents_relay_rust2::{
    native_script_planner::run_native_codex_planner,
    planner::create_plan_round,
    relay_store::SQLiteRelayStore,
};
use serde_json::json;
use std::{fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn fixture()->(PathBuf,PathBuf,PathBuf){
    let root=std::env::temp_dir().join(format!("r2-model-plan-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
            .unwrap().as_nanos()));
    let project=root.join("project");
    fs::create_dir_all(project.join("agents")).unwrap();
    fs::create_dir_all(root.join("stores")).unwrap();
    fs::write(project.join("agents/planner.agent.md"),
        "# Planner\nUse matching Plan context and apply CLI only; never invent receipts.\n").unwrap();
    let db=root.join("relay.sqlite");
    let stamp="2026-11-21T00:00:00Z";
    let mut job=json!({"id":"903","repository":"project","projectRoot":project,
        "title":"Native Model Planner fixture","objective":"Verify a saved output",
        "state":"ACTIVE","prNumber":0,"reviewEnabled":false,"autoMerge":true,
        "createdAt":stamp,"updatedAt":stamp,"plans":[],
        "tasks":[{"id":"904","jobId":"903","kind":"work","adapter":"script",
          "agentName":"fixture","state":"SUCCEEDED","title":"Already verified",
          "output":{"kind":"file","path":project.join("proof.json")},
          "createdAt":stamp,"updatedAt":stamp}]});
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let plan=create_plan_round(&graph,&job,None,false,Some(4000),Some(stamp)).unwrap();
    job["plans"]=json!([plan]);
    let store=SQLiteRelayStore::open(&db,Some("903")).unwrap();
    store.save_job(&job).unwrap();
    (root,project,db)
}
#[test]
#[cfg(unix)]
fn unverified_codex_receipt_never_marks_plan_succeeded(){
    use std::os::unix::fs::PermissionsExt;
    let (root,_project,db)=fixture();
    let fake=root.join("fake-codex");
    let executed=root.join("provider-executed");
    fs::write(&fake,format!("#!/bin/sh\nprintf 'executed' > {}\nprintf '{{\"type\":\"item.completed\",\"item\":{{\"type\":\"agent_message\",\"text\":\"PLAN_APPLIED:plan-1:unverified\"}}}}\\n'\nexit 0\n",executed.display())).unwrap();
    fs::set_permissions(&fake,fs::Permissions::from_mode(0o700)).unwrap();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let _=run_native_codex_planner(&db,&root.join("stores"),&graph,
        "903","plan-1",&fake,4000);
    assert!(executed.exists(),"Fake provider must actually launch, not fail prompt setup");
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("903")).unwrap();
    let current=store.load_job("903").unwrap().unwrap();
    assert_ne!(current["plans"][0]["status"],"SUCCEEDED","{current}");
    assert_eq!(current["tasks"].as_array().unwrap().len(),1);
    assert_eq!(current["state"],"ACTIVE");
    drop(store);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn native_planner_requires_explicit_executable(){
    let (root,_project,db)=fixture();
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let failure=run_native_codex_planner(&db,&root.join("stores"),&graph,
        "903","plan-1",Path::new("codex"),1000).unwrap_err();
    assert!(failure.contains("explicit absolute"));
    let store=SQLiteRelayStore::open_without_claim_reset(&db,Some("903")).unwrap();
    assert_eq!(store.load_job("903").unwrap().unwrap()["plans"][0]["status"],"PLANNING");
    drop(store);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn native_planner_context_names_exact_rust_cli_for_apply(){
    let context=json!({"job":{"id":"903","repository":"project","prNumber":0},
        "objective":"Verify the current output", "tasks":[],
        "planExecution":{"planId":"plan-2","executionId":"execution-2"},
        "nativeRustCli":"/tmp/agents-relay-rust"});
    let rendered=agents_relay_rust2::planner::planner_input(&context);
    let value:serde_json::Value=serde_json::from_str(&rendered).unwrap();
    let apply=value["apply_cli"].as_str().unwrap();
    assert!(apply.starts_with("\"/tmp/agents-relay-rust\" plan apply"),"{apply}");
    assert!(!apply.contains("dist/cli.js"),"{apply}");
    assert!(apply.contains("--plan-id plan-2 --execution-id execution-2"));
}
