//! Real test-owned Planner Script process -> immutable Planner Graph lease ->
//! atomic SQLite Plan Apply. No external models or user source Git mutations.
use agents_relay_rust2::{
    manual_plan::prepare_manual_plan,
    native_script_planner::run_isolated_script_planner,
    planner::create_plan_round,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{env,fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn fixture(body:&str)->(PathBuf,PathBuf,PathBuf,PathBuf){
    let root=PathBuf::from("/tmp").join(format!("r2planner-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let project=root.join("project");
    fs::create_dir_all(root.join("stores")).unwrap();
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    let script=project.join("agents/.shortcut/planner.agent.mjs");
    fs::write(&script,body).unwrap();
    let db=root.join("relay.sqlite");
    (root,project,db,script)
}
fn graph()->PathBuf{Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
fn job(project:&Path)->Value{
    let stamp="2026-11-18T00:00:00.000Z";
    json!({"id":"17","repository":"project","projectRoot":project,
        "title":"Test Planner Script","objective":"Review accomplished objective",
        "state":"ACTIVE","prNumber":0,"priority":"P2","reviewEnabled":false,
        "createdAt":stamp,"updatedAt":stamp,"plans":[],
        "tasks":[{"id":"2","jobId":"17","kind":"work","agentName":"implementation",
            "adapter":"script","title":"Already completed Task","state":"SUCCEEDED",
            "attempt":1,"maxAttempts":1,"result":{"summary":"Verified already"},
            "output":{"kind":"file","path":project.join("result.json")},
            "createdAt":stamp,"updatedAt":stamp}]})
}
fn seeded_plan(store:&SQLiteRelayStore){
    store.mutate_job("17",|current|{
        let (next,round)=prepare_manual_plan(&graph(),&current,Some("Verify objective"),
            6000,false,|job,guidance,timeout|create_plan_round(&graph(),job,
                guidance,true,Some(timeout),None))?;
        assert_eq!(round["status"],"PLANNING");
        Ok(next)
    }).unwrap();
}
#[test]
fn planner_script_applies_verified_objective_only_through_graph_sqlite(){
    let (root,project,db,script)=fixture("export async function run({input}) {\n  if(input.objective!=='Review accomplished objective')throw Error('bad objective');\n  return {objective_status:'satisfied',assessment:'Existing evidence verified',next_tasks:[],unblocks:[]};\n}\n");
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&job(&project)).unwrap();seeded_plan(&store);
    let before=store.load_job("17").unwrap().unwrap();
    assert_eq!(before["plans"][0]["status"],"PLANNING");
    let runtime=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let completed=run_isolated_script_planner(&db,&root.join("stores"),&graph(),
        "17","plan-1",&script,&runtime,6000).unwrap();
    assert_eq!(completed["plans"][0]["status"],"SUCCEEDED","{completed}");
    assert_eq!(completed["plans"][0]["objectiveStatus"],"satisfied");
    assert_eq!(completed["plans"][0]["generatedTaskIds"],json!([]));
    assert!(completed["plans"][0]["appliedExecutionId"].is_string());
    assert!(completed["plans"][0]["executionId"].is_null());
    assert_eq!(completed["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(store.load_job("17").unwrap().unwrap(),completed);
    let applied=completed["plans"][0]["appliedExecutionId"].as_str().unwrap();
    let identity=store.load_execution_process("17","plan-1",applied).unwrap()
        .expect("Owned Planner Script PID/PGID recorded before execution");
    assert_eq!(identity["pid"],identity["pgid"]);
    assert!(identity["endedAt"].is_string());
    let event_count:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'isolated-planner/17/planner.completed/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(event_count,1,"Planner success is durable, not subprocess exit");
    let after=store.load_job("17").unwrap().unwrap();
    let replay=run_isolated_script_planner(&db,&root.join("stores"),&graph(),
        "17","plan-1",&script,&runtime,6000).unwrap();
    assert_eq!(replay,after,
        "Completed Planner launch is a no-op, matching original Node launcher");
    assert_eq!(store.load_job("17").unwrap().unwrap(),after,
        "Replaying a previously committed Planner round cannot change Job/Task");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn invalid_isolated_planner_output_fails_graph_round_without_creating_tasks(){
    let (root,project,db,script)=fixture("export async function run() {return {objective_status:'invalid',assessment:'bad',next_tasks:[]};}
");
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&job(&project)).unwrap();seeded_plan(&store);
    let runtime=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let result=run_isolated_script_planner(&db,&root.join("stores"),&graph(),
        "17","plan-1",&script,&runtime,6000);
    // The launcher routes invalid provider output to the authoritative
    // Planner failed/ retry branch. It must not materialize a candidate DAG.
    assert!(result.is_ok()||result.as_ref().err().is_some_and(|e|
        e.contains("objective_status")));
    let settled=store.load_job("17").unwrap().unwrap();
    assert_eq!(settled["plans"][0]["status"],"FAILED","{settled}");
    assert_eq!(settled["state"],"ACTIVE");
    assert_eq!(settled["tasks"].as_array().unwrap().len(),1);
    assert!(settled["plans"][0]["error"].as_str().unwrap_or("")
        .contains("objective_status"));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn plan_apply_uses_provider_inventory_and_retries_without_skipping_graph_validation(){
    use agents_relay_rust2::native_script_planner::apply_isolated_planner_proposal;
    let (root,project,db,_script)=fixture("export async function run(){return null;}");
    let sqlite=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    sqlite.save_job(&job(&project)).unwrap();
    seeded_plan(&sqlite);
    let generation="test-planner-exec-a";
    sqlite.mutate_job("17",|mut job|{
        job["plans"][0]["executionId"]=json!(generation);
        Ok(job)
    }).unwrap();
    let proposal=json!({"objective_status":"in_progress",
        "assessment":"Create verified implementation work",
        "next_tasks":[{"id":"draft-ui-fix","title":"Fix task tree",
            "agentName":"implementation","adapter":"codex","storySize":"S",
            "priority":"P2","input":"Fix the hierarchy layout",
            "routing":{"provider":"openai","model":"fixture-model",
                "decidedBy":"planner","decidedAt":"2026-11-18T00:00:00Z"},
            "output":{"kind":"file","path":project.join("proof.json")},
            "dependencies":["2"]}],"unblocks":[]});
    let missing=apply_isolated_planner_proposal(&db,&root.join("stores"),&graph(),
        "17","plan-1",generation,&proposal,&[]).unwrap_err();
    assert!(missing.contains("PLAN_APPLY_VALIDATION_FAILED"),"{missing}");
    assert_eq!(sqlite.load_job("17").unwrap().unwrap()["tasks"].as_array().unwrap().len(),1);
    let available=[json!({"workerId":"codex","id":"codex","adapter":"codex",
        "runtime":"codex","capabilities":["model","codex","local_repo","iterative_tools"]})];
    let committed=apply_isolated_planner_proposal(&db,&root.join("stores"),&graph(),
        "17","plan-1",generation,&proposal,&available).unwrap();
    assert_eq!(committed["status"],"SUCCEEDED");
    let saved=sqlite.load_job("17").unwrap().unwrap();
    assert_eq!(saved["tasks"].as_array().unwrap().len(),2);
    assert_eq!(saved["tasks"][1]["state"],"QUEUED");
    assert_eq!(saved["tasks"][1]["adapter"],"codex");
    assert_eq!(saved["plans"][0]["appliedExecutionId"],generation);
    drop(sqlite);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn planner_cannot_commit_new_model_task_without_an_installed_worker_transport(){
    let script=r#"export async function run({input}){
        return {objective_status:'in_progress',assessment:'Need isolated model validation',
        next_tasks:[{id:'draft-auditor',title:'Validate result',agentName:'auditor',
          adapter:'chatgpt',priority:'P2',storySize:'S',
          routing:{provider:'chatgpt',model:'isolated-fixture',decidedBy:'planner',
            decidedAt:'2026-11-18T00:00:00.000Z'},
          input:'Validate the source result and write evidence',
          output:{kind:'file',path:input.job.projectRoot+'/new-proof.json'},
          dependencies:['2']}],unblocks:[]};
    }"#;
    let (root,project,db,script_path)=fixture(script);
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&job(&project)).unwrap();seeded_plan(&store);
    let runtime=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let outcome=run_isolated_script_planner(&db,&root.join("stores"),&graph(),
        "17","plan-1",&script_path,&runtime,6000);
    let persisted=store.load_job("17").unwrap().unwrap();
    assert_ne!(persisted["plans"][0]["status"],"SUCCEEDED",
        "Planner cannot silently create Task for an uninstalled model provider: {persisted}");
    assert_eq!(persisted["tasks"].as_array().unwrap().len(),1);
    assert_eq!(persisted["state"],"ACTIVE");
    if let Err(error)=outcome{
        assert!(!error.is_empty());
    }
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn installed_isolated_browser_worker_allows_real_planner_to_materialize_dependent_dag_task(){
    use std::os::unix::{net::UnixListener,fs::PermissionsExt};
    let script=r#"export async function run({input}){
        return {objective_status:'in_progress',assessment:'Need browser review',
        next_tasks:[{id:'draft-auditor',title:'Validate result',agentName:'auditor',
          adapter:'chatgpt',priority:'P2',storySize:'S',
          routing:{provider:'chatgpt',model:'isolated-fixture',decidedBy:'planner',
            decidedAt:'2026-11-18T00:00:00.000Z'},
          input:'Validate the source result and write evidence',
          output:{kind:'file',path:input.job.projectRoot+'/new-proof.json'},
          dependencies:['2']}],unblocks:[]};
    }"#;
    let (root,project,db,script_path)=fixture(script);
    let socket=root.join("wh.sock");
    let _listener=UnixListener::bind(&socket).unwrap();
    let executable=root.join("fake-webhelm");
    fs::write(&executable,"#!/bin/sh\necho isolated\n").unwrap();
    fs::set_permissions(&executable,fs::Permissions::from_mode(0o700)).unwrap();
    let original_socket=env::var_os("AGENTS_RELAY_WEBHELM_SOCKET");
    let original_exec=env::var_os("AGENTS_RELAY_WEBHELM_EXECUTABLE");
    unsafe{
        env::set_var("AGENTS_RELAY_WEBHELM_SOCKET",&socket);
        env::set_var("AGENTS_RELAY_WEBHELM_EXECUTABLE",&executable);
    }
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&job(&project)).unwrap();seeded_plan(&store);
    let runtime=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let result=run_isolated_script_planner(&db,&root.join("stores"),&graph(),
        "17","plan-1",&script_path,&runtime,6000);
    unsafe{
        if let Some(value)=original_socket {env::set_var("AGENTS_RELAY_WEBHELM_SOCKET",value);}
        else{env::remove_var("AGENTS_RELAY_WEBHELM_SOCKET");}
        if let Some(value)=original_exec{env::set_var("AGENTS_RELAY_WEBHELM_EXECUTABLE",value);}
        else{env::remove_var("AGENTS_RELAY_WEBHELM_EXECUTABLE");}
    }
    let finished=result.unwrap();
    assert_eq!(finished["plans"][0]["status"],"SUCCEEDED","{finished}");
    assert_eq!(finished["plans"][0]["objectiveStatus"],"in_progress");
    assert_eq!(finished["tasks"].as_array().unwrap().len(),2);
    let task=&finished["tasks"][1];
    let id=task["id"].as_str().unwrap();
    assert!(id.bytes().all(|b|b.is_ascii_digit()),"Allocated Task must use shared numeric SQLite sequence");
    assert_eq!(finished["plans"][0]["generatedTaskIds"],json!([id]));
    assert_eq!(task["agentName"],"auditor");
    assert_eq!(task["adapter"],"chatgpt");
    assert_eq!(task["dependencies"],json!(["2"]));
    assert_eq!(task["state"],"QUEUED");
    assert_ne!(finished["state"],"COMPLETED",
        "Creating a new Task never means the objective was completed");
    assert_eq!(store.load_job("17").unwrap().unwrap(),finished);
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn planner_cross_job_unblock_is_graph_authorized_and_committed_as_atomic_sqlite_pair(){
 use agents_relay_rust2::native_script_planner::register_isolated_planner_unblock;
 use std::process::Command;
 let (root,project,db,script)=fixture(r#"export async function run() {
   return {objective_status:'satisfied',assessment:'Cross-job request verified',
     next_tasks:[],unblocks:[{repository:'dependent',prNumber:0,
       jobId:'41',taskId:'71',resolutionMode:'merge'}]};
 }"#);
 for repository in ["project","dependent"] {
  let directory=root.join(repository);
  fs::create_dir_all(&directory).unwrap();
  assert!(Command::new("git").arg("init").arg("-q").arg(&directory)
    .status().unwrap().success());
 }
 let dependent_root=root.join("dependent");
 let block=SQLiteRelayStore::open(&db,Some("17")).unwrap();
 block.save_job(&job(&project)).unwrap();
 seeded_plan(&block);
 let related=SQLiteRelayStore::open_without_claim_reset(&db,Some("41")).unwrap();
 related.save_job(&json!({"id":"41","repository":"dependent",
  "projectRoot":dependent_root,"prNumber":0,"state":"ACTIVE",
  "title":"Dependent isolated Job",
  "createdAt":"2026-11-18T00:00:00.000Z",
  "updatedAt":"2026-11-18T00:00:00.000Z","plans":[],
  "tasks":[{"id":"71","jobId":"41","agentName":"implementation",
    "kind":"work","state":"DRAFT","attempt":0,"maxAttempts":3,
    "dependencies":[],"input":"Wait for upstream work",
    "createdAt":"2026-11-18T00:00:00.000Z",
    "updatedAt":"2026-11-18T00:00:00.000Z"}]})).unwrap();
 let original_blocker=block.load_job("17").unwrap().unwrap();
 let original_dependent=related.load_job("41").unwrap().unwrap();
 let runtime=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
 let completed=run_isolated_script_planner(
    &db,&root.join("stores"),&graph(),"17","plan-1",
    &script,&runtime,6000).unwrap();
 assert_eq!(completed["plans"][0]["status"],"SUCCEEDED","{completed}");
 assert_eq!(completed["plans"][0]["objectiveStatus"],"satisfied");
 assert!(completed["plans"][0].get("pendingUnblocks")
   .is_none_or(Value::is_null),"verified cross-Job unblock must be acked");
 assert_eq!(completed["unblocks"][0]["jobId"],"41");
 assert_eq!(completed["unblocks"][0]["taskId"],"71");
 let related_now=related.load_job("41").unwrap().unwrap();
 assert_eq!(related_now["tasks"][0]["blockedBy"]["jobId"],"17");
 assert_eq!(related_now["tasks"][0]["blockedBy"]["repository"],"project");
 assert_ne!(related_now,original_dependent);
 let replay=register_isolated_planner_unblock(
   &db,&root.join("stores"),&graph(),"17",
   &json!({"repository":"dependent","prNumber":0,
     "jobId":"41","taskId":"71","resolutionMode":"merge"}));
 assert!(replay.is_ok(),"repeated registration is idempotent: {replay:?}");
 let second=block.load_job("17").unwrap().unwrap();
 assert_eq!(second["unblocks"].as_array().unwrap().len(),1);
 let second_related=related.load_job("41").unwrap().unwrap();
 assert_eq!(second_related["tasks"][0]["blockedBy"],related_now["tasks"][0]["blockedBy"]);
 assert_ne!(second,original_blocker);
 let foreign=register_isolated_planner_unblock(
   &db,&root.join("stores"),&graph(),"17",
   &json!({"repository":"wrong","prNumber":0,
     "jobId":"41","taskId":"71","resolutionMode":"merge"}));
 assert!(foreign.is_err(),"wrong dependent repository must fail closed");
 assert_eq!(block.load_job("17").unwrap().unwrap(),second);
 assert_eq!(related.load_job("41").unwrap().unwrap(),second_related);
 drop(related);drop(block);
 fs::remove_dir_all(root).unwrap();
}
