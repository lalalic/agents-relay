// Original Reconciler Context public exports, invoked with real native Agent
// and project-context resolvers. No mock Graph or synthetic success response.
use agents_relay_rust2::{
    execution_context::{resolve_execution_context,resolve_agent_model_preference},
    reconciler_context::{agent_model_preference_for_job,resolve_task_context,resolve_planner_context},
};
use serde_json::{json,Value};
use std::future::Future;
use std::task::{Context,Poll,Waker};

fn poll_once<F:Future>(future:F)->Result<F::Output,String>{
    let mut fut=std::pin::pin!(future);
    let mut ctx=Context::from_waker(Waker::noop());
    match fut.as_mut().poll(&mut ctx){
        Poll::Ready(result)=>Ok(result),
        Poll::Pending=>Err("Production Reconciler context unexpectedly suspended".into())
    }
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certReconcilerContext"{return None;}
    Some((||{
        let project=request["project"].as_str().ok_or("project required")?;
        let options=request.get("options").cloned().unwrap_or(json!({}));
        let agents=request["agents"].as_array().cloned().unwrap_or_default();
        let adapters=request["adapters"].as_array().cloned().unwrap_or_default();
        let value=match request["method"].as_str().unwrap_or(""){
            "task"=>{
                let role=request["role"].as_str().unwrap_or("worker");
                poll_once(resolve_task_context(project,role,&options,&agents,&adapters,
                    |project,role,options|std::future::ready(
                        resolve_execution_context(&project,&role,&options))))??
            },
            "planner"=>poll_once(resolve_planner_context(
                project,&options,&agents,&adapters,
                |project,role,options|std::future::ready(
                    resolve_execution_context(&project,&role,&options))))??,
            "preference"=>{
                let name=request["agentName"].as_str();
                let preference_root=request["preferenceRoot"].as_str();
                let task=request.get("task");
                poll_once(agent_model_preference_for_job(
                    name,preference_root,task,|path,name|{
                        let opts=options.clone();
                        async move{resolve_agent_model_preference(&path,&name,&opts)}
                    }))?.unwrap_or(Value::Null)
            },
            other=>return Err(format!("Unknown Reconciler Context public method {other}")),
        };
        Ok(value.to_string())
    })())
}
