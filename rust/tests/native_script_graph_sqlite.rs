//! Real Rust-owned JS Shortcut, exact claimed Task generation, Graph state
//! transitions, committed SQLite event outbox and output artifact.
use agents_relay_rust2::{
    native_script_execution::run_claimed_script_task,
    reconciler::Reconciler,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{env,fs,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
fn fixture()->(PathBuf,PathBuf,PathBuf){
    let root=env::temp_dir().join(format!("native-script-graph-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let project=root.join("project");
    fs::create_dir_all(project.join("agents/.shortcut")).unwrap();
    fs::create_dir_all(root.join("stores")).unwrap();
    fs::write(project.join("agents/fixture.agent.md"),
        "---\nname: fixture\ncapabilities: [script]\n---\n# Fixture\n").unwrap();
    fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),
        "export async function run({input}) {return {status:'COMPLETED',output:{ok:true,execution:input.executionId},artifacts:{}};}\n").unwrap();
    let db=root.join("relay.sqlite");
    (root,project,db)
}
fn make_job(project:&Path,root:&Path)->Value{
    json!({"id":"17","repository":"project","projectRoot":project,
        "state":"ACTIVE","prNumber":0,"priority":"P2","reviewEnabled":false,
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
        "tasks":[{"id":"2","jobId":"17","kind":"work","title":"Script Worker",
            "agentName":"fixture","adapter":"script","state":"QUEUED","attempt":0,
            "maxAttempts":3,"priority":"P2","dependencies":[],"input":"{}",
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
            "output":{"kind":"file","path":root.join("output.json")}}],"plans":[]})
}
fn graph()->PathBuf{Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
#[test]
fn real_worker_script_module_succeeds_only_after_sqlite_and_graph_started_and_completed(){
    let (root,project,db)=fixture();
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    let job=make_job(&project,&root);store.save_job(&job).unwrap();
    let mut reconciler=Reconciler::new(graph(),root.join("stores"),root.join("profiles"),
        root.join("routing.json"),root.join("rules.md"),json!({"owner":"native-test"}));
    let candidate=reconciler.claim_task_execution(&job,"2").unwrap().expect("Task must claim execution generation");
    assert_eq!(candidate["tasks"][0]["state"],"QUEUED");
    assert!(candidate["tasks"][0]["executionId"].as_str().is_some_and(|id|!id.is_empty()));
    assert!(candidate["tasks"][0].get("leaseOwner").is_none());
    store.save_job(&candidate).unwrap();
    let task=candidate["tasks"][0].clone();
    let interpreter=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let result=run_claimed_script_task(&db,&graph(),&candidate,&task,&interpreter,6000).unwrap();
    assert_eq!(result["status"],"COMPLETED");
    let persisted=store.load_job("17").unwrap().unwrap();
    assert_eq!(persisted["tasks"][0]["state"],"SUCCEEDED");
    assert!(persisted["tasks"][0]["executionId"].is_null());
    let execution=task["executionId"].as_str().unwrap();
    let record=store.load_execution_process("17","2",execution)
        .unwrap().expect("Original Script Worker PID/PGID must be recorded");
    assert_eq!(record["pid"],record["pgid"]);
    assert!(record["startToken"].as_str().is_some_and(|s|!s.is_empty()));
    assert!(record["endedAt"].is_string(),"Completed Worker process has durable end receipt");
    assert_eq!(persisted["tasks"][0]["result"]["data"]["status"],"COMPLETED");
    assert_eq!(persisted["tasks"][0]["result"]["data"]["output"]["ok"],true);
    let output:Value=serde_json::from_str(&fs::read_to_string(root.join("output.json")).unwrap()).unwrap();
    assert_eq!(output["output"]["ok"],true);
    assert!(run_claimed_script_task(&db,&graph(),&candidate,&task,&interpreter,6000).is_err(),
        "Replayed stale execution cannot complete twice");
    fs::remove_dir_all(root).unwrap();
}

fn assert_terminal_script_failure(script_source:&str,expected:&str){
    let (root,project,db)=fixture();
    fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),script_source).unwrap();
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    let mut job=make_job(&project,&root);
    job["tasks"][0]["maxAttempts"]=json!(1);
    store.save_job(&job).unwrap();
    let mut reconciler=Reconciler::new(graph(),root.join("stores"),root.join("profiles"),
        root.join("routing.json"),root.join("rules.md"),json!({"owner":"native-failure-test"}));
    let claimed=reconciler.claim_task_execution(&job,"2").unwrap().unwrap();
    store.save_job(&claimed).unwrap();
    let task=claimed["tasks"][0].clone();
    let interpreter=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let failure=run_claimed_script_task(&db,&graph(),&claimed,&task,&interpreter,6500).unwrap_err();
    assert!(failure.contains(expected),"{failure}");
    let durable=store.load_job("17").unwrap().unwrap();
    assert_eq!(durable["tasks"][0]["state"],"FAILED",
        "Failure must transition through canonical Task Graph: {durable}");
    assert!(durable["tasks"][0]["executionId"].is_null());
    let count:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'script-event/17/2/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(count,2,"Failure must emit one start and one failed terminal event");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn javascript_shortcut_error_fails_exact_graph_generation_without_false_success(){
    assert_terminal_script_failure(
        "export async function run() {throw Error('injected Worker failure')};\n",
        "injected Worker failure");
}
#[test]
fn interactive_script_without_review_host_fails_closed_instead_of_phantom_approval(){
    assert_terminal_script_failure(
        "export async function run() {return {status:'WAITING_REVIEW'}};\n",
        "requires a verified human review invocation");
}

/// Original public ScriptTaskAdapter emits task.failed even if a selected
/// Agent has no Shortcut. The production Graph must durably accept exactly
/// one pre-start failure on its original execution generation, then reject stale replay.
#[test]
fn missing_selected_agent_shortcut_fails_native_graph_before_start_once(){
    let (root,project,db)=fixture();
    fs::remove_file(project.join("agents/.shortcut/fixture.agent.mjs")).unwrap();
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    let mut job=make_job(&project,&root);
    job["tasks"][0]["maxAttempts"]=json!(1);
    store.save_job(&job).unwrap();
    let mut reconciler=Reconciler::new(graph(),root.join("stores"),root.join("profiles"),
        root.join("routing.json"),root.join("rules.md"),json!({"owner":"native-missing-script"}));
    let claimed=reconciler.claim_task_execution(&job,"2")
        .unwrap().expect("fresh Task generation");
    store.save_job(&claimed).unwrap();
    let task=claimed["tasks"][0].clone();
    let interpreter=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let error=run_claimed_script_task(&db,&graph(),&claimed,&task,&interpreter,4500)
        .unwrap_err();
    assert!(error.contains("Declared Agent Shortcut is unavailable"),"{error}");
    let actual=store.load_job("17").unwrap().unwrap();
    assert_eq!(actual["tasks"][0]["state"],"FAILED","{actual}");
    assert!(actual["tasks"][0]["executionId"].is_null());
    let count:i64=store.db.query_row(
        "SELECT COUNT(*) FROM workflow_event_outbox WHERE event_key LIKE 'script-event/17/2/%'",
        [],|row|row.get(0)).unwrap();
    assert_eq!(count,1,"A pre-start missing Shortcut emits one failed terminal receipt");
    assert!(run_claimed_script_task(&db,&graph(),&claimed,&task,&interpreter,4500)
        .is_err(),"A stale generation must not resubmit an unavailable Shortcut");
    fs::remove_dir_all(root).unwrap();
}

/// A real Shortcut runs an owned local subprocess through Script.runCommand,
/// not a mocked return value. Its stdout only becomes a Task result after a
/// verified Graph start/completion and exact original execution identity.
#[test]
fn real_script_runcommand_output_is_graph_fenced_and_durably_delivered(){
    let (root,project,db)=fixture();
    fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),
        r#"export async function run({input,runCommand}) {
          const result=await runCommand([process.execPath,'-e',
            'process.stdout.write("SCRIPT_COMMAND_OWNED_OK")'],process.cwd());
          if(result.code!==0) throw Error('Real subprocess failed: '+result.stderr);
          return {status:'COMPLETED',output:{runCommand:result.stdout,
            execution:input.executionId},artifacts:{}};
        }"#).unwrap();
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    let job=make_job(&project,&root);
    store.save_job(&job).unwrap();
    let mut reconciler=Reconciler::new(graph(),root.join("stores"),root.join("profiles"),
        root.join("routing.json"),root.join("rules.md"),json!({"owner":"native-command-verified"}));
    let claimed=reconciler.claim_task_execution(&job,"2")
        .unwrap().expect("Task must obtain a unique durable generation");
    store.save_job(&claimed).unwrap();
    let task=claimed["tasks"][0].clone();
    let interpreter=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let result=run_claimed_script_task(&db,&graph(),&claimed,&task,&interpreter,6500)
        .expect("Real local Worker subprocess and Task Graph must complete");
    assert_eq!(result["output"]["runCommand"],"SCRIPT_COMMAND_OWNED_OK");
    assert_eq!(result["output"]["execution"],task["executionId"]);
    let persisted=store.load_job("17").unwrap().unwrap();
    assert_eq!(persisted["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(persisted["tasks"][0]["result"]["data"]["output"]["runCommand"],
        "SCRIPT_COMMAND_OWNED_OK");
    assert_eq!(serde_json::from_str::<Value>(
        &fs::read_to_string(root.join("output.json")).unwrap()).unwrap()["output"]["runCommand"],
        "SCRIPT_COMMAND_OWNED_OK");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn native_script_dag_result_rejects_then_accepts_validated_completion(){
    use agents_relay_rust2::{
        native_script_execution::persist_native_script_event,
        events::event_for,
        execution_event_identity::execution_event_source,
    };
    let (root,project,db)=fixture();
    let path=project.join("runs/test/.dag-node-results/2.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut job=make_job(&project,&root);
    job["tasks"][0]["dagNode"]=json!({"nodeId":"fixture","parentTaskId":"1","graphHash":"example"});
    job["tasks"][0]["state"]=json!("RUNNING");
    job["tasks"][0]["executionId"]=json!("exec-1");
    job["tasks"][0]["executionHistory"]=json!([{"id":"exec-1","attempt":1}]);
    job["tasks"][0]["output"]=json!({"kind":"file","path":path});
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&job).unwrap();
    let event=event_for("17","2",None,"task.completed","succeeded","Script completed",
        Some("worker"),Some(json!({"status":"COMPLETED","output":{},"artifacts":[]})),
        Some(json!({"id":execution_event_source("17","2","exec-1")})));
    fs::write(&path,r#"{"status":"COMPLETED","artifacts":[]}"#).unwrap();
    let err=persist_native_script_event(&db,&graph(),"17","2","exec-1",&event).unwrap_err();
    assert!(err.contains("output object"),"{err}");
    assert_eq!(store.load_job("17").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    fs::write(&path,r#"{"status":"COMPLETED","output":{},"artifacts":[]}"#).unwrap();
    let done=persist_native_script_event(&db,&graph(),"17","2","exec-1",&event).unwrap();
    assert_eq!(done["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(done["tasks"][0]["result"]["data"]["validated_dag_result"],true);
    assert!(done["tasks"][0]["result"]["data"]["dag_result_proof"]["resultSha256"].is_string());
    fs::remove_dir_all(root).unwrap();
}

/// Hold the real stage verifier open after the Shortcut child exits. A
/// concurrent reconciliation probe must not reclaim this generation, and an
/// unrelated durable Job write must survive the terminal event transaction.
#[test]
fn script_settlement_survives_child_exit_and_concurrent_job_update(){
    use agents_relay_rust2::execution_process_tracker::reclaim_stale_execution_process;
    use std::{future::Future,task::{Context,Poll,Waker},thread,time::{Duration,Instant}};
    let (root,project,db)=fixture();
    let run=project.join("runs/test");
    let path=run.join(".dag-node-results/2.json");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::create_dir_all(project.join("scripts")).unwrap();
    fs::write(project.join("project.run.json"),r#"{"stageValidation":{"script":"scripts/validate.mjs","agents":{"fixture":"fixture"}}}"#).unwrap();
    fs::write(project.join("scripts/validate.mjs"),r#"
import fs from 'node:fs';
import path from 'node:path';
const run=process.argv[3];
fs.writeFileSync(path.join(run,'validating'),'yes');
const deadline=Date.now()+10000;
while(!fs.existsSync(path.join(run,'release'))){
  if(Date.now()>deadline)throw Error('test synchronization deadline');
  await new Promise(r=>setTimeout(r,20));
}
console.log(JSON.stringify({stage:'fixture',status:'PASS',errors:[]}));
"#).unwrap();
    let mut job=make_job(&project,&root);
    job["tasks"][0]["dagNode"]=json!({"nodeId":"fixture","parentTaskId":"1","graphHash":"example","executor":"script"});
    job["tasks"][0]["input"]=json!(r#"{"source":"relay-dag-task","nodeId":"fixture","taskId":"2"}"#);
    job["tasks"][0]["output"]=json!({"kind":"file","path":path});
    let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
    store.save_job(&job).unwrap();
    let mut reconciler=Reconciler::new(graph(),root.join("stores"),root.join("profiles"),
        root.join("routing.json"),root.join("rules.md"),json!({"owner":"race-test"}));
    let claimed=reconciler.claim_task_execution(&job,"2").unwrap().unwrap();
    store.save_job(&claimed).unwrap();
    let task=claimed["tasks"][0].clone();
    let worker_db=db.clone();
    let interpreter=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
    let worker=thread::spawn(move||run_claimed_script_task(&worker_db,&graph(),&claimed,&task,&interpreter,6500));
    let deadline=Instant::now()+Duration::from_secs(10);
    while !run.join("validating").exists(){
        assert!(Instant::now()<deadline,"Stage validator did not start");
        thread::sleep(Duration::from_millis(20));
    }
    let current=store.load_job("17").unwrap().unwrap();
    let active=&current["tasks"][0];
    assert_eq!(active["state"],"RUNNING");
    let execution=active["executionId"].as_str().unwrap();
    let record=store.load_execution_process("17","2",execution).unwrap().unwrap();
    assert!(record["endedAt"].is_string(),"Shortcut child already exited");
    let future=reclaim_stale_execution_process(active,|j,t,e|
        std::future::ready(store.load_execution_process(&j,&t,&e)));
    let mut future=std::pin::pin!(future);
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())),Poll::Ready(Ok(false))),
        "A live native Worker settling its terminal event is not an exited execution");
    let mut changed=current.clone();
    changed["description"]=json!("concurrent job update");
    store.save_job(&changed).unwrap();
    fs::write(run.join("release"),"yes").unwrap();
    worker.join().unwrap().expect("validated terminal commit must survive concurrent write");
    let final_job=store.load_job("17").unwrap().unwrap();
    assert_eq!(final_job["description"],"concurrent job update");
    assert_eq!(final_job["tasks"][0]["state"],"SUCCEEDED");
    assert_eq!(final_job["tasks"][0]["result"]["data"]["validated_dag_result"],true);
    // Once the native worker has returned, the same ended process is
    // reclaimable if a Task were still active; no timeout or durable lock.
    let future=reclaim_stale_execution_process(active,|_,_,_|std::future::ready(Ok(Some(record))));
    let mut future=std::pin::pin!(future);
    assert!(matches!(future.as_mut().poll(&mut Context::from_waker(Waker::noop())),Poll::Ready(Ok(true))));
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn review_capability_is_resolved_at_claim_and_delivered_to_script(){
    use agents_relay_rust2::{interactive_review_policy::bind_claim,reconciler_context::WorkerContextRoots};
    for (job_enabled,agent_enabled) in [(false,false),(false,true),(true,false),(true,true)] {
        let (root,project,db)=fixture();
        fs::write(project.join("agents/fixture.agent.md"),format!("---\nname: fixture\ninteractive_review: {agent_enabled}\ncapabilities: [script]\n---\n# Fixture\n")).unwrap();
        fs::write(project.join("agents/.shortcut/fixture.agent.mjs"),format!("export async function run({{input}}) {{if (input.interactiveReviewEnabled !== {}) throw Error('incorrect runtime flag'); return {{status:'COMPLETED',output:{{ok:true}},artifacts:{{}}}};}}",job_enabled&&agent_enabled)).unwrap();
        let mut job=make_job(&project,&root);job["interactiveReviewEnabled"]=json!(job_enabled);job["tasks"][0]["maxAttempts"]=json!(1);
        let store=SQLiteRelayStore::open(&db,Some("17")).unwrap();
        let mut reconciler=Reconciler::new(graph(),root.join("stores"),root.join("profiles"),root.join("routing.json"),root.join("rules.md"),json!({"owner":"interactive-policy-test"}));
        let mut claimed=reconciler.claim_task_execution(&job,"2").unwrap().unwrap();
        bind_claim(&mut claimed,"2",&WorkerContextRoots::isolated(&root)).unwrap();
        assert_eq!(claimed["tasks"][0]["interactiveReviewEnabled"],job_enabled&&agent_enabled);
        store.save_job(&claimed).unwrap();
        let task=claimed["tasks"][0].clone();
        let runtime=PathBuf::from(env::var("AGENTS_RELAY_SCRIPT_NODE").unwrap());
        let outcome=run_claimed_script_task(&db,&graph(),&claimed,&task,&runtime,6000);
        if job_enabled&&agent_enabled {assert!(outcome.unwrap_err().contains("Graph rejected task.completed"));}
        else {assert_eq!(outcome.unwrap()["status"],"COMPLETED");}
        fs::remove_dir_all(root).unwrap();
    }
}
