// Native server-side Dashboard factory contract: globally allocated IDs and
// atomic SQLite mutateJob are shared with Relay, not a second Dashboard DB.
use agents_relay_rust2::{
    relayd_dashboard_actions::{create_dashboard_actions,DashboardActionPorts},
    relay_store::SQLiteRelayStore,
    job_task_id_sequence::allocate_entity_id,
};
use serde_json::{json,Value};
use std::{collections::HashSet,path::{Path,PathBuf},time::{SystemTime,UNIX_EPOCH}};
struct SqliteDashboard{
    store:SQLiteRelayStore,dir:PathBuf,graph:PathBuf,reconciled:Vec<String>,
}
impl DashboardActionPorts for SqliteDashboard{
    fn overviews(&mut self)->Result<Vec<Value>,String>{
        Ok(vec![json!({"job":self.load_job("41")?})])
    }
    fn require_local_binding(&mut self,id:&str)->Result<(),String>{
        self.load_job(id).map(|_|())
    }
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.store.load_job(id)?.ok_or("Job not present".into())
    }
    fn job_action(&mut self,_:&str,_:&str)->Result<Value,String>{
        Err("not involved in task creation".into())
    }
    fn job_set_state(&mut self,_:&str,_:&str)->Result<Value,String>{
        Err("not involved in task creation".into())
    }
    fn task_action(&mut self,_:&str,_:&str,_:&str)->Result<Value,String>{
        Err("not involved in task creation".into())
    }
    fn task_set_state(&mut self,_:&str,_:&str,_:&str)->Result<Value,String>{
        Err("not involved in task creation".into())
    }
    fn task_id(&mut self,_:&str,repository:&str,key:Option<&str>)->Result<String,String>{
        allocate_entity_id(&self.dir,repository,"task",key,&HashSet::new())
    }
    fn mutate_job(&mut self,id:&str,
        update:&mut dyn FnMut(Value)->Result<Value,String>)->Result<Value,String>{
        self.store.mutate_job(id,update)
    }
    fn append_task(&mut self,id:&str,task:&Value)->Result<(),String>{
        self.store.mutate_job(id,|mut job|{
            job.get_mut("tasks").and_then(Value::as_array_mut)
                .ok_or("Job missing Task list")?.push(task.clone());
            Ok(job)
        }).map(|_|())
    }
    fn save_job(&mut self,job:&Value)->Result<(),String>{
        self.store.save_job(job).map(|_|())
    }
    fn reconcile_local_job(&mut self,id:&str,reason:&str)->Result<(),String>{
        self.reconciled.push(format!("{id}:{reason}"));Ok(())
    }
    fn refresh_all(&mut self)->Result<(),String>{Ok(())}
    fn workflow_directory(&self)->&Path{&self.graph}
}
#[test]
fn sqlite_task_create_is_idempotent_and_failed_retry_does_not_mutate_job(){
    let suffix=SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
    let root=std::env::temp_dir().join(format!(
        "rust2-dashboard-sqlite-{}-{suffix}",std::process::id()));
    let dir=root.join("stores");std::fs::create_dir_all(&dir).unwrap();
    let store=SQLiteRelayStore::open(&root.join("relay.sqlite"),Some("41")).unwrap();
    let job=json!({"id":"41","title":"Fixture Job","repository":"example",
        "projectRoot":"/tmp/isolated","state":"ACTIVE", "prNumber":12,
        "createdAt":"2026-11-18T09:00:00.000Z",
        "updatedAt":"2026-11-18T09:00:00.000Z","tasks":[],"plans":[]});
    store.save_job(&job).unwrap();
    let mut dash=create_dashboard_actions(SqliteDashboard{
        store,dir,graph:PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow"),
        reconciled:vec![],
    });
    let task=json!({"id":"","jobId":"41","state":"DRAFT",
        "input":"fixture","output":{"kind":"file","path":"out.txt"},
        "adapter":"script","dependencies":[],"capabilities":[]});
    let first=dash.workspace_task_create("41",&task,Some("request-1")).unwrap();
    let second=dash.workspace_task_create("41",&task,Some("request-1")).unwrap();
    assert_eq!(first["createdTaskId"],second["createdTaskId"]);
    assert_eq!(second["tasks"].as_array().unwrap().len(),1);
    assert_eq!(dash.ports.reconciled,vec!["41:control.task.create"]);
    let mut changed=task.clone();changed["input"]=json!("changed content");
    assert!(dash.workspace_task_create("41",&changed,Some("request-1"))
        .unwrap_err().contains("different definition"));
    assert_eq!(dash.ports.load_job("41").unwrap(),second.as_object().map(|o|{
        let mut value=Value::Object(o.clone());
        value.as_object_mut().unwrap().remove("createdTaskId");value
    }).unwrap());
    let mut injected=task.clone();injected["id"]=json!("manual");
    assert_eq!(dash.workspace_task_create("41",&injected,None).unwrap_err(),
        "Task IDs are allocated by Relay and cannot be supplied");
    drop(dash);
    std::fs::remove_dir_all(root).unwrap();
}
