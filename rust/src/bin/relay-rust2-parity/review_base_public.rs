// ReconcilerReviewBase true Node/Rust caller-facing review Graph fixture.
use agents_relay_rust2::{
    reconciler_review_base::{ReconcilerReviewBase,ReviewBaseHost},
    reconciler_runtime_base::RuntimeBaseStore,
};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::{Arc,Mutex}};
struct Host{state:Mutex<Value>,writes:Mutex<usize>}
impl RuntimeBaseStore for Host{
    fn load_job(&self,_id:&str)->Result<Value,String>{
        Ok(self.state.lock().map_err(|e|e.to_string())?.clone())
    }
    fn mutate_job(&self,_id:&str,fn_mut:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        let mut current=self.state.lock().map_err(|e|e.to_string())?;
        let next=fn_mut(current.clone())?;
        if *current!=next{
            *self.writes.lock().map_err(|e|e.to_string())?+=1;
        }
        *current=next.clone();Ok(next)
    }
    fn reconcile(&self,_id:&str)->Result<Value,String>{self.load_job("41")}
}
impl ReviewBaseHost for Host{
    fn launch(&self,_job:&Value,_task:&Value)->Result<(),String>{Ok(())}
}
pub fn invoke(request:&Value)->Result<String,String>{
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let host=Arc::new(Host{state:Mutex::new(request["job"].clone()),
        writes:Mutex::new(0)});
    let graph=root.join("workflow");
    let runtime=ReconcilerReviewBase::new(&graph,root.join("temporary-test-only"),
        root.join(".test-profile"),root.join(".test-policy"),
        root.join(".test-rules"),vec![],json!({"owner":"relay"}),
        Arc::clone(&host));
    let head=request["head"].as_str();
    let operation=request["operation"].as_str().unwrap_or("invalidate");
    let mut reason=String::new();
    let outcome=match operation{
        "head"=>runtime.current_head_sha(&request["job"])
            .map(|value|json!({"head":value})),
        "invalidate"=>runtime.invalidate_stale_review("41",head)
            .map(|_snapshot|Value::Null),
        "ensure"=>runtime.ensure_final_review("41",head,None)
            .map(|_snapshot|Value::Null),
        "route"=>runtime.route_task_for_execution("41",
            request["taskId"].as_str().unwrap_or("t1")).map(|snapshot|{
                reason=json!({"events":snapshot.events.len()}).to_string();Value::Null
        }),
        "event"=>runtime.apply_review_event(&request["event"]).map(|snapshot|{
            reason=json!({"wake":snapshot.wake,"events":snapshot.events.len()}).to_string();Value::Null
        }),
        "launch"=>runtime.launch(&request["job"],&request["task"])
            .map(|()|Value::Null),
        _=>Err(format!("Unknown review operation {operation}"))
    };
    runtime.runtime.close()?;
    let value=json!({"outcome":match outcome{
        Ok(value)=>json!({"ok":true,"value":value}),
        Err(error)=>json!({"ok":false,"error":error})},
        "reason":reason,
        "job":host.state.lock().map_err(|e|e.to_string())?.clone(),
        "writes":*host.writes.lock().map_err(|e|e.to_string())?});
    Ok(value.to_string())
}
