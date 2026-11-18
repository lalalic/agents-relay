pub use crate::cli_runtime_public::{runtime,RuntimePaths,RuntimeReconciler};
pub use crate::cli_service_public::{create_service,start_service,Service};
// Head-to-head Phase1 port: src/cli.ts
// Standalone and daemon-backed CLI use the same immutable SQLite Job ID.
// The daemon owns workflow execution; a CLI command is a synchronous client.
// This source migration does NOT invoke Codex, GitHub or live Relay.
use crate::{
    cli_core_support::{arg,has_arg,text_option,read_file_utf8},
    cli_help::help_text,
    cli_support::{
        relay_control_command,relay_control_job,relay_job_list,
        relay_job_state_command,relay_task_command,readonly_job_for,
        new_local_repository,integer_arg,
    },
    cli_revision::revision_request,
    cli_workflow::workflow_cli_result,
    cli_worker_task::{
        recovery_diagnosis_from_args,dependency_validity_from_args,
        worker_task_from_args,
    },
    events::random_uuid,
    local_merge_lock::iso8601_now,
    task_actions::{dispatch_task_action_snapshot,apply_task_hold_action,
        apply_task_queue_action},
    types::{story_size_timeout_ms,StorySize},
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf}};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn list<'a>(v:&'a Value,key:&str)->&'a [Value]{
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}
fn required<'a>(args:&'a [String],flag:&str,context:&str)->Result<&'a str,String>{
    let val=arg(args,flag,"");
    if val.is_empty(){Err(format!("{context} requires {flag}"))}
    else{Ok(val)}
}
fn text(args:&[String],one:&str,two:&str,stdin:Option<&str>)
    ->Result<String,String>{
    text_option(args,one,two,stdin)
}
pub fn is_entrypoint(source:&Path,invoked:Option<&Path>)->bool{
    let Some(invoked)=invoked else{return false;};
    fs::canonicalize(source).ok()==fs::canonicalize(invoked).ok()
}
pub fn service_defaults()->Value{
    json!({"port":8787,"watchdogMs":300000,
        "dashboardRefreshMs":300000,"projectionFlushMs":1000})
}
/// CLI external and interactive commands are delegated to dedicated native
/// Rust handlers; all effectful operations use the same BEGIN IMMEDIATE
/// SQLite transaction and Graph route as the daemon.
pub trait CliRuntimePort{
    fn execute(&mut self,group:&str,action:&str,args:&[String])
        ->Result<Value,String>;
    fn load(&mut self,job_id:&str,args:&[String])->Result<Value,String>{
        relay_control_job(args,job_id)
    }
    fn control(&mut self,args:&[String],command:&Value)
        ->Result<Value,String>{
        relay_control_command(args,command)
    }
    fn task_command(&mut self,args:&[String],command:&Value)
        ->Result<Value,String>{
        relay_task_command(args,command)
    }
    fn job_list(&mut self,args:&[String])->Result<Vec<Value>,String>{
        relay_job_list(args)
    }
}
pub fn job_create_request(args:&[String],stdin:Option<&str>)
    ->Result<Value,String>{
    let repository=new_local_repository(args)?;
    for removed in ["--project-path","--content-only",
        "--no-content-only","--shortcut-execution"]{
        if has_arg(args,removed){
            return Err(format!("{removed} is removed"));
        }
    }
    if has_arg(args,"--auto-merge")&&has_arg(args,"--no-auto-merge"){
        return Err("Choose only one of --auto-merge or --no-auto-merge".into());
    }
    let legacy=["--pr","--head","--base","--body"]
        .into_iter().find(|flag|has_arg(args,flag));
    if let Some(flag)=legacy{
        return Err(format!("job create does not accept {flag}"));
    }
    let task_only=["--start","--task-id","--input","--input-file",
        "--adapter","--provider","--model","--profile","--reasoning",
        "--story-size","--agent","--parent","--deps","--capabilities",
        "--attachments","--max-attempts","--timeout","--cwd",
        "--chatgpt-project","--output","--draft","--queue"];
    if let Some(flag)=task_only.iter().find(|flag|has_arg(args,flag)){
        return Err(format!("job create does not accept Task option {flag}"));
    }
    let objective=text(args,"--objective","--objective-file",stdin)?;
    if objective.trim().is_empty(){
        return Err("job create requires --objective or --objective-file".into());
    }
    let coordinator_fields=[
        "--coordinator-graph-file","--coordinator-output-path",
        "--coordinator-project-root","--coordinator-workspace-root",
        "--coordinator-input-file"
    ];
    let coordinator_enabled=coordinator_fields.iter().any(|key|
        has_arg(args,key));
    let coordinator=if coordinator_enabled{
        for key in coordinator_fields{
            if !has_arg(args,key)||arg(args,key,"").is_empty(){
                return Err("Coordinator requires graph-file, input-file, output-path, project-root and workspace-root".into());
            }
        }
        if has_arg(args,"--initial-plan"){
            return Err("Coordinator starts directly without a Planner".into());
        }
        let graph=text(args,"--coordinator-graph",
            "--coordinator-graph-file",stdin)?;
        let input=text(args,"--coordinator-input",
            "--coordinator-input-file",stdin)?;
        Some(json!({
            "graph":graph,"input":input,
            "outputPath":arg(args,"--coordinator-output-path",""),
            "projectRoot":arg(args,"--coordinator-project-root",""),
            "workspaceRoot":arg(args,"--coordinator-workspace-root",""),
            "sharedRoot":arg(args,"--coordinator-shared-root","")
        }))
    }else{None};
    let source=arg(args,"--local-merge-source","");
    let target=arg(args,"--local-merge-target","");
    if source.is_empty()!=target.is_empty(){
        return Err("Supply both --local-merge-source and --local-merge-target".into());
    }
    let project=coordinator.as_ref()
        .and_then(|v|v.get("projectRoot")).and_then(Value::as_str)
        .filter(|s|!s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(||{
            let explicit=arg(args,"--project-root","");
            if !explicit.is_empty(){explicit.into()}else{
                std::env::current_dir().ok().map(|p|p.to_string_lossy().into())
                    .unwrap_or_default()
            }
        });
    let priority=arg(args,"--priority","P2");
    if !matches!(priority,"P0"|"P1"|"P2"|"P3"){
        return Err("--priority must be P0,P1,P2 or P3".into());
    }
    let tag=if has_arg(args,"--tag"){
        Some(serde_json::from_str::<Value>(arg(args,"--tag",""))
            .map_err(|e|format!("Invalid Job tag: {e}"))?)
    }else{None};
    let mut options=json!({
        "id":arg(args,"--id",""),"idempotencyKey":arg(args,"--idempotency-key",""),
        "title":arg(args,"--title",""),"objective":objective,
        "projectRoot":project,"priority":priority,"tag":tag,
        "reviewEnabled":!has_arg(args,"--no-review"),
        "autoMerge":!has_arg(args,"--no-auto-merge"),
        "reviewerThreadId":arg(args,"--reviewer-thread-id",""),
        "creatorThreadId":arg(args,"--creator-thread-id",""),
        "implementationThreadId":arg(args,"--implementation-thread-id",""),
        "coordinator":coordinator
    });
    if !source.is_empty(){
        options["localMergeSource"]=json!(source);
        options["localMergeTarget"]=json!(target);
    }
    if has_arg(args,"--continue-kind")||has_arg(args,"--continue-target"){
        let kind=required(args,"--continue-kind","continuation")?;
        let target=required(args,"--continue-target","continuation")?;
        options["continuation"]=json!({"kind":kind,"target":target});
    }
    Ok(json!({"command":"job.create","repository":repository,
        "initialPlan":has_arg(args,"--initial-plan"),"options":options}))
}
pub fn job_update_request(
    args:&[String],existing:&Value,stdin:Option<&str>,
)->Result<Value,String>{
    let mut patch=json!({});
    for (flag,key) in [
        ("--title","title"),("--priority","priority"),
        ("--reviewer-thread-id","reviewerThreadId"),
        ("--creator-thread-id","creatorThreadId"),
        ("--implementation-thread-id","implementationThreadId")
    ]{
        if has_arg(args,flag){patch[key]=json!(arg(args,flag,""));}
    }
    if has_arg(args,"--objective")||has_arg(args,"--objective-file"){
        let objective=text(args,"--objective","--objective-file",stdin)?;
        if objective.trim().is_empty(){return Err("Job objective cannot be empty".into());}
        patch["objective"]=json!(objective);
    }
    if has_arg(args,"--auto-merge")&&has_arg(args,"--no-auto-merge"){
        return Err("Choose only one of --auto-merge or --no-auto-merge".into());
    }
    if has_arg(args,"--review")&&has_arg(args,"--no-review"){
        return Err("Choose only one of --review or --no-review".into());
    }
    if has_arg(args,"--auto-merge")||has_arg(args,"--no-auto-merge"){
        patch["autoMerge"]=json!(!has_arg(args,"--no-auto-merge"));
    }
    if has_arg(args,"--review")||has_arg(args,"--no-review"){
        patch["reviewEnabled"]=json!(!has_arg(args,"--no-review"));
    }
    if has_arg(args,"--tag"){
        patch["tag"]=serde_json::from_str(arg(args,"--tag",""))
            .map_err(|e|e.to_string())?;
    }
    if has_arg(args,"--local-merge-source")||has_arg(args,"--local-merge-target"){
        let source=required(args,"--local-merge-source","local merge")?;
        let target=required(args,"--local-merge-target","local merge")?;
        if !source.starts_with("refs/heads/")||target!="refs/heads/main"{
            return Err("Local merge must have a source branch and refs/heads/main target".into());
        }
        patch["localMerge"]=json!({"sourceRef":source,"targetRef":target,
            "status":"pending"});
    }
    let _=existing;
    Ok(json!({"command":"job.update","jobId":arg(args,"--id",""),
        "patch":patch}))
}
fn control_response<P:CliRuntimePort>(
    port:&mut P,args:&[String],body:&Value,
)->Result<Value,String>{
    port.control(args,body)
}
pub fn run_job_command<P:CliRuntimePort>(
    port:&mut P,action:&str,args:&[String],stdin:Option<&str>,
)->Result<Value,String>{
    if has_arg(args,"--shortcut-local"){
        return Err("Legacy Shortcut local binding is removed".into());
    }
    if matches!(action,"merge"){
        return Err("Unsupported command job merge: local Git merge is Graph-owned".into());
    }
    if !matches!(action,"create"|"update"|"show"|"list"|"unblock"|
        "cancel"|"pause"|"resume"|"run"){
        return Err(format!("Unsupported job action {action}"));
    }
    if action=="list"{return Ok(json!(port.job_list(args)?));}
    if action=="create"{
        return control_response(port,args,&job_create_request(args,stdin)?);
    }
    let id=required(args,"--id","job")?;
    if has_arg(args,"--project-path"){
        return Err("Job --project-path is removed".into());
    }
    if action=="run"{
        return port.execute("job","run",args);
    }
    if matches!(action,"pause"|"resume"){
        return port.execute("job",action,args);
    }
    let job=port.load(id,args)?;
    if action=="show"{return Ok(job);}
    if action=="cancel"{
        return relay_job_state_command(args,id,"CANCELLED");
    }
    if action=="unblock"{
        return control_response(port,args,&json!({
            "command":"job.unblock","jobId":id,
            "reason":required(args,"--reason","job unblock")?
        }));
    }
    control_response(port,args,&job_update_request(args,&job,stdin)?)
}
pub fn task_update_request(
    args:&[String],job:&Value,task:&Value,stdin:Option<&str>,
)->Result<Value,String>{
    let state=field(task,"state");
    if matches!(state,"RUNNING"|"SUCCEEDED"|"CANCELLED"){
        return Err(format!("Task {} is {state}; execution fields are immutable",
            field(task,"id")));
    }
    let mut candidate=task.clone();
    for (flag,key) in [
        ("--title","title"),("--project","projectName"),
        ("--agent","agentName"),("--parent","parentTaskId")
    ]{
        if has_arg(args,flag){candidate[key]=json!(arg(args,flag,""));}
    }
    if has_arg(args,"--adapter"){
        let adapter=arg(args,"--adapter","");
        if !matches!(adapter,"codex"|"chatgpt"|"z"){
            return Err("--adapter must be codex, chatgpt, or z".into());
        }
        candidate["adapter"]=json!(adapter);
    }
    if has_arg(args,"--priority"){
        let value=arg(args,"--priority","");
        if !matches!(value,"P0"|"P1"|"P2"|"P3"){
            return Err("Task priority must be P0..P3".into());
        }
        candidate["priority"]=json!(value);
    }
    if has_arg(args,"--story-size"){
        let size=arg(args,"--story-size","");
        if !matches!(size,"S"|"M"|"L"){
            return Err("Task story-size must be S, M or L".into());
        }
        candidate["storySize"]=json!(size);
        if !has_arg(args,"--timeout"){
            let base=match size{
                "S"=>300_000,"L"=>2_700_000,_=>900_000
            };
            candidate["timeoutMs"]=json!(base);
        }
    }
    if has_arg(args,"--input")||has_arg(args,"--input-file"){
        candidate["input"]=json!(text(args,"--input","--input-file",stdin)?);
    }
    for (flag,key,separator) in [
        ("--deps","dependencies",','),("--capabilities","capabilities",',')
    ]{
        if has_arg(args,flag){
            candidate[key]=json!(arg(args,flag,"").split(separator)
                .filter(|s|!s.is_empty()).collect::<Vec<_>>());
        }
    }
    let deps=list(&candidate,"dependencies").iter().filter_map(Value::as_str)
        .map(str::to_owned).collect::<Vec<_>>();
    if has_arg(args,"--dependency-validity"){
        candidate["dependencyValidity"]=dependency_validity_from_args(args,&deps)?.unwrap_or(Value::Null);
    }
    if has_arg(args,"--timeout"){
        candidate["timeoutMs"]=json!(integer_arg(args,"--timeout",900_000)?);
    }
    if has_arg(args,"--max-attempts"){
        candidate["maxAttempts"]=json!(integer_arg(args,"--max-attempts",3)?);
    }
    if has_arg(args,"--draft")&&has_arg(args,"--queue"){
        return Err("--draft and --queue are mutually exclusive".into());
    }
    if has_arg(args,"--draft")&&state=="QUEUED"{
        apply_task_hold_action(
            Path::new("workflows"),&mut candidate,&iso8601_now())?;
    }
    if has_arg(args,"--queue"){
        apply_task_queue_action(Path::new("workflows"),job,
            &mut candidate,&iso8601_now())?;
    }
    Ok(json!({"jobId":job.get("id"),"taskId":task.get("id"),
        "action":"update","task":candidate,
        "expectedUpdatedAt":task.get("updatedAt")}))
}
pub fn run_task_command<P:CliRuntimePort>(
    port:&mut P,action:&str,args:&[String],stdin:Option<&str>,
)->Result<Value,String>{
    let allowed=["create","update","show","context","events","comment",
        "comments","list","retry","recover","unblock","escalate",
        "resume-troubleshooter","cancel","supersede","classify","revise"];
    if !allowed.contains(&action){
        return Err(format!("Unsupported Task command {action}"));
    }
    if has_arg(args,"--shortcut-local"){
        return Err("Legacy Shortcut local binding is removed".into());
    }
    if matches!(action,"context"|"events"|"revise"){
        return port.execute("task",action,args);
    }
    let id=required(args,"--id","Task command")?;
    let job=port.load(id,args)?;
    if action=="list"{return Ok(job.get("tasks").cloned().unwrap_or(json!([])));}
    let task_id=arg(args,"--task-id","");
    if action!="create"&&task_id.is_empty(){
        return Err(format!("task {action} requires --task-id"));
    }
    let selected=list(&job,"tasks").iter()
        .find(|task|field(task,"id")==task_id);
    if action!="create"&&selected.is_none(){
        return Err(format!("Task {task_id} not found"));
    }
    if action=="show"{return Ok(selected.cloned().unwrap_or(Value::Null));}
    if action=="comments"{
        return Ok(selected.and_then(|v|v.get("comments"))
            .cloned().unwrap_or(json!([])));
    }
    if action=="create"{
        let options=json!({"idempotencyKey":arg(args,"--idempotency-key","")});
        let task=worker_task_from_args(Path::new("workflows"),
            &job,args,&iso8601_now(),Path::new(".agents-relay"),stdin)?;
        let result=port.task_command(args,&json!({"jobId":id,
            "action":"create","task":task,
            "idempotencyKey":options["idempotencyKey"]}))?;
        return Ok(result);
    }
    if action=="update"{
        return port.task_command(args,&task_update_request(
            args,&job,selected.expect("checked"),stdin)?);
    }
    if matches!(action,"retry"|"cancel"){
        return port.task_command(args,&json!({
            "jobId":id,"taskId":task_id,"action":action}));
    }
    let request=match action{
        "comment"=>json!({"command":"task.comment","jobId":id,
            "taskId":task_id,
            "message":text(args,"--message","--message-file",stdin)?}),
        "classify"=>json!({"command":"task.classify","jobId":id,
            "taskId":task_id,"classification":{
                "kind":arg(args,"--classification",""),
                "targetTaskId":arg(args,"--target-task-id",""),
                "evidence":text(args,"--evidence","--evidence-file",stdin)?,
                "reason":text(args,"--reason","--reason-file",stdin)?}}),
        "supersede"=>json!({"command":"task.supersede","jobId":id,
            "taskId":task_id,"reason":required(args,"--reason","supersede")?}),
        "recover"=>json!({"command":"task.recover","jobId":id,
            "taskId":task_id,
            "recoveryTaskId":required(args,"--recovery-task-id","recover")?,
            "recoveryDiagnosis":recovery_diagnosis_from_args(args)?}),
        "unblock"=>json!({"command":"task.unblock","jobId":id,
            "taskId":task_id,"reason":arg(args,"--reason",""),
            "response":arg(args,"--response","")}),
        "escalate"=>json!({"command":"task.escalate","jobId":id,
            "taskId":task_id,
            "requiredAction":arg(args,"--required-action",""),
            "resolutionCondition":arg(args,"--resolution-condition",""),
            "context":arg(args,"--context","")}),
        "resume-troubleshooter"=>json!({"command":"task.resume-troubleshooter",
            "jobId":id,"taskId":task_id,
            "response":required(args,"--response","resume-troubleshooter")?}),
        _=>return port.execute("task",action,args)
    };
    control_response(port,args,&request)
}
pub fn run_cli<P:CliRuntimePort>(
    port:&mut P,argv:&[String],stdin:Option<&str>,
)->Result<Value,String>{
    let Some(command)=argv.first().map(String::as_str)else{
        return Ok(json!(help_text(None,None)));
    };
    if matches!(command,"--help"|"-h"){
        return Ok(json!(help_text(None,None)));
    }
    let args=&argv[1..];
    if args.iter().any(|v|matches!(v.as_str(),"--help"|"-h")){
        return Ok(json!(help_text(Some(command),args.first().map(String::as_str))));
    }
    // Remote GitHub lifecycle switches are deliberately rejected: local
    // sqlite Job ID is the authority for create/merge/reconcile.
    for banned in ["--github-repo","--github-app-id",
        "--github-app-installation-id","--remote-lifecycle"]{
        if has_arg(args,banned){
            return Err(format!("Unsupported remote lifecycle option {banned}"));
        }
    }
    match command{
        "job"=>run_job_command(port,
            args.first().map(String::as_str).unwrap_or(""),
            &args[args.len().min(1)..],stdin),
        "task"=>run_task_command(port,
            args.first().map(String::as_str).unwrap_or(""),
            &args[args.len().min(1)..],stdin),
        "review"|"artifact"|"prompt"|"context"|"blocker"|"escalation"=>
            port.execute(command,args.first().map(String::as_str).unwrap_or(""),
                &args[args.len().min(1)..]),
        "workflow"=>{
            if args.first().is_some_and(|a|a=="action"){
                return port.execute("workflow","action",&args[1..]);
            }
            workflow_cli_result(args)
        },
        "plan" if args.first().is_some_and(|s|s=="context"||s=="apply")=>
            port.execute("plan",field(&json!({"action":args[0]}),"action"),
                &args[1..]),
        "plan"=>{
            let id=required(args,"--id","plan")?;
            let guidance=if has_arg(args,"--prompt")||has_arg(args,"--prompt-file"){
                text(args,"--prompt","--prompt-file",stdin)?
            }else{String::new()};
            control_response(port,args,&json!({
                "command":"job.plan","jobId":id,
                "guidance":guidance,"forceRestate":has_arg(args,"--force-restate")}))
        },
        "reconcile"=>{
            let id=required(args,"--id","reconcile")?;
            control_response(port,args,&json!({
                "command":"job.reconcile","jobId":id}))
        },
        "agent-register"|"agent-discover"|"init"|"record"|
            "status"|"serve"|"migrate-local-repositories"=>
                port.execute(command,"",args),
        other=>Err(format!("Unsupported command {other}"))
    }
}

/// Node cli.runtimePlanner: selects a concrete owned-process Planner.
pub fn runtime_planner(args:&[String])
    ->Result<crate::cli_runtime_public::RuntimePlanner,String>{
    crate::cli_runtime_public::runtime_planner(args)
}
/// Node cli.dashboardJobAction: Graph transitions through the passed Store,
/// followed by a Reconciler wake for start/reconcile only.
pub fn dashboard_job_action<P:crate::cli_runtime_public::DashboardJobActionPorts>(
    ports:&mut P,action:&str,job_id:&str,
)->Result<Value,String>{
    crate::cli_runtime_public::dashboard_job_action(ports,action,job_id)
}
