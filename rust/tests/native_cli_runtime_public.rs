// Node CLI dashboardJobAction shares Graph/SQLite with Relay, including
// atomic rollback and no wake on cancel. No production store is opened.
use agents_relay_rust2::{
    cli::dashboard_job_action,
    cli_runtime_public::DashboardJobActionPorts,
    relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
struct LocalCli {store:SQLiteRelayStore,graph:PathBuf,wakes:usize}
impl DashboardJobActionPorts for LocalCli {
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.store.load_job(id)?.ok_or("SQLite Job missing".into())
    }
    fn save_job(&mut self,job:&Value)->Result<(),String>{self.store.save_job(job)}
    fn mutate_job(&mut self,id:&str,operation:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{self.store.mutate_job(id,operation)}
    fn wake(&mut self,id:&str)->Result<Value,String>{
        self.wakes+=1;
        self.load_job(id)
    }
    fn workflow_directory(&self)->&Path{&self.graph}
}
#[test]
fn dashboard_start_and_cancel_apply_canonical_graph_via_atomic_sqlite(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!("rust2-cli-runtime-{}-{suffix}",std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let graph=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let store=SQLiteRelayStore::open(&root.join("jobs.sqlite"),Some("42")).unwrap();
    let job=json!({"id":"42","repository":"fixture","prNumber":0,
        "state":"DRAFT","title":"CLI test","createdAt":"2026-11-18T09:00:00Z",
        "updatedAt":"2026-11-18T09:00:00Z","reviewEnabled":false,"headSha":"head",
        "tasks":[],"plans":[]});
    store.save_job(&job).unwrap();
    let mut cli=LocalCli{store,graph,wakes:0};
    let started=dashboard_job_action(&mut cli,"start","42").unwrap();
    assert_eq!(started["state"],"ACTIVE");
    assert_eq!(cli.wakes,1);
    let durable=cli.store.load_job("42").unwrap().unwrap();
    assert_eq!(durable["state"],"ACTIVE");
    // The second start cannot be accepted by the Graph; no write or wake.
    assert!(dashboard_job_action(&mut cli,"start","42").is_err());
    assert_eq!(cli.store.load_job("42").unwrap().unwrap(),durable);
    assert_eq!(cli.wakes,1);
    let cancelled=dashboard_job_action(&mut cli,"cancel","42").unwrap();
    assert_eq!(cancelled["state"],"CANCELLED");
    assert_eq!(cli.wakes,1);
    let snapshot=cli.store.load_job("42").unwrap().unwrap();
    assert_eq!(snapshot["state"],"CANCELLED");
    assert!(dashboard_job_action(&mut cli,"cancel","42").is_err());
    assert_eq!(cli.store.load_job("42").unwrap().unwrap(),snapshot);
    assert_eq!(cli.wakes,1);
    drop(cli);
    std::fs::remove_dir_all(root).unwrap();
}
