//! L3 gate: a host-bound Script Agent review cannot acknowledge waiting before
//! canonical Graph + SQLite actually enter AWAITING_DECISION. No live store.
use agents_relay_rust2::{
    relayd::{DaemonConfig, DaemonServices},
    relayd_control::workspace_control,
    relayd_sqlite_write::IsolatedSQLiteWriteHost,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json, Value};
use std::{fs, path::{Path, PathBuf}, time::{SystemTime, UNIX_EPOCH}};
struct Fixture { root:PathBuf, host:IsolatedSQLiteWriteHost, store:SQLiteRelayStore }
impl Fixture {
    fn new()->Self {
        let root=std::env::temp_dir().join(format!("rust2-l3-review-wait-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH)
                .unwrap().as_nanos()));
        let project=root.join("fixture");
        fs::create_dir_all(&project).unwrap();
        fs::create_dir_all(root.join("stores")).unwrap();
        assert!(std::process::Command::new("git").args(["init","-q","-b","main"])
            .current_dir(&project).status().unwrap().success());
        let config=DaemonConfig {
            workspace_root:root.clone(),store_directory:root.join("stores"),
            graph_directory:Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
            profile_home:root.join("profiles"),policy_path:root.join("routing.json"),
            router_rules_path:root.join("rules.md"),dashboard_asset:root.join("index.html"),
            repositories:vec!["fixture".into()],port:0,concurrency:1,interval_ms:100,
            event_transport:json!({}),
        };
        let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("17")).unwrap();
        store.save_job(&json!({
            "id":"17","repository":"fixture","projectRoot":project,
            "title":"L3 Agent Review gate","state":"ACTIVE","prNumber":0,
            "reviewEnabled":false,"autoMerge":false,"plans":[],
            "createdAt":"2026-11-22T00:00:00.000Z","updatedAt":"2026-11-22T00:00:00.000Z",
            "tasks":[
                {"id":"2","jobId":"17","title":"first","agentName":"first",
                 "kind":"work","adapter":"script","state":"RUNNING",
                 "attempt":1,"maxAttempts":3,"dependencies":[],
                 "executionId":"exec-17-2","leaseOwner":"fixture-owner",
                 "leaseExpiresAt":"2027-11-22T00:00:00.000Z",
                 "createdAt":"2026-11-22T00:00:00.000Z",
                 "updatedAt":"2026-11-22T00:00:00.000Z"},
                {"id":"3","jobId":"17","title":"second","agentName":"second",
                 "kind":"work","adapter":"script","state":"DRAFT",
                 "attempt":0,"maxAttempts":3,"dependencies":["2"],
                 "createdAt":"2026-11-22T00:00:00.000Z",
                 "updatedAt":"2026-11-22T00:00:00.000Z"}
            ]
        })).unwrap();
        Self{root,host:IsolatedSQLiteWriteHost::new(config),store}
    }
    fn job(&self)->Value {self.store.load_job("17").unwrap().unwrap()}
    fn control(&mut self,action:&str,execution:&str)->Result<Value,String> {
        workspace_control(&mut self.host,&json!({
            "command":format!("review.interactive.{action}"),
            "jobId":"17","taskId":"2","executionId":execution,
        }))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {let _=fs::remove_dir_all(&self.root);}
}
#[test]
fn native_review_wait_is_one_durable_graph_sqlite_transition_and_gates_downstream() {
    let mut f=Fixture::new();
    let original=f.job();
    assert!(f.control("wait","exec-17-2").is_err(),
        "Unbound Review wait must not be acknowledged");
    assert_eq!(f.job(),original,"Invalid review must not mutate SQLite");
    let receipt=f.control("begin","exec-17-2").unwrap();
    assert_eq!(receipt["executionId"],"exec-17-2");
    let bound=f.job();
    assert_eq!(bound["tasks"][0]["state"],"RUNNING");
    assert_eq!(bound["tasks"][0]["interactiveInvocation"]["status"],"awaiting_decision");
    let waiting=f.control("wait","exec-17-2").unwrap();
    assert_eq!(waiting["taskState"],"AWAITING_DECISION");
    let persisted=f.job();
    assert_eq!(persisted["tasks"][0]["state"],"AWAITING_DECISION");
    assert!(persisted["tasks"][0]["executionId"].is_null());
    assert!(persisted["tasks"][0]["leaseOwner"].is_null());
    assert_eq!(persisted["tasks"][0]["interactiveInvocation"]["executionId"],"exec-17-2");
    assert_eq!(persisted["tasks"][1]["state"],"DRAFT",
        "Downstream must remain gated until true Approve");
    assert_eq!(f.control("wait","exec-17-2").unwrap()["taskState"],"AWAITING_DECISION");
    assert_eq!(f.job(),persisted,"Repeated wait must be an exact durable no-op");
    assert!(f.control("wait","stale-execution").is_err(),
        "Stale generation must be rejected even after Review is bound");
    assert_eq!(f.job(),persisted);
    assert_eq!(DaemonServices::status(&mut f.host)["mode"],"isolated-write");
}
