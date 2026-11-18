// Node provenance: src/z-adapter.ts. Z worker execution-source identity,
// bounded task brief and short-lived credential Bootstrap. WebHelm's runner
// stays with the native browser Worker adapter, not the Dashboard client.
use regex::Regex;
use serde_json::{json,Value};

pub const Z_ADAPTER_ID:&str="z/webhelm";
pub const Z_CAPABILITIES:[&str;6]=[
    "model","z","webhelm","coding","filesystem","mcp"
];
fn captures(text:&str,pattern:&str)->Vec<String>{
    let regex=Regex::new(pattern).expect("fixed Z worker prompt regex");
    regex.captures_iter(text)
        .filter_map(|capture|capture.get(1).map(|group|group.as_str().into())).collect()
}
pub fn z_execution_source(prompt:&str)->Result<String,String>{
    let explicit=captures(prompt,
        r"(?m)^Execution source: (job/[^\s/]+/task/[^\s/]+/execution/[0-9a-f-]{36})$");
    if explicit.len()==1{return Ok(explicit[0].clone());}
    if explicit.len()>1{
        return Err("Z worker prompt contains multiple execution sources".into());
    }
    let job=captures(prompt,r"(?m)^Job: ([^\s]+)$");
    let task=captures(prompt,r"(?m)^Task: ([^\s]+)$");
    let execution=captures(prompt,r"(?m)^Execution: ([0-9a-f-]{36})$");
    if job.len()!=1 || task.len()!=1 || execution.len()!=1{
        return Err("Z worker prompt requires exactly one Graph-issued execution source".into());
    }
    Ok(format!("job/{}/task/{}/execution/{}",job[0],task[0],execution[0]))
}
pub fn z_task_brief(prompt:&str)->Result<String,String>{
    if !prompt.starts_with("[Relay agent: worker; adapter: z]"){
        return Ok(prompt.into());
    }
    let local=captures(prompt,
        r"(?s)Treat the following durable task input as the authoritative work contract; do not query GitHub\.\n\n(.*?)\n\n\[Authoritative execution context\]");
    let Some(local)=local.first() else{return Ok(prompt.into());};
    let output=captures(prompt,
        r"(?s)\[Output contract\]\n(.*?)\n\[Required event contracts\]");
    let Some(output)=output.first() else{
        return Err("Z worker missing authoritative output contract".into());
    };
    let objective=captures(prompt,r"(?m)^Job objective: (.+)$");
    let objective=objective.first().map(String::as_str).unwrap_or("(see task)");
    Ok(format!(
        "[LOCAL SQLite Job — no GitHub lookup]\nThe Task brief is complete and authoritative. Do not query GitHub issues or PRs for Relay state; use the version-matched Relay CLI. Read the configured harness bootstrap and the pinned contracts, retrieve Task context with Relay CLI, then execute the Task.\n[Durable Job objective]\n{objective}\n[Authoritative Task input]\n{local}\n[Output contract]\n{output}"
    ))
}
pub fn z_bootstrap(
    access_token:&str,prompt:&str,endpoint:Option<&str>,
)->Result<String,String>{
    z_execution_source(prompt)?;
    if access_token.trim().is_empty()
        || access_token.contains(['\r','\n']){
        return Err("Invalid Z worker credential".into());
    }
    let credential=format!("OAuth access token: {access_token}");
    let transport=endpoint.map(|endpoint|format!(
        "\nConfigured MCP endpoint: {endpoint}\nConnect using the short-lived OAuth access token above. Do not expose the token in logs or file contents."
    )).unwrap_or_default();
    let marker="\n## Bootstrap\n";
    if prompt.starts_with("# Role\n") && prompt.contains(marker) {
        Ok(prompt.replacen(marker,
            &format!("{marker}{credential}{transport}\n"),1))
    }else {
        Ok(format!("{credential}{transport}\n\n{prompt}"))
    }
}
pub fn z_worker_launch_request(
    prompt:&str,files:&[String],
    token:&str,endpoint:Option<&str>,
    execution_id:&str,timeout_ms:u64,
)->Result<Value,String>{
    let attachments=files.iter().filter(|path|
        !path.contains("/agents-relay/prompt-references/")).collect::<Vec<_>>();
    let mut message=z_bootstrap(token,&z_task_brief(prompt)?,endpoint)?;
    if !attachments.is_empty(){
        message.push_str("\n\nReference paths accessible through the configured MCP file tools:\n");
        message.push_str(&attachments.into_iter().map(String::as_str).collect::<Vec<_>>().join("\n"));
    }
    Ok(json!({
        "provider":"z","executionId":execution_id,
        "timeoutMs":timeout_ms,
        "action":"new-thread",
        "config":{"message":message,"timeout_seconds":90,"wait":false}
    }))
}
pub fn z_terminal_recovery_request(
    prompt:&str,thread_id:&str,token:&str,endpoint:&str,
)->Result<Value,String>{
    let source=z_execution_source(prompt)?;
    Ok(json!({
        "thread_id":thread_id,"wait":false,"timeout_seconds":90,
        "message":format!(
            "[Relay terminal recovery — original execution {source}]\nThe previous worker did not publish a terminal event. Verify the event history and durable Task output using the configured MCP provider at {endpoint}. Temporary access token: {token}. Never print this token or store it in files. If output is verifiably complete, publish task.completed for this exact execution. Otherwise continue and publish real task.progress, or task.failed when impossible. Never invent success or start another execution."
        )
    }))
}

/// Node ZAdapter exposes an independent WorkerAdapter identity; its actual
/// short-lived OAuth credential and WebHelm execution remain injected by the
/// caller, not baked into a generic ChatGPT worker or produced by this struct.
#[derive(Clone,Copy,Debug,Default)]
pub struct ZAdapter;
impl ZAdapter {
    pub fn new()->Self{Self}
    pub fn launch_request(
        &self,prompt:&str,files:&[String],token:&str,
        endpoint:Option<&str>,execution_id:&str,timeout_ms:u64,
    )->Result<Value,String>{
        z_worker_launch_request(prompt,files,token,endpoint,execution_id,timeout_ms)
    }
}
impl crate::adapters::WorkerAdapter for ZAdapter {
    fn name(&self)->&'static str{"z"}
    fn id(&self)->&str{Z_ADAPTER_ID}
    fn capabilities(&self)->&'static [&'static str]{&Z_CAPABILITIES}
}
