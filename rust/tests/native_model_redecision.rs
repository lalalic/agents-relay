// Durable-effect ordering and negative gates for model re-decision. Usage is
// injected and no provider, Codex CLI, daemon or real Task is touched.
use agents_relay_rust2::{
 model_redecision::redecide_failed_task,
 usage::UsageSnapshotProvider,
};
use serde_json::{json,Value};
use std::{cell::RefCell,path::Path};
struct Usage(bool);
impl UsageSnapshotProvider for Usage{
 fn snapshot(&self)->Result<Value,String>{
  if self.0 {return Err("usage observation unavailable".into());}
  Ok(json!({"generatedAt":"2026-11-17T12:00:00.000Z",
   "providers":[],"credits":[]}))
 }
}
fn task()->Value{
 json!({"id":"71","jobId":"41","kind":"work","state":"FAILED",
  "input":"safe local fixture","attempt":1,"maxAttempts":3,
  "routing":{"provider":"z","model":"old","decisionId":"prior-1"}})
}
fn worker()->Value{
 json!({"workerId":"w1","adapter":"chatgpt","capabilities":["coding"]})
}
fn evidence(classification:&str)->Value{
 json!({"classification":classification,"summary":"provider unavailable",
  "sources":["task.events"]})
}
fn run<Update,Audit>(
 task:&Value,evidence:&Value,usage:&dyn UsageSnapshotProvider,
 with_audit:bool,update:Update,audit:Audit
)->Result<Value,String>
where
 Update:FnMut(&Value,&Value)->Result<(),String>,
 Audit:FnMut(&Value)->Result<(),String>
{
 redecide_failed_task(task,&worker(),&[],usage,evidence,
  Path::new("/tmp/no-rust2-model-config"),1_794_938_400_000,
  "/tmp/no-rust2-model-policy","/tmp/no-rust2-model-rules",
  Some("off"),None,None,with_audit,update,audit)
}
#[test]
fn non_provider_failures_cannot_trigger_model_change(){
 let original=task();
 let events=RefCell::new(Vec::new());
 let error=run(&original,&evidence("semantic_task"),&Usage(false),true,
  |_,_|{events.borrow_mut().push("update");Ok(())},
  |_|{events.borrow_mut().push("audit");Ok(())}).unwrap_err();
 assert_eq!(error,"Model re-decision requires model/provider/runtime evidence");
 assert!(events.borrow().is_empty());
 assert_eq!(original["state"],"FAILED");
}
#[test]
fn missing_usage_does_not_emit_audit_or_mutate_task(){
 let events=RefCell::new(Vec::new());
 assert_eq!(run(&task(),&evidence("model_provider_runtime"),&Usage(true),true,
  |_,_|{events.borrow_mut().push("update");Ok(())},
  |_|{events.borrow_mut().push("audit");Ok(())}).unwrap_err(),
  "usage observation unavailable");
 assert!(events.borrow().is_empty());
}
#[test]
fn approved_redecision_updates_route_but_never_attempt_or_lifecycle(){
 let old=task();
 let events=RefCell::new(Vec::new());
 let result=run(&old,&evidence("model_provider_runtime"),&Usage(false),true,
  |_,route|{
   events.borrow_mut().push("update");
   assert_eq!(route["provider"],"chatgpt");
   assert!(route["decisionId"].as_str().is_some());
   Ok(())
  },
  |record|{
   events.borrow_mut().push(if record["record_type"]=="decision"{
    "decision"
   }else{"outcome"});
   Ok(())
  }).unwrap();
 assert_eq!(result["candidate"]["provider"],"chatgpt");
 assert_eq!(result["audit"]["record_type"],"decision");
 assert_eq!(&*events.borrow(),&["decision","update","outcome"]);
 assert_eq!(old["state"],"FAILED");
 assert_eq!(old["attempt"],1);
 assert_eq!(old["routing"]["provider"],"z");
}
#[test]
fn audit_failure_prevents_unlogged_route_change(){
 let called=RefCell::new(false);
 let error=run(&task(),&evidence("model_provider_runtime"),&Usage(false),true,
  |_,_|{*called.borrow_mut()=true;Ok(())},
  |_|Err("decision audit persistence refused".into())).unwrap_err();
 assert_eq!(error,"decision audit persistence refused");
 assert!(!*called.borrow());
}
#[test]
fn failed_route_update_never_fabricates_outcome_receipt(){
 let logs=RefCell::new(Vec::new());
 let err=run(&task(),&evidence("model_provider_runtime"),&Usage(false),true,
  |_,_|Err("SQLite update refused".into()),
  |record|{
   logs.borrow_mut().push(record["record_type"].as_str().unwrap_or("").to_owned());
   Ok(())
  }).unwrap_err();
 assert_eq!(err,"SQLite update refused");
 assert_eq!(*logs.borrow(),vec!["decision"]);
}
