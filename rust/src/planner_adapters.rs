// Node provenance: src/planner.ts public PlannerTaskSpec, CommandObjectivePlanner
// and AgentObjectivePlanner. Graph/SQLite Plan Apply is the only completion
// authority: an executor process exiting zero never proves a Plan is applied.
use serde_json::{json,Map,Value};
use std::{fs,path::{Path,PathBuf}};
use crate::planner::{build_planner_codex_args,parse_planner_agent_message,
    planner_input,validate_planner_receipt};

fn string<'a>(value:&'a Value,key:&str)->&'a str{
    value.get(key).and_then(Value::as_str).unwrap_or("")
}
pub fn planning_spec(task:&Value)->Result<Value,String>{
    let id=string(task,"id");
    if task.get("output").is_none_or(Value::is_null){
        return Err(format!("Initial task {id} requires an output contract"));
    }
    if !matches!(string(task,"adapter"),"codex"|"chatgpt"|"z"){
        return Err(format!("Initial task {id} requires a supported worker adapter"));
    }
    let mut result=Map::new();
    for name in ["id","title","parentTaskId","input","priority","storySize",
        "projectName","agentName","agentGraph","review","dependencies",
        "dependencyValidity","capabilities","workerRequirements","adapter",
        "output","routing","continuation","maxAttempts","timeoutMs"]{
        if let Some(value)=task.get(name){result.insert(name.into(),value.clone());}
    }
    if let Some(resolution)=task.get("resolution").filter(|v|!v.is_null()){
        let mut value=resolution.clone();
        if let Some(fields)=value.as_object_mut(){
            for key in ["state","owner","updatedAt"]{fields.remove(key);}
        }
        result.insert("resolution".into(),value);
    }
    Ok(Value::Object(result))
}
fn plan_identity(context:&Value)->Result<(&str,&str),String>{
    let plan=context.get("planExecution").filter(|v|v.is_object())
        .ok_or("Planner execution is missing its durable Plan and execution identity")?;
    let plan_id=string(plan,"planId");
    let execution_id=string(plan,"executionId");
    if plan_id.is_empty()||execution_id.is_empty(){
        return Err("Planner execution is missing its durable Plan and execution identity".into());
    }
    Ok((plan_id,execution_id))
}
#[derive(Clone,Debug,PartialEq,Eq)]
pub struct PlannerProcessResult{
    pub exit_code:i32,
    pub stdout:String,
    pub stderr:String,
}
#[derive(Clone,Debug)]
pub struct CommandObjectivePlanner{command:String}
impl CommandObjectivePlanner{
    pub fn new(command:&str)->Result<Self,String>{
        if command.is_empty(){return Err("Planner command is required".into());}
        Ok(Self{command:command.into()})
    }
    pub fn plan<Run>(&self,context:&Value,mut run_owned:Run)->Result<Value,String>
    where Run:FnMut(&str,&str)->Result<PlannerProcessResult,String>{
        let input=planner_input(context);
        let result=run_owned(&self.command,&input)?;
        if result.exit_code!=0{
            return Err(if result.stderr.trim().is_empty(){
                format!("Planner exited {}",result.exit_code)
            }else{result.stderr.trim().into()});
        }
        let expected=context.get("planExecution")
            .map(|plan|format!("PLAN_APPLIED:{}:{}",string(plan,"planId"),string(plan,"executionId")))
            .unwrap_or_default();
        if expected.is_empty()||expected!=result.stdout.trim(){
            return Err("Planner command must commit its proposal through agents-relay plan apply and return the matching PLAN_APPLIED receipt".into());
        }
        Ok(json!({"objective_status":"satisfied",
            "assessment":"Plan committed through the authorized CLI action.",
            "next_tasks":[],"unblocks":[],"cliApplied":true}))
    }
}
/// Build the same version-matched Planner work prompt through the shared
/// immutable prompt renderer. Agent discovery uses the project source layers.
/// `repository_root` points to installed contracts; not a hardcoded device path.
pub fn build_planner_execution_prompt(
    context:&Value,repository_root:&Path,agent_file:Option<&Path>,
    adapter:&str,prompt_snapshot_dir:Option<&str>,
)->Result<String,String>{
    let (plan_id,execution_id)=plan_identity(context)?;
    let execution_context=context.get("executionContext").filter(|v|!v.is_null());
    let default_agent=repository_root.join("skills/agents-relay/agents/planner.agent.md");
    let supplied=agent_file.unwrap_or(&default_agent);
    let content=if let Some(ctx)=execution_context{
        let project=&ctx["project"];
        let path=string(project,"path");
        let selected=crate::agent_content_resolver::resolve_agent_markdown(
            "planner",
            &repository_root.join("skills/agents-relay/agents").to_string_lossy(),
            path,Some(&crate::agent_content_resolver::agent_source_layers(path,project)),
        )?;
        match selected.get("content").and_then(Value::as_str){
            Some(content)=>content.into(),
            None=>fs::read_to_string(supplied).map_err(|e|e.to_string())?,
        }
    }else{fs::read_to_string(supplied).map_err(|e|e.to_string())?};
    let agents=execution_context.and_then(|ctx|ctx.get("agents"))
        .and_then(Value::as_array);
    let suggested_skills=agents.into_iter().flatten()
        .find(|item|string(item,"name")=="planner")
        .and_then(|item|item.get("suggestedSkills"));
    let ponytail=execution_context.and_then(|ctx|ctx.get("skills"))
        .and_then(Value::as_array).into_iter().flatten()
        .find(|skill|string(skill,"name")=="ponytail")
        .and_then(|item|item.get("path")).and_then(Value::as_str)
        .filter(|path|!path.is_empty());
    let mut contracts=vec![
        repository_root.join("skills/agents-relay/contracts/task-job-contract.md")
            .to_string_lossy().to_string(),
        repository_root.join("skills/agents-relay/contracts/blocker-job-recovery.md")
            .to_string_lossy().to_string(),
    ];
    if let Some(path)=ponytail{contracts.push(path.to_string());}
    let contexts=execution_context.and_then(|ctx|ctx.get("instructions"))
        .and_then(Value::as_array).into_iter().flatten()
        .filter(|v|string(v,"path").ends_with("/AGENTS.md"))
        .cloned().collect::<Vec<_>>();
    let project=execution_context.and_then(|ctx|ctx.get("project"));
    let fallback=std::env::current_dir().map_err(|e|e.to_string())?;
    let project_path=project.and_then(|p|p.get("gitRoot").and_then(Value::as_str)
        .or_else(||p.get("path").and_then(Value::as_str)))
        .map(str::to_string).unwrap_or_else(||fallback.to_string_lossy().to_string());
    let mut provider=execution_context.and_then(|ctx|ctx.pointer(
        &format!("/providerInstructions/{adapter}"))).cloned().unwrap_or(json!([]));
    if let Some(cli)=context.get("nativeRustCli").and_then(Value::as_str)
        .filter(|cli|Path::new(cli).is_absolute()){
        let mut rules=provider.as_array().cloned().unwrap_or_default();
        rules.push(json!(format!(
            "Version-matched native Rust Relay CLI (REQUIRED): {cli}. Use this exact executable for plan context, plan apply, and state reads. Never invoke Node dist/cli.js or a different-version CLI. plan context returns the authoritative native apply_cli."
        )));
        provider=json!(rules);
    }
    crate::agent_prompt_builder::build_relay_work_prompt(&json!({
        "agentName":"planner","agentContent":content,
        "suggestedSkills":suggested_skills,"adapter":adapter,
        "contracts":contracts,"contexts":contexts,"projectPath":project_path,
        "providerInstructions":provider,
        "skillPath":repository_root.join("skills/agents-relay/SKILL.md").to_string_lossy(),
        "jobId":context.pointer("/job/id"),"taskId":plan_id,"executionId":execution_id,
    }),prompt_snapshot_dir)
}
#[derive(Clone,Debug)]
pub struct AgentObjectivePlanner{
    command:String,agent_file:Option<PathBuf>,
}
impl Default for AgentObjectivePlanner{
    fn default()->Self{Self::new(None,None)}
}
impl AgentObjectivePlanner{
    pub fn new(command:Option<&str>,agent_file:Option<&Path>)->Self{
        Self{command:command.unwrap_or("codex").into(),
            agent_file:agent_file.map(Path::to_path_buf)}
    }
    /// `run_owned` is the ONLY process boundary. Real runtime uses the common
    /// OwnedProcessManager; tests inject a harmless fixture and never run Codex.
    pub fn plan<Run>(&self,context:&Value,repository_root:&Path,
        store_directory:&Path,prompt_snapshot_dir:Option<&str>,
        mut run_owned:Run,
    )->Result<Value,String>
    where Run:FnMut(&str,&[String],Option<&Path>)->Result<PlannerProcessResult,String>{
        let (plan_id,execution_id)=plan_identity(context)?;
        let prompt=build_planner_execution_prompt(context,repository_root,
            self.agent_file.as_deref(),"codex",prompt_snapshot_dir)?;
        let argv=build_planner_codex_args(store_directory,&prompt);
        let cwd=context.pointer("/executionContext/project/gitRoot")
            .or_else(||context.pointer("/executionContext/project/path"))
            .and_then(Value::as_str).map(Path::new);
        let result=run_owned(&self.command,&argv,cwd)?;
        if result.exit_code!=0{
            return Err(if result.stderr.trim().is_empty(){
                format!("Planner agent runtime exited {}",result.exit_code)
            }else{result.stderr.trim().into()});
        }
        let message=result.stdout.lines().filter_map(parse_planner_agent_message).last()
            .ok_or("Planner agent returned no final message")?;
        validate_planner_receipt(&message,plan_id,execution_id)
    }
}
