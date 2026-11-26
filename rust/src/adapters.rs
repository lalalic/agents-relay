// Head-to-head Phase1 port: src/adapters.ts
// Worker runtime adapters. The Task Graph and event stream own terminal state:
// a successful Codex exit or a WebHelm submission NEVER completes a Task.
use crate::{
    continuation::{run_delivery_owned_process, DeliveryProcessOptions},
    events::random_uuid,
    owned_process::OwnedProcessManager,
};
use serde_json::{json, Value};
use std::{path::Path, sync::atomic::AtomicBool};

fn field<'a>(v:&'a Value, key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
#[derive(Clone,Debug)]
pub struct WorkerExecution{
    pub id:String,
    pub summary:String,
    pub result:Value,
    pub thread_id:Option<String>,
    pub delivery_receipt:Option<Value>,
    pub process_exit:Option<Value>,
}
impl WorkerExecution{
    fn new(summary:&str,result:Value)->Self{
        Self{id:random_uuid(),summary:summary.into(),result,
            thread_id:None,delivery_receipt:None,process_exit:None}
    }
}
// Node LaunchFailure and StartAckTimeout are public error identities.
// Timeout is delegated to the original WorkerStartAck implementation, which
// independently verifies execution-scoped task.started evidence.
pub use crate::worker_start_ack::StartAckTimeout;
#[derive(Debug,Clone,PartialEq,Eq)]
pub struct LaunchFailure(pub String);
impl std::fmt::Display for LaunchFailure {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result{
        f.write_str(&self.0)
    }
}
impl std::error::Error for LaunchFailure{}
impl From<StartAckTimeout> for LaunchFailure {
    fn from(error:StartAckTimeout)->Self{Self(error.0)}
}
pub trait WorkerAdapter {
    fn name(&self)->&'static str;
    fn id(&self)->&str;
    fn capabilities(&self)->&'static [&'static str];
}
/// Byte-capped output tail mirroring the original appendTail helper: keep
/// the last `max_bytes` bytes and decode lossily (Node Buffer.toString
/// replaces invalid lead bytes the same way from_utf8_lossy does).
pub fn append_tail(current:&str,chunk:&str,max_bytes:usize)->String{
    let mut combined=String::with_capacity(current.len()+chunk.len());
    combined.push_str(current);
    combined.push_str(chunk);
    if combined.len()<=max_bytes{return combined;}
    let bytes=combined.into_bytes();
    String::from_utf8_lossy(&bytes[bytes.len()-max_bytes..]).into_owned()
}
pub fn build_codex_args(route:&Value,input:&str)->Result<Vec<String>,String>{
    let mut args=crate::codex_permissions::exec_args(true);
    args.extend(crate::native_codex_thread::codex_route_arguments(route)?);
    if !field(route,"cwd").is_empty(){
        args.extend(["-C".into(),field(route,"cwd").into()]);
    }
    args.extend(["--".into(),input.into()]);
    Ok(args)
}
pub fn parse_thread_started(line:&str)->Option<String>{
    let parsed:Value=serde_json::from_str(line).ok()?;
    (field(&parsed,"type")=="thread.started")
        .then(||field(&parsed,"thread_id").to_string())
        .filter(|v|!v.is_empty())
}
pub fn parse_codex_failure(line:&str)->Option<(String,u8)>{
    let parsed:Value=serde_json::from_str(line).ok()?;
    match field(&parsed,"type"){
        "turn.failed"=>parsed.pointer("/error/message").and_then(Value::as_str)
            .map(str::trim).filter(|s|!s.is_empty()).map(|s|(s.into(),2)),
        "error"=>parsed.get("message").and_then(Value::as_str)
            .map(str::trim).filter(|s|!s.is_empty()).map(|s|(s.into(),1)),
        _=>None,
    }
}
fn tail_utf8(raw:&str,max:usize)->String{
    if raw.len()<=max{return raw.into();}
    let mut offset=raw.len()-max;
    while !raw.is_char_boundary(offset){offset+=1;}
    raw[offset..].to_owned()
}
pub struct CodexAdapter{pub command:String}
impl Default for CodexAdapter{
    fn default()->Self{Self{command:"codex".into()}}
}
impl WorkerAdapter for CodexAdapter{
    fn name(&self)->&'static str{"codex"}
    fn id(&self)->&str{"codex"}
    fn capabilities(&self)->&'static [&'static str]{&["model","codex"]}
}
impl CodexAdapter{
    /// Phase1 source translation only: this method is dormant until the
    /// native adapter is explicitly wired and verified in Phase2.
    pub fn launch(&self,task:&Value,context:&Value,cancelled:&AtomicBool)
        ->Result<WorkerExecution,String>{
        let route=task.get("routing").filter(|v|!v.is_null())
            .ok_or_else(||format!("Task {} requires routing metadata before Codex launch",
                field(task,"id")))?;
        let cwd=route.get("cwd").and_then(Value::as_str)
            .or_else(||context.pointer("/executionContext/project/gitRoot")
                .and_then(Value::as_str))
            .or_else(||context.pointer("/executionContext/project/path")
                .and_then(Value::as_str));
        let mut copied=route.clone();
        if let Some(cwd)=cwd{copied["cwd"]=json!(cwd);}
        let args=build_codex_args(&copied,field(task,"input"))?;
        let references=args.iter().map(String::as_str).collect::<Vec<_>>();
        let mut manager=OwnedProcessManager::default();
        let execution=run_delivery_owned_process(
            &mut manager,&self.command,&references,cwd.map(Path::new),
            &format!("worker.codex:{}",field(task,"id")),
            DeliveryProcessOptions{timeout:None,
                cancelled:Some(cancelled),supervisor_path:None,environment:None})?;
        let mut thread=None;
        let mut failure:Option<(String,u8)>=None;
        for line in execution.stdout.lines(){
            if let Some(id)=parse_thread_started(line){thread=Some(id);}
            if let Some(found)=parse_codex_failure(line){
                if failure.as_ref().is_none_or(|(_,priority)|found.1>=*priority){
                    failure=Some(found);
                }
            }
        }
        let stderr=tail_utf8(&execution.stderr,16_384);
        if execution.code!=0 {
            return Err(failure.map(|(message,_)|message)
                .or_else(||(!stderr.trim().is_empty()).then(||stderr.trim().into()))
                .unwrap_or_else(||format!("Codex exited {}",execution.code)));
        }
        let mut result=WorkerExecution::new(
            "Codex runtime exited after task execution; terminal task state is event-owned",
            json!({"summary":
                "Codex runtime exited after task execution; terminal task state is event-owned"}));
        result.thread_id=thread;
        // Node's owned-process close handler records "leader-exit" for
        // clean completion as it closes the exact disposable process group.
        result.process_exit=Some(json!({"exitCode":execution.code,
            "signal":null,"stderr":stderr,"terminationReason":"leader-exit"}));
        Ok(result)
    }
}
