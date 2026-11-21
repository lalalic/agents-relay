// Original Node src/planner.ts AgentObjectivePlanner public constructor +
// plan strategy. No actual codex invocation: the execution is injected, and
// the Node side uses a disposable command shim with equivalent stdout/exit.
use agents_relay_rust2::planner_adapters::{
    AgentObjectivePlanner,PlannerProcessResult,
};
use serde_json::{json,Value};
use std::path::Path;
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certPlannerAgentPublic"{return None;}
    Some((||{
        let context=&request["context"];
        let command=request["command"].as_str().unwrap_or("fake-planner");
        let agent_file=request["agentFile"].as_str().unwrap_or("");
        let root=Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent().ok_or("Rust source package root unavailable")?;
        let store=Path::new(request["storeDir"].as_str().unwrap_or(""));
        let planner=AgentObjectivePlanner::new(Some(command),Some(Path::new(agent_file)));
        let outcome=planner.plan(context,root,store,None,|actual,argv,_cwd|{
            if actual!=command{return Err("Planner ran wrong owned command".into());}
            if !argv.starts_with(&["exec".into(),"--json".into()])
                ||!argv.iter().any(|s|s=="--"){
                return Err("Planner owned process invocation missing CodeX argv contract".into());
            }
            Ok(PlannerProcessResult{
                exit_code:request["exitCode"].as_i64().unwrap_or(0) as i32,
                stdout:request["output"].as_str().unwrap_or("").into(),
                stderr:request["stderr"].as_str().unwrap_or("").into(),
            })
        });
        Ok(json!({"outcome":match outcome{
            Ok(value)=>json!({"ok":true,"value":value}),
            Err(error)=>json!({"ok":false,"error":error}),
        }}).to_string())
    })())
}
