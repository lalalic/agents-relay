// Native Rust port regression for Node src/git-delivery.ts,
// src/cli-task-complete.ts and src/relayd-control.ts: real disposable Git,
// authoritative SQLite and canonical Task Graph; no user Job or live delivery.
use agents_relay_rust2::{
    relay_store::SQLiteRelayStore,relayd_control::{workspace_control,WorkspaceControlBackend},
    reconciler_runtime::ReconcilerRuntime,execution_event_identity::execution_event_source,
    events::event_for,cli::{run_cli,CliRuntimePort},
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf},process::Command};
fn run(root:&Path,args:&[&str])->String{
    let out=Command::new("git").arg("-C").arg(root).args(args).output().unwrap();
    assert!(out.status.success(),"git {:?}: {}",args,String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
struct Fixture{
    base:PathBuf,root:PathBuf,work:PathBuf,baseline:String,
}
impl Fixture{
    fn new()->Self{
        let base=std::env::temp_dir().join(format!("rust2-control-git-{}",format!("{}-{}",std::process::id(),std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos())));
        let root=base.join("root");let work=base.join("worker");
        fs::create_dir_all(&root).unwrap();
        run(&root,&["init","-b","main"]);
        run(&root,&["config","user.name","Rust2 Test"]);
        run(&root,&["config","user.email","test@example.invalid"]);
        fs::write(root.join("source.txt"),"baseline\n").unwrap();
        run(&root,&["add","."]);run(&root,&["commit","-m","baseline"]);
        let baseline=run(&root,&["rev-parse","HEAD"]);
        run(&root,&["worktree","add","-b","relay/test-1",work.to_str().unwrap(),"main"]);
        Self{base,root,work,baseline}
    }
    fn commit(&self,trailers:bool)->String{
        use std::io::Write;
        let mut file=fs::OpenOptions::new().append(true).open(self.work.join("source.txt")).unwrap();
        writeln!(file,"change").unwrap();
        run(&self.work,&["add","."]);
        if trailers{
            run(&self.work,&["commit","-m","source change","-m","Relay-Task: task-2","-m","Relay-Execution: ex-1"]);
        }else{run(&self.work,&["commit","-m","source change"]);}
        run(&self.work,&["rev-parse","HEAD"])
    }
    fn job(&self)->Value{
        json!({"id":"1","repository":"root","projectRoot":self.root,
          "state":"ACTIVE","title":"Test source", "createdAt":"2026-11-18T00:00:00.000Z",
          "updatedAt":"2026-11-18T00:00:00.000Z",
          "localMerge":{"sourceRef":"refs/heads/relay/test-1","targetRef":"refs/heads/main"},
          "tasks":[{"id":"task-2","jobId":"1","kind":"work","agentName":"implementation",
            "adapter":"script","output":{"kind":"task_pr"},"gitDeliveryRequired":true,
            "state":"RUNNING","executionId":"ex-1","attempt":1,"maxAttempts":3,
            "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z",
            "gitDeliveryBaseline":{"executionId":"ex-1","sha":self.baseline}}],"plans":[]})
    }
    fn request(&self,sha:&str)->Value{
        json!({"command":"task.complete","jobId":"1","taskId":"task-2","repository":"root",
            "executionId":"ex-1","commitSha":sha,"summary":"Verified source commit"})
    }
}
impl Drop for Fixture{fn drop(&mut self){let _=fs::remove_dir_all(&self.base);}}
struct Backend{
    db:SQLiteRelayStore,graph:PathBuf,base:PathBuf,wakes:Vec<String>,events:Vec<Value>,
    inject_file_race:bool,
    inject_job_race:bool,
    inject_generation_race:bool,
}
impl Backend{
    fn new(f:&Fixture)->Self{
        let db=SQLiteRelayStore::open(&f.base.join("state.sqlite"),None).unwrap();
        db.save_job(&f.job()).unwrap();
        Self{db,graph:Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("workflow"),
            base:f.base.clone(),wakes:vec![],events:vec![],inject_file_race:false,inject_job_race:false,inject_generation_race:false}
    }
}
impl WorkspaceControlBackend for Backend{
    fn graph_directory(&self)->&Path{&self.graph}
    fn store_directory(&self)->&Path{&self.base}
    fn repositories(&self)->Vec<String>{vec!["root".into()]}
    fn repository_path(&self,_:&str)->Option<String>{None}
    fn known_jobs(&mut self)->Result<Vec<Value>,String>{self.db.list_jobs()}
    fn load_job(&mut self,id:&str)->Result<Value,String>{self.db.load_job(id)?.ok_or("Missing job".into())}
    fn save_job(&mut self,job:&Value)->Result<Value,String>{self.db.save_job(job)?;Ok(job.clone())}
    fn create_job_if_absent(&mut self,_:&Value)->Result<Value,String>{unimplemented!()}
    fn mutate_job(&mut self,id:&str,reduce:&dyn Fn(&mut Value)->Result<(),String>)->Result<Value,String>{
        self.db.mutate_job(id,|mut job|{reduce(&mut job)?;Ok(job)})
    }
    fn append_task(&mut self,_:&str,_:&Value)->Result<Value,String>{unimplemented!()}
    fn save_agent(&mut self,_:&str,_:&Value)->Result<(),String>{unimplemented!()}
    fn list_agents(&mut self,_:&str)->Result<Vec<Value>,String>{unimplemented!()}
    fn wake(&mut self,_:&str,why:&str)->Result<(),String>{self.wakes.push(why.into());Ok(())}
    fn refresh_inventory(&mut self)->Result<(),String>{Ok(())}
    fn publish(&mut self,event:&Value)->Result<(),String>{self.events.push(event.clone());Ok(())}
    fn manual_plan(&mut self,_:&str,_:Option<&str>,_:bool)->Result<Value,String>{unimplemented!()}
    fn validate_dag_result(&mut self,job:&Value,task:&Value)->Result<Value,String>{
        let proof=agents_relay_rust2::dag_precompletion::validate_dag_precompletion(
            job,task,Path::new("/usr/bin/true"))?;
        if self.inject_file_race{
            let path=Path::new(task.pointer("/output/path").unwrap().as_str().unwrap());
            fs::write(path,r#"{"status":"COMPLETED","output":{"raced":true},"artifacts":[]}"#)
                .unwrap();
        }
        if self.inject_job_race || self.inject_generation_race{
            self.db.mutate_job("1",|mut fresh|{
                if self.inject_job_race{fresh["description"]=json!("concurrent model Job update");}
                if self.inject_generation_race{fresh["tasks"][0]["executionId"]=json!("replacement");}
                Ok(fresh)
            })?;
        }
        Ok(proof)
    }
    fn review_targeted(&mut self,_:&str,_:&Value)->Result<Value,String>{unimplemented!()}
    fn blocker_ensure(&mut self,_:&Value)->Result<Value,String>{unimplemented!()}
    fn blocker_resolve(&mut self,_:&str,_:&str)->Result<Value,String>{unimplemented!()}
    fn local_head(&mut self,_:&Value)->Result<String,String>{unimplemented!()}
    fn fail_interactive(&mut self,_:&str,_:&str,_:&str,_:&str)->Result<Value,String>{unimplemented!()}
}
#[test]
fn real_git_commit_cli_graph_and_sqlite_end_to_end_deny_forgery_and_replay(){
    let f=Fixture::new();let mut backend=Backend::new(&f);
    let event=event_for("1","task-2",None,"task.completed","succeeded","fake",Some("worker"),
        None,Some(json!({"id":execution_event_source("1","task-2","ex-1")})));
    let mut runtime=ReconcilerRuntime::new("fixture");
    let state=backend.db.load_job("1").unwrap().unwrap();
    assert!(!runtime.apply_event(&backend.graph,&state,&event,None).unwrap().applied,
        "untrusted Task terminal event cannot bypass absent Git receipt");
    let baseline=f.request(&f.baseline);
    assert!(workspace_control(&mut backend,&baseline).is_err());
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    let bad=f.commit(false);
    let error=workspace_control(&mut backend,&f.request(&bad)).unwrap_err();
    assert!(error.contains("trailers"),"{error}");
    assert!(backend.wakes.is_empty());
    let good=f.commit(true);
    let result=workspace_control(&mut backend,&f.request(&good)).unwrap();
    assert_eq!(result["accepted"],true);
    assert_eq!(result["task"]["state"],"SUCCEEDED");
    assert_eq!(result["task"]["result"]["summary"],"Verified source commit");
    let saved=backend.db.load_job("1").unwrap().unwrap();
    assert_eq!(saved["tasks"][0]["gitDelivery"]["commitSha"],good);
    assert!(saved["tasks"][0]["executionId"].is_null());
    assert_eq!(backend.wakes,["control.task.complete"]);
    assert_eq!(backend.events.len(),1);
    let duplicate=workspace_control(&mut backend,&f.request(&good)).unwrap();
    assert_eq!(duplicate["idempotent"],true);
    assert_eq!(backend.events.len(),1);
    assert_eq!(backend.wakes.len(),1);
    let mut fake=f.request(&good);fake["executionId"]=json!("other-execution");
    assert!(workspace_control(&mut backend,&fake).is_err());
}
#[test]
fn real_task_start_snapshots_exact_source_branch_baseline() {
    let f=Fixture::new();
    let mut job=f.job();
    job["tasks"][0]["state"]=json!("QUEUED");
    job["tasks"][0]["leaseOwner"]=json!("owned-worker");
    job["tasks"][0].as_object_mut().unwrap().remove("gitDeliveryBaseline");
    let event=event_for("1","task-2",None,"task.started","running","started",Some("worker"),
        None,Some(json!({"id":execution_event_source("1","task-2","ex-1")})));
    let graph=Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("workflow");
    let mut runtime=ReconcilerRuntime::new("start-test");
    let result=runtime.apply_event(&graph,&job,&event,None).unwrap();
    assert!(result.applied);
    let started=&result.job["tasks"][0];
    assert_eq!(started["state"],"RUNNING");
    assert_eq!(started["gitDeliveryBaseline"]["sha"],f.baseline);
    assert_eq!(started["gitDeliveryBaseline"]["executionId"],"ex-1");
    assert!(started["gitDelivery"].is_null());
}
struct CliCapture{request:Option<Value>}
impl CliRuntimePort for CliCapture{
    fn execute(&mut self,_:&str,_:&str,_:&[String])->Result<Value,String>{
        Err("unexpected auxiliary CLI transport".into())
    }
    fn load(&mut self,_:&str,_:&[String])->Result<Value,String>{
        panic!("task.complete CLI must not speculate about SQLite Job/Task state");
    }
    fn control(&mut self,_:&[String],request:&Value)->Result<Value,String>{
        self.request=Some(request.clone());
        Ok(json!({"accepted":true,"task":{"state":"SUCCEEDED"}}))
    }
}
#[test]
fn native_cli_task_complete_routes_exact_request_to_daemon_control_only(){
    let sha="b".repeat(40);
    let args=["task","complete","--id","1","--task-id","task-2",
        "--repo","root","--execution-id","ex-1","--commit-sha",&sha,
        "--summary","actual proof"].map(str::to_string);
    let mut capture=CliCapture{request:None};
    let result=run_cli(&mut capture,&args,None).unwrap();
    assert_eq!(result["accepted"],true);
    assert_eq!(capture.request.as_ref().unwrap(),&json!({
        "command":"task.complete","jobId":"1","taskId":"task-2",
        "repository":"root","executionId":"ex-1","commitSha":sha,
        "summary":"actual proof"}));
    let bad=["task","complete","--id","1"].map(str::to_string);
    let mut rejected=CliCapture{request:None};
    assert!(run_cli(&mut rejected,&bad,None).unwrap_err().contains("--execution-id"));
    assert!(rejected.request.is_none());
}
#[test]
fn dirty_worktree_rejects_without_sqlite_mutation(){
    let f=Fixture::new();let mut backend=Backend::new(&f);
    let sha=f.commit(true);
    fs::write(f.work.join("untracked.txt"),"unfinished").unwrap();
    let before=backend.db.load_job("1").unwrap().unwrap();
    let err=workspace_control(&mut backend,&f.request(&sha)).unwrap_err();
    assert!(err.contains("uncommitted or untracked"),"{err}");
    assert_eq!(backend.db.load_job("1").unwrap().unwrap(),before);
    assert!(backend.events.is_empty()&&backend.wakes.is_empty());
}
#[test]
fn dag_cli_precompletion_rejects_and_repairs_same_execution(){
    let f=Fixture::new();let mut backend=Backend::new(&f);
    let dir=f.root.join("runs/test/.dag-node-results");
    fs::create_dir_all(&dir).unwrap();
    let result=dir.join("dag-child.json");
    let media=f.root.join("runs/test/generated.mp4");
    let mut job=f.job();
    job["tasks"][0]=json!({
        "id":"task-2","jobId":"1","kind":"work","agentName":"editor",
        "adapter":"codex","dagNode":{"nodeId":"editor","parentTaskId":"coordinator","graphHash":"example"},
        "output":{"kind":"file","path":result},
        "state":"RUNNING","executionId":"ex-1","attempt":1,"maxAttempts":3,
        "executionHistory":[{"id":"ex-1","attempt":1}],
        "createdAt":"2026-11-18T00:00:00.000Z","updatedAt":"2026-11-18T00:00:00.000Z"
    });
    backend.db.save_job(&job).unwrap();
    // Native model ingress uses a scoped SQLite schema, unlike the legacy
    // unscoped Git-control fixture database above.
    let scoped_path=f.base.join("model-ingress.sqlite");
    let scoped=SQLiteRelayStore::open(&scoped_path,Some("1")).unwrap();
    scoped.save_job(&job).unwrap();
    drop(scoped);
    let direct=event_for("1","task-2",None,"task.completed","succeeded","bypass",
        Some("worker"),None,
        Some(json!({"id":execution_event_source("1","task-2","ex-1")})));
    let error=agents_relay_rust2::native_worker_event_ingress::apply_verified_worker_event(
        &scoped_path,&backend.graph,"1","task-2","ex-1",&direct)
        .unwrap_err();
    assert!(error.contains("DAG_COMPLETION_REQUIRES_TASK_COMPLETE"),"{error}");
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    let req=json!({"command":"task.complete","jobId":"1","taskId":"task-2",
        "repository":"root","executionId":"ex-1","commitSha":"",
        "summary":"Validated Editor result"});
    fs::write(&result,r#"{"status":"COMPLETED","artifacts":[]}"#).unwrap();
    let error=workspace_control(&mut backend,&req).unwrap_err();
    assert!(error.contains("output object"),"{error}");
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    assert!(backend.events.is_empty()&&backend.wakes.is_empty());
    fs::write(&result,serde_json::to_vec(&json!({
        "status":"COMPLETED","output":{},"artifacts":[media]
    })).unwrap()).unwrap();
    let error=workspace_control(&mut backend,&req).unwrap_err();
    assert!(error.contains("unavailable"),"{error}");
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    fs::write(&media,b"valid artifact").unwrap();
    backend.inject_file_race=true;
    let race=workspace_control(&mut backend,&req).unwrap_err();
    assert!(race.contains("DAG_PRECOMPLETION_STALE"),"{race}");
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["tasks"][0]["state"],"RUNNING");
    assert!(backend.events.is_empty());
    backend.inject_file_race=false;
    fs::write(&result,serde_json::to_vec(&json!({
        "status":"COMPLETED","output":{},"artifacts":[media]
    })).unwrap()).unwrap();
    backend.inject_generation_race=true;
    let stale=workspace_control(&mut backend,&req).unwrap_err();
    assert!(stale.contains("stale or non-running execution"),"{stale}");
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["tasks"][0]["executionId"],"replacement");
    assert!(backend.events.is_empty());
    backend.inject_generation_race=false;
    backend.db.mutate_job("1",|mut fresh|{
        fresh["tasks"][0]["executionId"]=json!("ex-1");
        Ok(fresh)
    }).unwrap();
    backend.inject_job_race=true;
    let completed=workspace_control(&mut backend,&req).unwrap();
    assert_eq!(backend.db.load_job("1").unwrap().unwrap()["description"],"concurrent model Job update");
    assert_eq!(completed["task"]["state"],"SUCCEEDED");
    assert_eq!(completed["task"]["result"]["data"]["validated_dag_result"],true);
    assert_eq!(backend.events.len(),1);
    assert_eq!(backend.wakes,["control.task.complete"]);
    assert_eq!(workspace_control(&mut backend,&req).unwrap()["idempotent"],true);
    assert_eq!(backend.events.len(),1);
    let mut stale=req.clone();stale["executionId"]=json!("other-execution");
    assert!(workspace_control(&mut backend,&stale).is_err());
    let mut mixed=req.clone();mixed["commitSha"]=json!("a".repeat(40));
    assert!(workspace_control(&mut backend,&mixed).is_err());
}
#[test]
fn dag_cli_accepts_omitted_commit_sha_and_delegates_to_daemon(){
    let args=["task","complete","--id","1","--task-id","task-2",
        "--repo","root","--execution-id","ex-1"].map(str::to_string);
    let mut capture=CliCapture{request:None};
    assert_eq!(run_cli(&mut capture,&args,None).unwrap()["accepted"],true);
    let request=capture.request.unwrap();
    assert_eq!(request["commitSha"],"");
    assert_eq!(request["summary"],"DAG Task task-2 validated output");
}
