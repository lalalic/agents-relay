// Original src/workflow-effect-failures.ts public APIs under the exact Graph.
// Adapter uses in-memory deterministic store saves and event captures only;
// production uses the same public Rust reducers in Reconciler::reconcile.
use agents_relay_rust2::{
    task_transitions::{transition_job_event,transition_task_event},
    workflow_effect_failures::{apply_job_effect_outcomes,apply_task_effect_outcomes,
        WorkflowEffectOutcome}
};
use serde_json::{json,Value};
use std::{cell::RefCell,rc::Rc,path::Path,task::{Context,Poll,Waker},future::Future};

pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certWorkflowEffectFailures"{return None;}
    Some(scenario(request).map(|result|result.to_string()))
}
fn scenario(request:&Value)->Result<Value,String>{
    let outcomes=request["outcomes"].as_array().ok_or("outcomes required")?
        .iter().map(|outcome|WorkflowEffectOutcome{
            effect:outcome["effect"].as_str().unwrap_or("").into(),
            key:outcome["key"].as_str().unwrap_or("").into(),
            status:outcome["status"].as_str().unwrap_or("").into(),
            error:outcome["error"].as_str().map(str::to_owned)
        }).collect::<Vec<_>>();
    let root=Path::new(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let saved=Rc::new(RefCell::new(Vec::<Value>::new()));
    let events=Rc::new(RefCell::new(Vec::<Value>::new()));
    let mut job=request["job"].clone();
    if request["method"]=="job"{
        {
            let saved=Rc::clone(&saved);
            let events=Rc::clone(&events);
            let fut=apply_job_effect_outcomes(&mut job,&outcomes,
                |mut value,event|{
                    let result=transition_job_event(&root,&mut value,&event,
                        &json!({}),"2026-11-19T00:00:00.000Z")
                        .map(|_|{saved.borrow_mut().push(value.clone());value});
                    std::future::ready(result)
                },
                |event|{
                    events.borrow_mut().push(event);
                    std::future::ready(Ok(()))
                });
            let mut fut=std::pin::pin!(fut);
            let mut ctx=Context::from_waker(Waker::noop());
            match fut.as_mut().poll(&mut ctx){
                Poll::Ready(result)=>result?,
                Poll::Pending=>return Err("Unexpected pending pure Job effect case".into())
            }
        }
        Ok(json!({"job":job,"saved":*saved.borrow(),"events":*events.borrow()}))
    }else if request["method"]=="task"{
        let mut task=request["task"].clone();
        {
            let saved=Rc::clone(&saved);
            let events=Rc::clone(&events);
            let fut=apply_task_effect_outcomes(&job,&mut task,&outcomes,
                |mut value,event|{
                    let result=transition_task_event(&root,&mut value,&event,
                        &json!({}),"2026-11-19T00:00:00.000Z")
                        .map(|_|{saved.borrow_mut().push(value.clone());value});
                    std::future::ready(result)
                },
                |event|{
                    events.borrow_mut().push(event);
                    std::future::ready(Ok(()))
                });
            let mut fut=std::pin::pin!(fut);
            let mut ctx=Context::from_waker(Waker::noop());
            match fut.as_mut().poll(&mut ctx){
                Poll::Ready(result)=>result?,
                Poll::Pending=>return Err("Unexpected pending pure Task effect case".into())
            }
        }
        Ok(json!({"task":task,"saved":*saved.borrow(),"events":*events.borrow()}))
    }else{Err("Unknown Workflow Effect Failure scenario".into())}
}
