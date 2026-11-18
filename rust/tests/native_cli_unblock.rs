// True CLI entrypoint test with isolated, canonical SQLite durable mutation.
use agents_relay_rust2::{
    cli_unblock::{run_job_unblock_command,run_task_unblock_command},
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::path::Path;
fn graph()->&'static Path {
    Path::new(concat!(env!("CARGO_MANIFEST_DIR"),"/../workflow"))
}
fn store()->SQLiteRelayStore {
    SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap()
}
fn job()->Value {
    json!({
        "id":"41","repository":"fixture-repo","projectRoot":"/tmp/rust2-api-fixture",
        "title":"fixture","state":"ACTIVE",
        "updatedAt":"2026-11-17T04:00:00.000Z",
        "tasks":[{
            "id":"71","jobId":"41","kind":"work","agentName":"troubleshooter",
            "state":"BLOCKED","attempt":2,"maxAttempts":3,
            "updatedAt":"2026-11-17T04:00:00.000Z","error":"provider failure",
            "blockedBaseline":{"blockedAt":"2026-11-17T04:00:00.000Z","headSha":"older"}
        }],
        "plans":[]
    })
}
fn args(reason:&str)->Vec<String>{
    vec!["--reason".into(),reason.into()]
}
#[test]
fn task_cli_unblocks_durably_and_does_not_claim_terminal_completion(){
    let store=store();let job=job();store.save_job(&job).unwrap();
    let before=store.load_job("41").unwrap().unwrap();
    let output=run_task_unblock_command(
        graph(),&args("local fix"),&store,&before,&before["tasks"][0],None,None)
        .unwrap();
    assert_eq!(output["taskId"],"71");
    assert_eq!(output["replanning"],false);
    let after=store.load_job("41").unwrap().unwrap();
    assert_eq!(output["task"],after["tasks"][0]);
    assert_ne!(after["state"],"COMPLETED");
    assert!(matches!(after["tasks"][0]["state"].as_str(),
        Some("DRAFT"|"QUEUED")));
    assert_eq!(after["tasks"][0]["unblock"]["source"],"cli");
    assert_eq!(after["tasks"][0]["unblock"]["reason"],"local fix");
    assert_eq!(after["tasks"][0]["attempt"],0);
    assert!(run_task_unblock_command(graph(),&args("duplicate"),
        &store,&after,&after["tasks"][0],None,None).is_err());
    assert_eq!(store.load_job("41").unwrap().unwrap(),after);
}
#[test]
fn job_cli_unblocks_all_effective_blocked_and_rejects_replay(){
    let store=store();
    let mut job=job();let mut second=job["tasks"][0].clone();
    second["id"]=json!("72");job["tasks"].as_array_mut().unwrap().push(second);
    store.save_job(&job).unwrap();
    let output=run_job_unblock_command(
        graph(),&args("all repaired"),&store,&job,None).unwrap();
    assert_eq!(output["resumedTasks"],json!(["71","72"]));
    let after=store.load_job("41").unwrap().unwrap();
    for task in after["tasks"].as_array().unwrap(){
        assert_eq!(task["unblock"]["reason"],"all repaired");
        assert_eq!(task["attempt"],0);
    }
    assert!(run_job_unblock_command(graph(),&args("again"),&store,&after,None)
        .unwrap_err().contains("has no effective BLOCKED"));
}
#[test]
fn pending_human_response_requires_real_response_and_cannot_auto_retry(){
    let store=store();let mut job=job();
    job["tasks"][0]["escalation"]=json!({"id":"e-71","status":"pending"});
    store.save_job(&job).unwrap();
    let original=store.load_job("41").unwrap().unwrap();
    assert!(run_task_unblock_command(
        graph(),&args("no approval"),&store,&original,
        &original["tasks"][0],None,None).is_err());
    assert_eq!(store.load_job("41").unwrap().unwrap(),original);
    let response=["--response".into(),"owner approved".into()];
    let output=run_task_unblock_command(
        graph(),&response,&store,&original,
        &original["tasks"][0],None,None).unwrap();
    assert_eq!(output["resumed"],true);
    assert_eq!(output["task"]["escalation"]["status"],"responded");
    assert_eq!(output["task"]["escalation"]["response"],"owner approved");
    let persisted=store.load_job("41").unwrap().unwrap();
    assert_eq!(persisted["tasks"][0]["escalation"],output["task"]["escalation"]);
    assert_eq!(persisted["tasks"][0]["state"],output["task"]["state"]);
    assert_eq!(persisted["tasks"][0]["comments"][0]["kind"],"escalation.responded");
}
#[test]
fn rejects_bad_arguments_without_sqlite_mutation(){
    let store=store();let job=job();store.save_job(&job).unwrap();
    let before=store.load_job("41").unwrap().unwrap();
    assert_eq!(run_task_unblock_command(graph(),&[],&store,&job,
        &job["tasks"][0],None,None).unwrap_err(),
        "task unblock requires --reason or --response");
    assert_eq!(run_job_unblock_command(graph(),&[],&store,&job,None)
        .unwrap_err(),"job unblock requires --reason");
    assert_eq!(store.load_job("41").unwrap().unwrap(),before);
}
