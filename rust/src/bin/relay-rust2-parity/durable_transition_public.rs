// Original Node DurableTaskTransitionRuntime against native Graph policy,
// per-Task serializer, injected transactional Store and version fences.
use agents_relay_rust2::workflow::durable_transition::DurableTaskTransitionRuntime;
use serde_json::{json,Value};
use std::{cell::RefCell,rc::Rc,path::PathBuf,future::{ready,Future},
    pin::pin,task::{Context,Poll,Waker}};
fn drive<T>(future:impl Future<Output=T>)->T{
    let mut future=pin!(future);
    let mut context=Context::from_waker(Waker::noop());
    loop{if let Poll::Ready(output)=future.as_mut().poll(&mut context){
        return output;
    }}
}
pub fn invoke(request:&Value)->Result<Option<String>,String>{
    if request["op"]!="certDurableTransition"{return Ok(None);}
    let root=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let runtime=DurableTaskTransitionRuntime::new(root);
    let job=request.get("job").cloned().unwrap_or(json!({}));
    let snapshot=Rc::new(RefCell::new(job));
    let method=request["method"].as_str().unwrap_or("apply");
    let task_id=request["taskId"].as_str().unwrap_or("2").to_string();
    let job_id=request["jobId"].as_str().unwrap_or("17").to_string();
    let eligible=request["eligible"].as_bool().unwrap_or(true);
    let mutate=request["mutate"].as_bool().unwrap_or(true);
    let facts=request.get("facts").cloned().unwrap_or(json!({}));
    let state=Rc::clone(&snapshot);
    let read=move |_id:&str|{
        ready(Ok::<_,String>(state.borrow().clone()))
    };
    let state=Rc::clone(&snapshot);
    let fail=if method=="updateFact"{None}
        else{request["saveError"].as_str().map(str::to_string)};
    let write=move |_id:&str,task:&Value|{
        if let Some(error)=&fail{return ready(Err(error.clone()));}
        let mut job=state.borrow().clone();
        if let Some(current)=job["tasks"].as_array_mut().and_then(|tasks|
            tasks.iter_mut().find(|t|t.get("id")==task.get("id"))){
            *current=task.clone();
        }
        *state.borrow_mut()=job;
        ready(Ok::<_,String>(()))
    };
    let result=if method=="updateFact"{
        drive(runtime.update_fact(&job_id,&task_id,read,write,
            move|t|eligible && t["state"]==json!(request["requiredState"].as_str().unwrap_or("RUNNING")),
            move|task|{
                if mutate{task["result"]=json!({"status":"finished"});}
            }))
    }else{
        drive(runtime.apply(&job_id,&task_id,
            request["event"].as_str().unwrap_or("cancel"),
            read,write,move|_,_|eligible,move|_,_|facts.clone(),
            move|_job,task,decision|{
                if mutate && decision["accepted"]==true{
                    task["result"]=json!({"status":"finished"});
                }
                Ok(())
            }))
    };
    let result=match result {
        Ok(value)=>json!({"ok":true,"value":value,"saved":snapshot.borrow().clone()}),
        Err(error)=>json!({"ok":false,"error":error,"saved":snapshot.borrow().clone()})
    };
    Ok(Some(result.to_string()))
}
