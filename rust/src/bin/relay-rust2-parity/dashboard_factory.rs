use agents_relay_rust2::relayd_dashboard_actions::{
    create_dashboard_actions,DashboardActionPorts,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},collections::HashSet};
struct Fixture{
    overviews:Vec<Value>,job:Value,calls:Vec<String>,
    store_directory:PathBuf,can_mutate:bool,
}
impl Fixture{
    fn call(&mut self,entry:impl Into<String>){self.calls.push(entry.into());}
}
impl DashboardActionPorts for Fixture{
    fn overviews(&mut self)->Result<Vec<Value>,String>{
        self.call("getOverviews");Ok(self.overviews.clone())
    }
    fn require_local_binding(&mut self,id:&str)->Result<(),String>{
        self.call(format!("requireLocalJobBinding:{id}"));Ok(())
    }
    fn load_job(&mut self,id:&str)->Result<Value,String>{
        self.call(format!("store.load:{id}"));Ok(self.job.clone())
    }
    fn job_action(&mut self,id:&str,action:&str)->Result<Value,String>{
        self.call("makeReconciler");
        self.call(format!("dashboardJobActionFactory:{action}"));
        self.call(format!("dashboardJobAction:{action}:{id}"));
        Ok(json!({"jobId":id,"action":action}))
    }
    fn job_set_state(&mut self,id:&str,state:&str)->Result<Value,String>{
        self.call("dashboardJobSetStateFactory");
        self.call(format!("dashboardJobSetState:{id}:{state}"));
        Ok(json!({"jobId":id,"state":state}))
    }
    fn task_action(&mut self,id:&str,task_id:&str,action:&str)->Result<Value,String>{
        self.call("makeReconciler");
        self.call(format!("dashboardTaskActionFactory:{action}"));
        self.call(format!("dashboardTaskAction:{action}:{id}:{task_id}"));
        Ok(json!({"jobId":id,"taskId":task_id,"action":action}))
    }
    fn task_set_state(&mut self,id:&str,task_id:&str,state:&str)->Result<Value,String>{
        self.call("dashboardTaskSetStateFactory");
        self.call(format!("dashboardTaskSetState:{id}:{task_id}:{state}"));
        Ok(json!({"jobId":id,"taskId":task_id,"state":state}))
    }
    fn task_id(&mut self,_id:&str,repository:&str,key:Option<&str>)->Result<String,String>{
        agents_relay_rust2::job_task_id_sequence::allocate_entity_id(
            &self.store_directory,repository,"task",key,&HashSet::new())
    }
    fn mutate_job(&mut self,id:&str,update:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        self.call(format!("store.mutateJob:{id}"));
        let result=update(self.job.clone())?;
        self.job=result.clone();
        Ok(result)
    }
    fn save_job(&mut self,job:&Value)->Result<(),String>{
        self.call("store.saveJob");self.job=job.clone();Ok(())
    }
    fn apply_job_activate(&mut self,job:&mut Value)->Result<(),String>{
        self.call("applyJobActivateAction");job["state"]=json!("ACTIVE");Ok(())
    }
    fn supports_mutate_job(&self)->bool{self.can_mutate}
    fn append_task(&mut self,id:&str,task:&Value)->Result<(),String>{
        self.call(format!("store.appendTask:{id}:{}",task["id"]));
        self.job.get_mut("tasks").and_then(Value::as_array_mut)
            .ok_or("Fixture Job tasks missing")?.push(task.clone());
        Ok(())
    }
    fn reconcile_local_job(&mut self,id:&str,reason:&str)->Result<(),String>{
        self.call(format!("pool.reconcileLocalJob:{id}:{reason}"));Ok(())
    }
    fn refresh_all(&mut self)->Result<(),String>{self.call("refreshAll");Ok(())}
    fn workflow_directory(&self)->&Path{Path::new("workflow")}
}
pub(super) fn invoke(request:&Value)->Result<Option<String>,String>{
    if request["op"]!="dashboardFactoryParity"{return Ok(None);}
    let method=request["method"].as_str().unwrap_or("");
    let job_id=request["jobId"].as_str().unwrap_or("");
    let task_id=request["taskId"].as_str().unwrap_or("");
    let action=request["action"].as_str().unwrap_or("");
    let state=request["state"].as_str().unwrap_or("");
    let target=request.get("target").filter(|v|!v.is_null());
    let mut dashboard=create_dashboard_actions(Fixture{
        overviews:request["overviews"].as_array().cloned().unwrap_or_default(),
        job:request["job"].clone(),calls:vec![],
        store_directory:PathBuf::from(request["storeDirectory"].as_str()
            .unwrap_or("/tmp/rust2-dashboard-factory-disabled")),
        can_mutate:request["canMutate"]!=false,
    });
    let result=match method{
        "dashboardOverview"=>dashboard.dashboard_overview(job_id,target)
            .map(|option|option.unwrap_or(Value::Null)),
        "workspaceJobAction"=>dashboard.workspace_job_action(job_id,action),
        "workspaceJobSetState"=>dashboard.workspace_job_set_state(job_id,state,target),
        "workspaceTaskAction"=>dashboard.workspace_task_action(job_id,task_id,action),
        "workspaceTaskSetState"=>dashboard.workspace_task_set_state(job_id,task_id,state,target),
        "workspaceTaskCreate"=>dashboard.workspace_task_create(job_id,
            &request["providedTask"],request["idempotencyKey"].as_str()),
        _=>Err("Unknown dashboard factory method".into()),
    };
    let outcome=match result{
        Ok(value)=>json!({"ok":true,"value":value}),
        Err(error)=>json!({"ok":false,"error":error}),
    };
    Ok(Some(json!({"outcome":outcome,"calls":dashboard.ports.calls}).to_string()))
}
