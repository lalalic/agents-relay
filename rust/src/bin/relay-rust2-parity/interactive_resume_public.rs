// Original interactive-resume.ts public API differential: the atomic
// identity-fenced resume mutation and restart-safe recovery over the real
// canonical Task lifecycle Graph and the real interactive-invocation Graph.
use agents_relay_rust2::interactive_resume::{
    recover_interactive_decisions,recoverable_interactive_decisions,
    resume_interactive_task,
};
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use agents_relay_rust2::task_transitions::try_transition_task_event;
use serde_json::{json,Value};
use std::path::Path;

pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certInteractiveResume"{return None;}
    Some((||{
        let graph_dir=Path::new(request["graphDir"].as_str()
            .ok_or("graphDir required")?);
        let job_id=request["jobId"].as_str().unwrap_or("17");
        match request["method"].as_str().unwrap_or(""){
            "resume"=>{
                let (next,resumed)=resume_interactive_task(
                    &request["job"],request["taskId"].as_str().unwrap_or(""),
                    request["invocationId"].as_str().unwrap_or(""),
                    request["revision"].as_str().unwrap_or(""),
                    request["decision"].as_str().unwrap_or(""),
                    |task,event|match try_transition_task_event(
                        graph_dir,task,event,&json!({}),&iso_now()){
                        Ok(decision)=>decision.get("accepted")==Some(&Value::Bool(true)),
                        Err(_error)=>false,
                    },
                )?;
                Ok(json!({"job":next,"resumed":resumed}).to_string())
            },
            "recoverable"=>Ok(json!(recoverable_interactive_decisions(
                &request["job"])).to_string()),
            "recover"=>{
                let store_dir=Path::new(request["storeDir"].as_str()
                    .ok_or("storeDir required")?);
                let store=SQLiteRelayStore::open(store_dir,Some(job_id))
                    .map_err(|error|error.to_string())?;
                // Seed the isolated store with the requested Job snapshot.
                store.save_job(&request["job"]).map_err(|error|error.to_string())?;
                let recovered=recover_interactive_decisions(
                    graph_dir,&store,job_id)?;
                let final_job=store.load_job(job_id)
                    .map_err(|error|error.to_string())?
                    .ok_or("job vanished from isolated store")?;
                Ok(json!({"recovered":recovered,"job":final_job}).to_string())
            },
            value=>Err(format!("Unknown interactive-resume method {value}")),
        }
    })())
}
fn iso_now()->String{
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis,true)
}
