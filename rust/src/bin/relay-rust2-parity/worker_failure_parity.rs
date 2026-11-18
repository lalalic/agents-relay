use agents_relay_rust2::{
    worker_failure_recovery::{handle_worker_launch_failure,apply_launch_failure_mutation,
        FailureAdmission},
    worker_failure_orchestration::{WorkerFailurePorts,LiveWorkerState},
};
use serde_json::{json,Value};
use std::collections::HashSet;
struct Fixture{
    job:Value,config:Value,calls:Vec<Value>,events:Vec<Value>,
    claimed:HashSet<String>,live:Option<LiveWorkerState>,
}
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
impl WorkerFailurePorts for Fixture{
    fn load_job(&mut self,_:&str)->Result<Value,String>{
        self.calls.push(json!("load"));Ok(self.job.clone())
    }
    fn list_agents(&mut self)->Result<Vec<Value>,String>{
        self.calls.push(json!("listAgents"));Ok(vec![])
    }
    fn usage_snapshot(&mut self)->Result<Option<Value>,String>{Ok(None)}
    fn has_safe_alternative(&mut self,_:Option<&Value>,_:&[Value],_:Option<&Value>)
        ->Result<bool,String>{Ok(false)}
    fn has_codex_no_start_fallback(&mut self,_:&Value,_:&[Value],_:Option<&Value>)
        ->Result<bool,String>{Ok(false)}
    fn live_worker(&mut self,_:&str)->Option<LiveWorkerState>{self.live.clone()}
    fn claim_failure(&mut self,id:&str)->bool{self.claimed.insert(id.into())}
    fn apply_transition(&mut self,_:&str,task_id:&str,execution_id:Option<&str>,
        proposal:&FailureAdmission)->Result<Option<Value>,String>{
        self.calls.push(json!(format!("transition:{}",proposal.event)));
        let task=self.job["tasks"].as_array().into_iter().flatten()
            .find(|task|field(task,"id")==task_id);
        let Some(task)=task else{return Ok(None)};
        if task.get("executionId").and_then(Value::as_str)!=execution_id{
            return Ok(None);
        }
        if self.config["noTransition"]==true{return Ok(None);}
        let from=field(task,"state").to_string();
        let mut updated=task.clone();
        let decision=if self.config["accepted"]==false{
            json!({"accepted":false,"target":null,"reason":"no_transition"})
        }else{
            json!({"accepted":true,"target":self.config["target"],"reason":"accepted"})
        };
        self.calls.push(json!({"facts":proposal.facts}));
        if decision["accepted"]==true{
            updated["state"]=decision["target"].clone();
            apply_launch_failure_mutation(&mut updated,Some(task),proposal,&decision);
        }
        Ok(Some(json!({"from":from,"task":updated,"decision":decision})))
    }
    fn record_route_outcome(&mut self,_:&Value,_:&str,_:&str,_:Option<&str>,_:bool){}
    fn cancel_and_clear(&mut self,task_id:&str,execution_id:&str)->Result<(),String>{
        self.calls.push(json!("abort"));self.calls.push(json!("cancel"));
        self.calls.push(json!(format!("clearExecution:{task_id}:{execution_id}")));
        self.live=None;
        Ok(())
    }
    fn clear_terminal_waiter(&mut self,task_id:&str,execution_id:&str){
        self.calls.push(json!(format!("clearTerminalWaiter:{task_id}:{execution_id}")));
    }
    fn emit(&mut self,event:&Value)->Result<(),String>{
        self.calls.push(json!("emit"));self.events.push(event.clone());Ok(())
    }
    fn emit_detached(&mut self,event:&Value,job_id:&str,task_id:&str,context:&str){
        self.calls.push(json!("emit"));self.events.push(event.clone());
        self.calls.push(json!(format!("detach:{job_id}:{task_id}:{context}")));
    }
    fn wake(&mut self,job_id:&str,task_id:&str,reason:&str){
        self.calls.push(json!(format!("wake:{job_id}:{task_id}:{reason}")));
    }
}
pub(super) fn invoke(request:&Value)->Result<Option<String>,String>{
    if request["op"]!="workerFailureParity"{return Ok(None)}
    let job=request["job"].clone();
    let live=request["live"].as_object().map(|value|LiveWorkerState{
        execution_id:value.get("executionId").and_then(Value::as_str)
            .unwrap_or("").to_string(),
        worker_started:value.get("workerStarted")==Some(&Value::Bool(true)),
    });
    let mut f=Fixture{job,config:request.clone(),calls:vec![],events:vec![],
        claimed:HashSet::new(),live};
    let id=field(request,"jobId").to_string();
    let task=field(request,"taskId").to_string();
    let exec=request["executionId"].as_str();
    let failures=request["repeat"].as_u64().unwrap_or(1).min(4);
    let mut outcomes=Vec::new();
    for _ in 0..failures{
        outcomes.push(match handle_worker_launch_failure(&mut f,&id,&task,exec,
            &request["failure"],field(request,"phase")){
            Ok(())=>json!({"ok":true}),
            Err(error)=>json!({"ok":false,"error":error}),
        });
    }
    Ok(Some(json!({"outcomes":outcomes,"calls":f.calls,
        "events":f.events,"claims":f.claimed.len()}).to_string()))
}
