// Node provenance: src/cli-support.ts. EventBus subscription ownership,
// Graph-selected Task wake observations and bounded cleanup. SQLite remains
// authoritative: an event publish never certifies Task success.
use crate::events::{event_for,MemoryEventBus,NatsEventBus,Wake};
use serde_json::{json,Value};
use std::{
    collections::BTreeMap,
    sync::{Arc,Mutex,atomic::{AtomicU64,Ordering}},
};

// src/cli-support.ts ServiceEventBus owns subscriptions, not lifecycle
// policy. Dropping a returned unsubscribe handle does not release the
// underlying slot; explicit unsubscribe or close does, exactly like Node.
pub trait ServiceEventBusPort:Send+Sync {
    fn publish(&self,event:&Value)->Result<(),String>;
    fn subscribe(&self,job_id:&str,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>;
    fn subscribe_all(&self,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>;
    fn close(&self)->Result<(),String>{Ok(())}
}
impl ServiceEventBusPort for MemoryEventBus {
    fn publish(&self,event:&Value)->Result<(),String>{self.publish(event)}
    fn subscribe(&self,job_id:&str,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        Ok(Box::new(self.subscribe(job_id,wake)))
    }
    fn subscribe_all(&self,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        Ok(Box::new(self.subscribe_all(wake)))
    }
}
impl ServiceEventBusPort for NatsEventBus {
    fn publish(&self,event:&Value)->Result<(),String>{self.publish(event)}
    fn subscribe(&self,job_id:&str,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        let subscription=self.subscribe(job_id,wake)?;
        Ok(Box::new(move ||subscription.unsubscribe()))
    }
    fn subscribe_all(&self,wake:Wake)
        ->Result<Box<dyn FnOnce()+Send>,String>{
        let subscription=self.subscribe_all(wake)?;
        Ok(Box::new(move ||subscription.unsubscribe()))
    }
    fn close(&self)->Result<(),String>{self.close()}
}
type SubscriptionTable=Arc<Mutex<BTreeMap<u64,Box<dyn FnOnce()+Send>>>>;
pub struct ServiceSubscription {id:u64,subscribers:SubscriptionTable}
impl ServiceSubscription {
    pub fn unsubscribe(self){
        if let Ok(mut table)=self.subscribers.lock(){
            if let Some(close)=table.remove(&self.id){close();}
        }
    }
}
pub struct ServiceEventBus<B:ServiceEventBusPort>{
    upstream:B,
    subscriptions:SubscriptionTable,
    counter:AtomicU64,
}
impl<B:ServiceEventBusPort> ServiceEventBus<B>{
    pub fn new(upstream:B)->Self{
        Self{upstream,subscriptions:Arc::new(Mutex::new(BTreeMap::new())),
            counter:AtomicU64::new(0)}
    }
    pub fn publish(&self,event:&Value)->Result<(),String>{
        self.upstream.publish(event)
    }
    fn track(&self,unsubscribe:Box<dyn FnOnce()+Send>)
        ->Result<ServiceSubscription,String>{
        let id=self.counter.fetch_add(1,Ordering::Relaxed)+1;
        self.subscriptions.lock().map_err(|e|e.to_string())?
            .insert(id,unsubscribe);
        Ok(ServiceSubscription{id,subscribers:Arc::clone(&self.subscriptions)})
    }
    pub fn subscribe(&self,job_id:&str,wake:Wake)
        ->Result<ServiceSubscription,String>{
        self.track(self.upstream.subscribe(job_id,wake)?)
    }
    pub fn subscribe_all(&self,wake:Wake)
        ->Result<ServiceSubscription,String>{
        self.track(self.upstream.subscribe_all(wake)?)
    }
    pub fn close(&self)->Result<(),String>{
        let mut removed=self.subscriptions.lock().map_err(|e|e.to_string())?;
        let pending=std::mem::take(&mut *removed);
        drop(removed);
        for (_,unsubscribe) in pending{unsubscribe();}
        self.upstream.close()
    }
}

// These are observations selected by the owning Graph Action. Publishing a
// wake (or delivery failure) never writes Job or Task terminal state.
fn event_data(job:&Value,reason:Option<&str>,extra:Option<&Value>)->Value{
    let mut data=serde_json::Map::new();
    for key in ["repository","prNumber"]{
        if let Some(value)=job.get(key){data.insert(key.into(),value.clone());}
    }
    if let Some(reason)=reason{data.insert("reason".into(),json!(reason));}
    if let Some(extra)=extra.and_then(Value::as_object){
        for (key,value) in extra{data.insert(key.clone(),value.clone());}
    }
    Value::Object(data)
}
fn publish_observation(
    bus:Option<&dyn ServiceEventBusPort>,job_id:&str,task_id:&str,
    kind:&str,status:&str,message:&str,data:Value,warning:&str,
){
    let Some(bus)=bus else{return;};
    let event=event_for(job_id,task_id,None,kind,status,message,
        Some("orchestrator"),Some(data),None);
    if let Err(error)=bus.publish(&event){
        eprintln!("warning: {warning} unavailable: {error}");
    }
}
pub fn publish_wake(
    bus:Option<&dyn ServiceEventBusPort>,job:&Value,task_id:&str,message:&str,
){
    publish_observation(bus,job["id"].as_str().unwrap_or(""),task_id,
        "job.wake","queued",message,event_data(job,None,None),"event wake");
}
pub fn publish_task_unblocked(
    bus:Option<&dyn ServiceEventBusPort>,job:&Value,task_id:&str,reason:&str,
){
    publish_observation(bus,job["id"].as_str().unwrap_or(""),task_id,
        "task.unblocked","unblocked",&format!("Task {task_id} unblocked: {reason}"),
        event_data(job,Some(reason),None),"unblock event");
}
pub fn publish_task_blocked(
    bus:Option<&dyn ServiceEventBusPort>,job:&Value,task_id:&str,
    reason:&str,extra:Option<&Value>,
){
    publish_observation(bus,job["id"].as_str().unwrap_or(""),task_id,
        "task.blocked","blocked",&format!("Task {task_id} blocked: {reason}"),
        event_data(job,Some(reason),extra),"block event");
}
pub fn publish_dependent_unblocked(
    bus:Option<&dyn ServiceEventBusPort>,targets:&[Value],reason:&str,
){
    for target in targets{
        let job=json!({"repository":target.get("repository"),
            "prNumber":target.get("prNumber")});
        let task_id=target["taskId"].as_str().unwrap_or("");
        publish_observation(bus,target["jobId"].as_str().unwrap_or(""),task_id,
            "task.unblocked","unblocked",&format!("Task {task_id} unblocked: {reason}"),
            event_data(&job,Some(reason),None),"dependent unblock event");
    }
}
pub fn request_managed_reconciliation(
    bus:Option<&dyn ServiceEventBusPort>,job:&Value,
)->Result<(),String>{
    let bus=bus.ok_or(
        "Managed local Job reconciliation requires a reachable NATS event bus (auto-detected when available, or explicit with --events nats)"
    )?;
    let job_id=job["id"].as_str().unwrap_or("");
    let event=event_for(job_id,"reconcile",None,"job.wake","queued",
        &format!("Reconcile requested for {job_id}"),Some("orchestrator"),
        Some(event_data(job,None,None)),None);
    bus.publish(&event).map_err(|error|
        format!("Unable to deliver managed reconciliation wake to agents-relayd: {error}"))
}
