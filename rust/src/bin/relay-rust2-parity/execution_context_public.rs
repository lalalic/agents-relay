// Public original Node execution-context.ts exports, resolved against real
// layered filesystem/Agent Markdown. No mock resolver, no nonlocal services.
use agents_relay_rust2::execution_context::{
    resolve_execution_context,resolve_agent_model_preference,
    resolve_agent_contract,agent_contract_prompt,execution_context_prompt,
};
use serde_json::{json,Value};
pub fn invoke(request:&Value)->Option<Result<String,String>>{
    if request["op"]!="certExecutionContext"{return None;}
    Some((||{
        let method=request["method"].as_str().ok_or("method required")?;
        let project=request["project"].as_str().ok_or("project required")?;
        let role=request["role"].as_str().unwrap_or("worker");
        let options=request.get("options").cloned().unwrap_or(json!({}));
        let agent=request["agentName"].as_str().unwrap_or("");
        let value=match method{
            "resolve"=>resolve_execution_context(project,role,&options)?,
            "preference"=>resolve_agent_model_preference(project,agent,&options)?
                .unwrap_or(Value::Null),
            "contract"|"agentPrompt"|"contextPrompt"=>{
                let context=resolve_execution_context(project,role,&options)?;
                match method{
                    "contract"=>resolve_agent_contract(&context,agent)?,
                    "agentPrompt"=>json!(agent_contract_prompt(&context,agent)?),
                    "contextPrompt"=>json!(execution_context_prompt(&context)),
                    _=>unreachable!()
                }
            },
            other=>return Err(format!("Unknown Execution Context public method {other}")),
        };
        Ok(value.to_string())
    })())
}
