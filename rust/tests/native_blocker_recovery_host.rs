//! Real isolated daemon-owned blocker recovery. Two independent Git fixtures,
//! canonical Mermaid policy, numeric SQLite ID, cross-Job atomic CAS, restart.
//! No external provider, production store, network, or Relay job is used.
use agents_relay_rust2::{
    relayd::DaemonConfig,
    relayd_sqlite_write::IsolatedSQLiteWriteHost,
    relayd_control::WorkspaceControlBackend,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::relay_unified_store_path,
};
use serde_json::{json,Value};
use std::{fs,path::PathBuf,process::Command,time::{SystemTime,UNIX_EPOCH}};
fn graph()->PathBuf{PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow")}
struct Fixture{root:PathBuf,config:DaemonConfig}
impl Fixture{
    fn new()->Self{
        let root=std::env::temp_dir().join(format!("rust2-blocker-real-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        let stores=root.join("stores");fs::create_dir_all(&stores).unwrap();
        for repository in ["dependent","target"]{
            let dir=root.join(repository);fs::create_dir_all(&dir).unwrap();
            assert!(Command::new("git").args(["init","-q","--initial-branch=main"])
                .arg(&dir).status().unwrap().success());
        }
        let mut config=DaemonConfig::from_argv(&[],&json!({"storeDirectory":stores,
            "graphDirectory":graph(),"workspaceRoot":root})).unwrap();
        config.store_directory=root.join("stores");
        config.graph_directory=graph();
        config.workspace_root=root.clone();
        config.repositories=vec!["dependent".into(),"target".into()];
        let db=SQLiteRelayStore::open(&relay_unified_store_path(&stores),Some("17")).unwrap();
        db.save_job(&json!({"id":"17","title":"Dependent Job",
            "repository":"dependent","prNumber":0,
            "projectRoot":root.join("dependent"),"state":"ACTIVE",
            "tasks":[{"id":"5","jobId":"17","title":"Failed work",
                "kind":"work","agentName":"developer","state":"FAILED",
                "attempt":2,"maxAttempts":2,"dependencies":[],"capabilities":[],
                "input":"Build recovery","output":null,
                "createdAt":"2026-11-19T00:00:00.000Z",
                "updatedAt":"2026-11-19T00:00:00.000Z"}],
            "plans":[],"createdAt":"2026-11-19T00:00:00.000Z",
            "updatedAt":"2026-11-19T00:00:00.000Z"})).unwrap();
        db.close().unwrap();Self{root,config}
    }
    fn store(&self,id:&str)->SQLiteRelayStore{
        SQLiteRelayStore::open_without_claim_reset(
            &relay_unified_store_path(&self.config.store_directory),Some(id)).unwrap()
    }
    fn request(&self)->Value{
        json!({"requestId":"native-request-00001",
            "targetRepository":"target","targetProjectRoot":self.root.join("target"),
            "dependentRepository":"dependent","dependentJobId":"17",
            "dependentTaskId":"5", "origin":"planner", "resolutionMode":"merge",
            "authorized":true,"authorizedRepositories":["dependent","target"],
            "title":"Recover dependent build", "reason":"A durable target dependency blocked dependent Task 5",
            "objective":format!("Recover target repository in an independent Job to unblock dependent Task 5: {}", "recovery context ".repeat(10))})
    }
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}}
#[test]
fn isolated_control_creates_and_restart_reuses_one_atomic_blocker(){
    let f=Fixture::new();let request=f.request();
    let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
    let receipt=host.blocker_ensure(&request).unwrap();
    assert_eq!(receipt["outcome"],"created");
    assert_eq!(receipt["status"],"planning_required");
    let id=receipt["blockerJobId"].as_str().unwrap().to_owned();
    assert!(id.parse::<u64>().is_ok());
    let before=f.store("17").load_job("17").unwrap().unwrap();
    assert_eq!(before["tasks"][0]["blockedBy"]["jobId"],id);
    assert_eq!(before["tasks"][0]["blockerRecoveryReceipt"],receipt);
    let blocker=f.store(&id).load_job(&id).unwrap().unwrap();
    assert_eq!(blocker["repository"],"target");
    assert_eq!(blocker["unblocks"].as_array().unwrap().len(),1);
    assert_eq!(blocker["unblocks"][0]["jobId"],"17");
    drop(host);
    let mut restarted=IsolatedSQLiteWriteHost::new(f.config.clone());
    let again=restarted.blocker_ensure(&request).unwrap();
    assert_eq!(again["blockerJobId"],id);
    assert_eq!(again["outcome"],"reused");
    assert_eq!(f.store("17").load_job("17").unwrap().unwrap()["tasks"][0]["blockedBy"]["jobId"],id);
    assert_eq!(f.store(&id).load_job(&id).unwrap().unwrap()["unblocks"].as_array().unwrap().len(),1);
}
#[test]
fn invalid_target_and_rejected_graph_never_modify_dependent(){
    let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
    let prior=f.store("17").load_job("17").unwrap().unwrap();
    let mut wrong=f.request();wrong["targetProjectRoot"]=json!("/tmp/outside-git");
    assert!(host.blocker_ensure(&wrong).is_err());
    assert_eq!(f.store("17").load_job("17").unwrap().unwrap(),prior);
    let mut denied=f.request();denied["authorized"]=json!(false);
    assert!(host.blocker_ensure(&denied).is_err());
    assert_eq!(f.store("17").load_job("17").unwrap().unwrap(),prior);
}
#[test]
fn two_job_sqlite_cas_rejects_stale_and_rolls_back_both(){
    let f=Fixture::new();let mut host=IsolatedSQLiteWriteHost::new(f.config.clone());
    let receipt=host.blocker_ensure(&f.request()).unwrap();
    let id=receipt["blockerJobId"].as_str().unwrap();
    let owner=f.store("17");let dependent=owner.load_job("17").unwrap().unwrap();
    let blocker=f.store(id).load_job(id).unwrap().unwrap();
    let mut stale=dependent.clone();stale["updatedAt"]=json!("old");
    let mut changed_dependent=dependent.clone();changed_dependent["title"]=json!("Should roll back");
    let mut changed_blocker=blocker.clone();changed_blocker["title"]=json!("Should also roll back");
    assert!(owner.commit_blocker_recovery_pair(&stale,&changed_dependent,Some(&blocker),&changed_blocker)
        .unwrap_err().contains("Concurrent dependent Job"));
    assert_eq!(owner.load_job("17").unwrap().unwrap(),dependent);
    assert_eq!(f.store(id).load_job(id).unwrap().unwrap(),blocker);
    let mut stale_blocker=blocker.clone();stale_blocker["updatedAt"]=json!("old");
    assert!(owner.commit_blocker_recovery_pair(&dependent,&changed_dependent,Some(&stale_blocker),&changed_blocker)
        .unwrap_err().contains("Concurrent blocker Job"));
    assert_eq!(owner.load_job("17").unwrap().unwrap(),dependent);
    assert_eq!(f.store(id).load_job(id).unwrap().unwrap(),blocker);
}
