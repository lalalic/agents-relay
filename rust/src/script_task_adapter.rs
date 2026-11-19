// Node provenance: src/script-task-adapter.ts. A Script Shortcut is
// another leased Task Worker. The trust boundary is the source-resolved
// .shortcut/*.agent.mjs path, not arbitrary worker-supplied argv.
use crate::{
    agent_script_discovery::discover_script_agent,
    events::{event_for,random_uuid},
    execution_event_identity::execution_event_source,
};
use serde_json::{json,Value};
use std::{
    collections::HashMap,fs,path::Path,
    sync::{Arc,atomic::{AtomicBool,Ordering}},
    time::Duration,
};

pub const SCRIPT_ADAPTER_NAME:&str="script";
pub const SCRIPT_ADAPTER_ID:&str="script";
pub const SCRIPT_ADAPTER_CAPABILITIES:[&str;1]=["script"];
fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn valid_script_result(value:&Value)->bool{
    field(value,"status")=="COMPLETED"
        && value.get("output").is_some_and(Value::is_object)
        && value.get("artifacts").is_some_and(|v|v.is_object()||v.is_array())
}
pub struct ScriptLaunch {
    pub id:String,
    pub source:String,
    pub summary:String,
    pub output_path:String,
    pub result:Value,
}
pub fn prepare_script_input(task:&Value)->Result<(Value,String,String),String>{
    let dag=task.get("dagNode").filter(|v|!v.is_null());
    if dag.is_some_and(|dag|field(dag,"executor")!="script")
        || field(task,"executionId").is_empty()
        || field(task,"jobId").is_empty()
        || field(task,"agentName").is_empty(){
        return Err("Script Adapter requires a leased Agent Task".into());
    }
    if task.pointer("/output/kind").and_then(Value::as_str)!=Some("file")
        || !Path::new(task.pointer("/output/path")
            .and_then(Value::as_str).unwrap_or("")).is_absolute(){
        return Err("Script Task requires absolute file output".into());
    }
    let output_path=task.pointer("/output/path")
        .and_then(Value::as_str).unwrap_or("").to_string();
    let input=field(task,"input");
    let mut parsed=serde_json::from_str::<Value>(input).unwrap_or(Value::Null);
    if let Some(dag)=dag{
        if !parsed.is_object()
            || field(&parsed,"source")!="relay-dag-task"
            || parsed.get("nodeId")!=dag.get("nodeId")
            || (parsed.get("taskId").is_some_and(|v|!v.is_null())
                && parsed.get("taskId")!=task.get("id")){
            return Err("Script Task is not bound to its declared DAG node".into());
        }
    }else{
        if !parsed.is_object(){parsed=json!({"taskInput":input});}
        parsed["source"]=json!("relay-agent-task");
        parsed["taskId"]=task.get("id").cloned().unwrap_or(Value::Null);
        parsed["outputPath"]=json!(output_path);
    }
    Ok((parsed,output_path,field(task,"executionId").into()))
}
/// Node ScriptTaskAdapter WorkerAdapter identity and effect facade. The
/// supplied invoker owns execution of the trusted Script module, while the
/// existing shared Task events and Graph remain the lifecycle authority.
pub struct ScriptTaskAdapter<Invoke,Emit>
where Invoke:FnMut(&Path,&Value,&AtomicBool)->Result<Value,String>,
      Emit:FnMut(&Value)->Result<(),String>,
{
    pub roots:Value,
    invoke:Invoke,
    emit:Emit,
}
impl<Invoke,Emit> ScriptTaskAdapter<Invoke,Emit>
where Invoke:FnMut(&Path,&Value,&AtomicBool)->Result<Value,String>,
      Emit:FnMut(&Value)->Result<(),String>,
{
    pub fn new(roots:Value,invoke:Invoke,emit:Emit)->Self{
        Self{roots,invoke,emit}
    }
    pub fn launch(&mut self,task:&Value,context:&Value,cancelled:&AtomicBool)
        ->Result<ScriptLaunch,String>{
        launch_script_task(task,context,&self.roots,cancelled,
            &mut self.invoke,&mut self.emit)
    }
}
impl<Invoke,Emit> crate::adapters::WorkerAdapter for ScriptTaskAdapter<Invoke,Emit>
where Invoke:FnMut(&Path,&Value,&AtomicBool)->Result<Value,String>,
      Emit:FnMut(&Value)->Result<(),String>,
{
    fn name(&self)->&'static str{SCRIPT_ADAPTER_NAME}
    fn id(&self)->&str{SCRIPT_ADAPTER_ID}
    fn capabilities(&self)->&'static [&'static str]{&SCRIPT_ADAPTER_CAPABILITIES}
}
/// Only freshly owned process groups may run Script-issued commands.
pub fn run_script_command(
    args:&[String],cwd:&Path,cancelled:Option<&AtomicBool>,
)->Result<Value,String>{
    if args.is_empty()||args.iter().any(|arg|arg.is_empty()){
        return Err("Script command requires an argv vector".into());
    }
    if !cwd.is_absolute(){return Err("Script command requires an absolute cwd".into());}
    let mut manager=crate::owned_process::OwnedProcessManager::default();
    let refs:Vec<&str>=args.iter().skip(1).map(String::as_str).collect();
    let response=crate::continuation::run_delivery_owned_process(
        &mut manager,&args[0],&refs,Some(cwd),"dag.script-command",
        crate::continuation::DeliveryProcessOptions{
            timeout:None,cancelled,supervisor_path:None,environment:None,
        }
    )?;
    Ok(json!({"stdout":response.stdout,"stderr":response.stderr,"code":response.code}))
}
fn source(task:&Value)->Value{
    let job=field(task,"jobId");
    let task_id=field(task,"id");
    let execution=field(task,"executionId");
    json!({"id":execution_event_source(job,task_id,execution),
        "agent":field(task,"agentName"),"component":"agents-relay"})
}
fn script_event(task:&Value,kind:&str,status:&str,message:&str,
    data:Value)->Value{
    event_for(field(task,"jobId"),field(task,"id"),
        task.get("parentTaskId").and_then(Value::as_str),
        kind,status,message,Some("orchestrator"),Some(data),
        Some(source(task)))
}
fn write_output(path:&Path,value:&Value)->Result<(),String>{
    let dir=path.parent().ok_or("Script output has no directory")?;
    fs::create_dir_all(dir).map_err(|e|e.to_string())?;
    #[cfg(unix)]{
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir,fs::Permissions::from_mode(0o700))
            .map_err(|e|e.to_string())?;
    }
    let mut encoded=serde_json::to_string_pretty(value)
        .map_err(|e|e.to_string())?;
    encoded.push('\n');
    fs::write(path,encoded).map_err(|e|e.to_string())
}
/// The caller-provided invoker runs the actual trusted .agent.mjs module
/// with `{input,signal,runCommand}`. Rust owns input/output/event validation;
/// a JS Agent is an explicit external Worker, not the Relay daemon itself.
pub fn launch_script_task<Invoke,Emit>(
    task:&Value,context:&Value,roots:&Value,
    cancelled:&AtomicBool,mut invoke:Invoke,mut emit:Emit,
)->Result<ScriptLaunch,String>
where
    Invoke:FnMut(&Path,&Value,&AtomicBool)->Result<Value,String>,
    Emit:FnMut(&Value)->Result<(),String>,
{
    // The original Node ScriptTaskAdapter only throws synchronously for an
    // invalid lease/absolute output. DAG input validation happens inside
    // its asynchronous Worker and emits one task.failed receipt. Preserve
    // that observable contract rather than silently dropping the event.
    let (mut input,output_path,execution_id)=match prepare_script_input(task){
        Ok(prepared)=>prepared,
        Err(error)=>{
            if error=="Script Task is not bound to its declared DAG node"{
                emit(&script_event(task,"task.failed","failed",&error,
                    json!({"reason":"script_execution_failed"})))?;
            }
            return Err(error);
        }
    };
    let agent=field(task,"agentName");
    let discovered=(||->Result<String,String>{
        let project_path=context.pointer("/executionContext/project/path")
            .and_then(Value::as_str)
            .or_else(||input.get("projectPath").and_then(Value::as_str))
            .ok_or("No trusted Script Project context")?;
        if !Path::new(project_path).is_absolute(){
            return Err("No trusted Script Project context".into());
        }
        discover_script_agent(agent,project_path,
            roots.get("workspaceRoot").and_then(Value::as_str),
            roots.get("globalRoot").and_then(Value::as_str))?
            .ok_or_else(||format!("Declared Agent Shortcut is unavailable: {agent}"))
    })();
    let script=match discovered{
        Ok(script)=>script,
        Err(error)=>{
            emit(&script_event(task,"task.failed","failed",&error,
                json!({"reason":"script_execution_failed"})))?;
            return Err(error);
        }
    };
    let script=Path::new(&script);
    let review=task.get("interactiveInvocation");
    if review.is_some_and(|review|review.get("decidedAt").is_some_and(|v|!v.is_null())
        && matches!(field(review,"status"),"approved"|"changes_requested")){
        let review=review.expect("verified review");
        input["reviewDecision"]=json!({
            "status":review.get("status"),"revision":review.get("revision"),
            "invocationId":review.get("invocationId"),
            "feedback":review.get("feedback"),"comments":review.get("comments")
        });
    }
    for (key,value) in [
        ("jobId",task.get("jobId")),
        ("taskId",task.get("id")),
        ("executionId",task.get("executionId")),
    ] {
        if let Some(value)=value {input[key]=value.clone();}
    }
    if cancelled.load(Ordering::Acquire){
        return Err("Script Task cancelled".into());
    }
    emit(&script_event(task,"task.started","running",
        "Script Worker started",json!({})))?;
    let result=invoke(script,&input,cancelled);
    let result=match result{
        Ok(result)=>result,
        Err(error)=>{
            if !cancelled.load(Ordering::Acquire){
                emit(&script_event(task,"task.failed","failed",&error,
                    json!({"reason":"script_execution_failed"})))?;
            }
            return Err(error);
        }
    };
    if cancelled.load(Ordering::Acquire){
        return Err("Script Task cancelled".into());
    }
    if field(&result,"status")=="WAITING_REVIEW"{
        return Ok(ScriptLaunch{id:random_uuid(),source:field(&source(task),"id").into(),
            summary:"Script Task waiting for authorized human review".into(),
            output_path,result});
    }
    if !valid_script_result(&result){
        let error="Script Worker did not return a completed artifact contract";
        emit(&script_event(task,"task.failed","failed",error,
            json!({"reason":"script_execution_failed"})))?;
        return Err(error.into());
    }
    write_output(Path::new(&output_path),&result)?;
    emit(&script_event(task,"task.completed","succeeded",
        "Script Worker completed",json!({
            "status":"COMPLETED","output":result.get("output"),
            "artifacts":result.get("artifacts")
        })))?;
    Ok(ScriptLaunch{id:random_uuid(),source:execution_event_source(
        field(task,"jobId"),field(task,"id"),&execution_id),
        summary:"Script Task completed".into(),output_path,result})
}
