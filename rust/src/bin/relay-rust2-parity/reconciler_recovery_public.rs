// Real recovery selection and canonical Graph mutation, side effects isolated.
use agents_relay_rust2::{
    reconciler::Reconciler,
    task_transitions::transition_task_event,
};
use serde_json::{json,Value};
use std::{cell::RefCell,rc::Rc,path::PathBuf,future::Future,pin::pin,
    task::{Context,Poll,Waker}};
fn run<T>(future:impl Future<Output=T>)->T{
    let mut future=pin!(future);
    let mut cx=Context::from_waker(Waker::noop());
    match future.as_mut().poll(&mut cx){
        Poll::Ready(result)=>result,
        Poll::Pending=>panic!("Fixture recovery must be immediate"),
    }
}
pub fn plan(request:&Value)->Result<String,String>{
    let root=PathBuf::from(request["root"].as_str().unwrap_or("."));
    let mut rec=Reconciler::new(root.join("workflow"),root.join("temporary-store"),
        root.join(".test-profile"),root.join(".test-policy"),
        root.join(".test-rules"),json!({"owner":"fixture",
            "plannerTimeoutMs":request["timeoutMs"].as_u64().unwrap_or(120000)}));
    let current=Rc::new(RefCell::new(request["job"].clone()));
    let calls=Rc::new(RefCell::new(Vec::<Value>::new()));
    let load_data=Rc::clone(&current);
    let load_calls=Rc::clone(&calls);
    let commit_data=Rc::clone(&current);
    let commit_calls=Rc::clone(&calls);
    let append_data=Rc::clone(&current);
    let append_calls=Rc::clone(&calls);
    let save_data=Rc::clone(&current);
    let save_calls=Rc::clone(&calls);
    let launch_data=Rc::clone(&current);
    let launch_calls=Rc::clone(&calls);
    let error=request["launchError"].as_str().map(str::to_owned);
    let atomic=request["atomic"]!=false;
    let guidance=request["guidance"].as_str();
    let forced=request["forceRestate"]==true;
    let result=run(rec.plan_job("41",guidance,forced,atomic,
        move||{
            load_calls.borrow_mut().push(json!(["load"]));
            std::future::ready(Ok::<_,String>(load_data.borrow().clone()))
        },
        move|callback|{
            commit_calls.borrow_mut().push(json!(["mutate"]));
            let prior=commit_data.borrow().clone();
            let candidate=callback(prior)?;
            *commit_data.borrow_mut()=candidate.clone();
            Ok::<_,String>(candidate)
        },
        move|plan|{
            append_calls.borrow_mut().push(json!(["appendPlan",plan["id"]]));
            let mut durable=append_data.borrow_mut();
            let rounds=durable.get_mut("plans").and_then(Value::as_array_mut)
                .ok_or::<String>("Store Job has no Plans array".into());
            std::future::ready(match rounds {
                Ok(rounds)=>{rounds.push(plan);Ok(())},
                Err(error)=>Err(error),
            })
        },
        move|job|{
            save_calls.borrow_mut().push(json!(["saveJob"]));
            *save_data.borrow_mut()=job;
            std::future::ready(Ok::<_,String>(()))
        },
        move|_job,round|{
            let settled=(||{
                launch_calls.borrow_mut().push(json!(["launch",round["id"]]));
                if let Some(message)=&error{return Err::<(),String>(message.clone());}
                let mut durable=launch_data.borrow_mut();
                if let Some(rounds)=durable["plans"].as_array_mut(){
                    if let Some(item)=rounds.iter_mut().find(|p|p["id"]==round["id"]){
                        item["status"]=json!("SUCCEEDED");
                        item["assessment"]=json!("Planner fixture receipt accepted");
                    }
                }
                Ok(())
            })();
            std::future::ready(settled)
        }
    ));
    let final_job=current.borrow().clone();
    let calls=calls.borrow().clone();
    Ok(json!({"outcome":match result{
        Ok((job,round))=>json!({"ok":true,"value":{"job":job,"round":round}}),
        Err(error)=>json!({"ok":false,"error":error})},
        "job":final_job,"calls":calls}).to_string())
}
