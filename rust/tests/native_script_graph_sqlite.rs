//! Real Rust-owned JS Shortcut, exact leased Task generation, Graph state
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
        root.join("routing.json"),root.join("rules.md"),json!({"owner":"native-test","leaseMs":300000}));
    let candidate=reconciler.claim_task_execution(&job,"2",300000).unwrap().expect("Task must claim lease");
    assert_eq!(candidate["tasks"][0]["state"],"QUEUED");
    assert_eq!(candidate["tasks"][0]["leaseOwner"],"native-test");
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
    let claimed=reconciler.claim_task_execution(&job,"2",300000).unwrap().unwrap();
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
