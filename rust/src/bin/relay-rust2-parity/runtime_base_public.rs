// Native ReconcilerRuntimeBase Graph/EventBus/SQLite ingress fixture bridge.
use agents_relay_rust2::{
    events::MemoryEventBus,
    reconciler_runtime_base::{ReconcilerRuntimeBase,RuntimeBaseStore},
};
use serde_json::{json,Value};
use std::{path::PathBuf,sync::{Arc,Mutex}};
#[derive(Default)]
struct Store{
    state:Mutex<Value>,
    calls:Mutex<Vec<Value>>,
}
impl Store{
    fn push(&self,value:Value)->Result<(),String>{
        self.calls.lock().map_err(|e|e.to_string())?.push(value);Ok(())
    }
}
impl RuntimeBaseStore for Store{
    fn load_job(&self,id:&str)->Result<Value,String>{
        self.push(json!(["load",id]))?;
        Ok(self.state.lock().map_err(|e|e.to_string())?.clone())
    }
    fn mutate_job(&self,id:&str,operation:&mut dyn FnMut(Value)->Result<Value,String>)
        ->Result<Value,String>{
        self.push(json!(["mutate",id]))?;
        let mut current=self.state.lock().map_err(|e|e.to_string())?;
        let next=operation(current.clone())?;
        *current=next.clone();
        Ok(next)
    }
    fn reconcile(&self,id:&str)->Result<Value,String>{
        self.push(json!(["reconcile",id]))?;
        Ok(self.state.lock().map_err(|e|e.to_string())?.clone())
    }
    fn emit(&self,event:&Value)->Result<(),String>{
        self.push(json!(["emit",event["type"]]))
    }
    fn report_transport_failure(&self,error:&str){
        let _=self.push(json!(["report",error]));
    }
}
pub fn invoke(request:&Value)->Result<String,String>{
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let store=Arc::new(Store{state:Mutex::new(request["job"].clone()),
        calls:Mutex::new(vec![])});
    let runtime=ReconcilerRuntimeBase::new(root.join("workflow"),"relay",15000,
        Arc::clone(&store) as Arc<dyn RuntimeBaseStore>);
    let bus=MemoryEventBus::new();
    let watch=request["watch"]==true;
    let unsubscribe=if watch{
        runtime.watch(Some(&bus),request["jobId"].as_str().unwrap_or("41"))
    }else{runtime.watch(None,request["jobId"].as_str().unwrap_or("41"))};
    let mut errors=vec![];
    let mut outcomes=vec![];
    for event in request["events"].as_array().into_iter().flatten(){
        let result=if request["directApply"]==true{
            runtime.apply_event(event).map(|effect|{
                let mut value=json!({"applied":effect.applied,
                    "reconcile":effect.reconcile,"reason":effect.reason});
                if effect.reconcile&&effect.reconcile_detached{
                    value["reconcileMode"]=json!("detached");
                }
                outcomes.push(value);
            })
        }else if watch{bus.publish(event)}else{runtime.handle_event(event.clone())};
        if let Err(error)=result{errors.push(error);}
    }
    runtime.idle();
    unsubscribe();
    if let Some(event)=request.get("afterUnsubscribe"){
        bus.publish(event)?;
    }
    runtime.idle();
    let mut direct:Option<Value>=None;
    if request["wake"]==true{
        direct=Some(runtime.wake(request["jobId"].as_str().unwrap_or("41"))?);
    }
    if request["reconcile"]==true{
        direct=Some(runtime.reconcile(request["jobId"].as_str().unwrap_or("41"))?);
    }
    if let Some(binding)=request.get("binding"){
        match runtime.bind_interactive_invocation(
            binding["jobId"].as_str().unwrap_or("41"),&binding["task"],
            binding["executionId"].as_str().unwrap_or("e1")){
            Ok(_)=>{},Err(error)=>errors.push(error),
        }
    }
    runtime.idle();
    let result=json!({"calls":store.calls.lock().map_err(|e|e.to_string())?.clone(),
        "job":store.state.lock().map_err(|e|e.to_string())?.clone(),
        "errors":errors,"direct":direct,"outcomes":outcomes});
    runtime.close()?;
    Ok(result.to_string())
}
