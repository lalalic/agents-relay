// Original events.ts public API differential: subject-token/prefix
// validation, eventFor shape and the in-process MemoryEventBus fan-out
// semantics. NatsEventBus constructor/prefix validation is covered without
// any network connection.
use agents_relay_rust2::events::{
    event_for,subject_prefix,subject_token,MemoryEventBus,NatsEventBus,Wake,
};
use serde_json::{json,Value};
use std::sync::{Arc,Mutex};

fn clone_wake(sink:&Arc<Mutex<Vec<Value>>>)->Wake{
    let sink=Arc::clone(sink);
    Arc::new(move |event:&Value|{
        sink.lock().expect("sink").push(event.clone());
        Ok(())
    })
}
fn failing_wake(sink:&Arc<Mutex<Vec<Value>>>)->Wake{
    let sink=Arc::clone(sink);
    Arc::new(move |event:&Value|{
        sink.lock().expect("sink").push(event.clone());
        Err("handler exploded".into())
    })
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certEvents"{return None;}
    Some((||{
        match request["method"].as_str().unwrap_or(""){
            "subjectToken"=>match subject_token(request["value"].as_str().unwrap_or("")){
                Ok(value)=>Ok(json!({"ok":true,"value":value}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "subjectPrefix"=>match subject_prefix(request["value"].as_str().unwrap_or("")){
                Ok(value)=>Ok(json!({"ok":true,"value":value}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            "eventFor"=>{
                let request=request;
                let event=event_for(
                    request["jobId"].as_str().unwrap_or(""),
                    request["taskId"].as_str().unwrap_or(""),
                    request["parentTaskId"].as_str(),
                    request["type"].as_str().unwrap_or(""),
                    request["status"].as_str().unwrap_or(""),
                    request["message"].as_str().unwrap_or(""),
                    request["visibility"].as_str(),
                    request.get("data").map(|value|value.clone()),
                    request.get("source").map(|value|value.clone()),
                );
                Ok(json!({"ok":true,"event":event}).to_string())
            }
            "memoryBus"=>{
                // scenario: publish sequence over subscribe/subscribeAll with
                // optional unsubscribes and an optional failing handler.
                let sink=Arc::new(Mutex::new(Vec::<Value>::new()));
                let bus=MemoryEventBus::new();
                let mut unsubscribers:Vec<Box<dyn FnOnce()>>=Vec::new();
                for step in request["steps"].as_array().unwrap_or(&Vec::new()){
                    match step["kind"].as_str().unwrap_or(""){
                        "subscribe"=>unsubscribers.push(Box::new(
                            bus.subscribe(step["jobId"].as_str().unwrap_or(""),
                                clone_wake(&sink)))),
                        "subscribeAll"=>unsubscribers.push(Box::new(
                            bus.subscribe_all(clone_wake(&sink)))),
                        "subscribeFailing"=>unsubscribers.push(Box::new(
                            bus.subscribe(step["jobId"].as_str().unwrap_or(""),
                                failing_wake(&sink)))),
                        "unsubscribe"=>{
                            let index=step["index"].as_u64().unwrap_or(0) as usize;
                            if index<unsubscribers.len(){
                                let handle=unsubscribers.remove(index);
                                handle();
                            }
                        },
                        "publish"=>match bus.publish(&step["event"]){
                            Ok(())=>{}
                            Err(message)=>{
                                return Ok(json!({"ok":false,"error":message}).to_string());
                            }
                        },
                        other=>return Err(format!("unknown memoryBus step {other}")),
                    }
                }
                let received=std::mem::take(&mut *sink.lock().expect("sink"));
                Ok(json!({"ok":true,"received":received}).to_string())
            }
            "natsConfig"=>match NatsEventBus::new(
                request["url"].as_str(),request["prefix"].as_str()){
                Ok(_bus)=>Ok(json!({"ok":true,
                    "value":request["prefix"].as_str()
                        .unwrap_or("relay.events.job")}).to_string()),
                Err(message)=>Ok(json!({"ok":false,"error":message}).to_string()),
            },
            value=>Err(format!("Unknown events method {value}")),
        }
    })())
}
