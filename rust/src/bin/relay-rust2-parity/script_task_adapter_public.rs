// Real ScriptTaskAdapter public launch contract. The test's deterministic
// invoker stands in for an Agent Shortcut; production still runs a separately
// owned JS process through native_script_execution and native_script_worker.
use agents_relay_rust2::{
    adapters::WorkerAdapter,
    script_task_adapter::{launch_script_task,ScriptTaskAdapter},
};
use serde_json::{json,Value};
use std::{fs,sync::atomic::AtomicBool,path::Path};

pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certScriptTaskAdapter"{return None;}
    Some((||{
        if request["method"]=="identity"{
            let adapter=ScriptTaskAdapter::new(json!({}),
                |_path:&Path,_value:&Value,_signal:&AtomicBool|Ok(Value::Null),
                |_event:&Value|Ok(()));
            return Ok(json!({"name":adapter.name(),"id":adapter.id(),
                "capabilities":adapter.capabilities()}).to_string());
        }
        let task=&request["task"];
        let context=&request["context"];
        let roots=&request["roots"];
        let cancelled=AtomicBool::new(false);
        let mut invoker_input=Value::Null;
        let mut script_path=Value::Null;
        let mut events=Vec::<Value>::new();
        let result=launch_script_task(task,context,roots,&cancelled,
            |script: &Path,input: &Value,_|{
                invoker_input=input.clone();
                script_path=json!(script.to_string_lossy().to_string());
                if request["scenario"]=="throw"{
                    Err("Fixture Script raised an exception".into())
                }else{Ok(request.get("scriptResult").cloned().unwrap_or(Value::Null))}
            },
            |event|{let mut event=event.clone();
                if let Some(map)=event.as_object_mut(){
                    map.remove("timestamp");map.remove("event_id");
                }
                events.push(event);Ok(())
            });
        let (ok,summary,error)=match result{
            Ok(launch)=>(true,Some(launch.summary),None),
            Err(error)=>(false,None,Some(error)),
        };
        let file=task.pointer("/output/path").and_then(Value::as_str)
            .filter(|p|Path::new(p).exists())
            .map(|p|fs::read_to_string(p).map_err(|e|e.to_string()))
            .transpose()?
            .map(|s|serde_json::from_str::<Value>(&s).map_err(|e|e.to_string()))
            .transpose()?;
        Ok(json!({"ok":ok,"summary":summary,"error":error,
            "invokerInput":invoker_input,"script":script_path,
            "events":events,"file":file}).to_string())
    })())
}
