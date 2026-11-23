// Canonical Coordinator Graph + SQLite lifecycle. Git fixtures are newly
// initialized in /tmp and never touch the canonical Relay source checkout.
use agents_relay_rust2::{
 cli_coordinator::run_coordinator_job_command,
 relay_store::SQLiteRelayStore,
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},process::Command};
fn graph()->&'static Path{
 Path::new(concat!(env!("CARGO_MANIFEST_DIR"),"/../workflow"))
}
struct Fixture{root:PathBuf,project:PathBuf,store:SQLiteRelayStore}
impl Fixture {
 fn new()->Self{
  let path=std::env::temp_dir().join(format!("rust2-coordinator-native-{}-{}",
   std::process::id(),
   std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
  fs::create_dir_all(&path).unwrap();
  let project=path.join("fixture-repository");fs::create_dir_all(&project).unwrap();
  let status=Command::new("git").args(["init","-q","--initial-branch=main"])
   .arg(&project).status().unwrap();
  assert!(status.success());
  let store=SQLiteRelayStore::open(Path::new(":memory:"),None).unwrap();
  let job=json!({"id":"41","title":"local fixture","repository":"fixture-repository",
   "projectRoot":project.to_string_lossy(),"state":"DRAFT",
   "updatedAt":"2026-11-17T12:00:00.000Z",
   "plans":[],"tasks":[{
    "id":"71","title":"Coordinator","jobId":"41","agentName":"coordinator",
    "kind":"work","state":"DRAFT","attempt":0,"maxAttempts":3,
    "dependencies":[],"agentGraph":"flowchart TD\nA[agent:developer]",
    "updatedAt":"2026-11-17T12:00:00.000Z"
   }]});
  store.save_job(&job).unwrap();
  Self{root:path,project,store}
 }
 fn job(&self)->Value{self.store.load_job("41").unwrap().unwrap()}
 fn args(&self)->Vec<String>{
  ["--task-id".into(),"71".into(),"--workspace-root".into(),
   self.root.to_string_lossy().into_owned()].to_vec()
 }
 fn run(&self,args:&[String])->Result<Option<Value>,String>{
  run_coordinator_job_command(graph(),args,"41",&self.store,&self.job(),
   None,None,None,None)
 }
}
impl Drop for Fixture{
 fn drop(&mut self){let _=fs::remove_dir_all(&self.root);}
}
#[test]
fn creates_one_canonical_graph_binding_and_preserves_it_across_retry(){
 let fixture=Fixture::new();
 let outcome=fixture.run(&fixture.args()).unwrap().unwrap();
 assert_eq!(outcome["scheduled"],true);
 assert_eq!(outcome["state"],"ACTIVE");
 let first=fixture.job();
 assert_eq!(first["state"],"ACTIVE");
 assert_eq!(first["tasks"][0]["state"],"QUEUED");
 assert_eq!(first["graphStartContext"]["projectRoot"],
  fs::canonicalize(&fixture.project).unwrap().to_string_lossy().as_ref());
 assert_eq!(first["graphStartContext"]["workspaceRoot"],
  fs::canonicalize(&fixture.root).unwrap().to_string_lossy().as_ref());
 assert_eq!(fixture.run(&fixture.args()).unwrap().unwrap()["state"],"ACTIVE");
 assert_eq!(fixture.job()["graphStartContext"],first["graphStartContext"]);
 let second=fixture.root.join("other-workspace");
 fs::create_dir(&second).unwrap();
 let mut changed=fixture.args();changed[3]=second.to_string_lossy().into_owned();
 assert!(fixture.run(&changed).unwrap_err()
  .contains("start context differs from original binding"));
 assert_eq!(fixture.job()["graphStartContext"],first["graphStartContext"]);
}
#[test]
fn rejects_removed_shortcut_modes_and_missing_task_without_sqlite_mutation(){
 let fixture=Fixture::new();let before=fixture.job();
 let args=["--shortcut-local".to_string()];
 assert_eq!(fixture.run(&args).unwrap_err(),
  "Legacy Shortcut runners and execution modes are removed");
 assert!(fixture.run(&["--task-id".into(),"99".into()]).unwrap_err()
  .contains("Task 99 not found"));
 assert_eq!(fixture.job(),before);
}
#[test]
fn foreground_requires_runner_before_any_durable_change(){
 let fixture=Fixture::new();let before=fixture.job();
 let mut args=fixture.args();args.push("--foreground".into());
 assert_eq!(fixture.run(&args).unwrap_err(),"Foreground runner not configured");
 assert_eq!(fixture.job(),before);
}
#[test]
fn terminal_foreground_uses_supplied_runner_without_rescheduling(){
 let fixture=Fixture::new();
 let mut terminal=fixture.job();terminal["state"]=json!("COMPLETED");
 fixture.store.save_job(&terminal).unwrap();
 let mut called=0;
 let mut run=|_:&SQLiteRelayStore,id:&str,task:&str| {
  assert_eq!((id,task),("41","71"));called+=1;Ok(())
 };
 let mut args=fixture.args();args.push("--foreground".into());
 let output=run_coordinator_job_command(
  graph(),&args,"41",&fixture.store,&fixture.job(),
  None,None,Some(&mut run),None).unwrap();
 assert_eq!(output,None);
 assert_eq!(called,1);
 assert_eq!(fixture.job()["state"],"COMPLETED");
}
