// Original types.ts public runtime API differential: story-size timeout
// helpers, legacy lifecycle normalization and the canonical V2 transition
// assertions evaluated against the real workflow/ graphs (never a mock).
use agents_relay_rust2::types::{
    assert_job_lifecycle_transition,assert_task_transition,
    chatgpt_start_ack_timeout_ms,normalize_legacy_task_lifecycle,
    story_size_timeout_ms,task_overall_timeout_ms,StorySize,
};
use serde_json::{json,Value};
use std::path::Path;

fn story_size(raw:&Value)->Option<StorySize>{
    match raw.as_str(){
        Some("S")=>Some(StorySize::S),
        Some("M")=>Some(StorySize::M),
        Some("L")=>Some(StorySize::L),
        _=>None,
    }
}
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certTypes"{return None;}
    Some((||{
        let result=match request["method"].as_str().unwrap_or(""){
            "storySizeTimeout"=>match story_size(&request["size"]){
                Some(size)=>json!(story_size_timeout_ms(size)),
                // The original table lookup yields undefined off-contract.
                None=>Value::Null,
            },
            "taskOverallTimeout"=>match story_size(&request["size"]){
                Some(size)=>json!(task_overall_timeout_ms(size,
                    request["reasoning"].as_str())),
                None=>Value::Null,
            },
            "chatGptStartAckTimeout"=>{
                let ms=request["overallTimeoutMs"].as_u64()
                    .ok_or("overallTimeoutMs must be a non-negative integer")?;
                json!(chatgpt_start_ack_timeout_ms(ms))
            },
            "normalizeLegacyTaskLifecycle"=>{
                let mut task=request["task"].clone();
                normalize_legacy_task_lifecycle(&mut task);
                task
            },
            "assertJobLifecycleTransition"=>match assert_job_lifecycle_transition(
                Path::new(request["graphDir"].as_str().ok_or("graphDir required")?),
                request["from"].as_str().unwrap_or(""),
                request["to"].as_str().unwrap_or(""),
            ){
                Ok(())=>json!({"ok":true}),
                Err(message)=>json!({"ok":false,"error":message}),
            },
            "assertTaskTransition"=>match assert_task_transition(
                Path::new(request["graphDir"].as_str().ok_or("graphDir required")?),
                request["from"].as_str().unwrap_or(""),
                request["to"].as_str().unwrap_or(""),
            ){
                Ok(())=>json!({"ok":true}),
                Err(message)=>json!({"ok":false,"error":message}),
            },
            value=>return Err(format!("Unknown types public method {value}")),
        };
        Ok(result.to_string())
    })())
}
