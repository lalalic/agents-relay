// Node provenance: src/cli.ts public runtime factories and native CLI route dispatch.
pub use crate::cli_runtime_public::{runtime,RuntimePaths,RuntimeReconciler};
pub use crate::cli_service_public::{create_service,start_service,Service};
// Head-to-head Phase1 port: src/cli.ts
// Standalone and daemon-backed CLI use the same immutable SQLite Job ID.
// The daemon owns workflow execution; a CLI command is a synchronous client.
// This source migration does NOT invoke Codex, GitHub or live Relay.
use crate::{
    cli_core_support::{arg,has_arg,text_option,read_file_utf8},
    cli_help::help_text,
    cli_job_create::require_preflight_cli,
    cli_project_run_mode::validate_project_run,
    cli_support::{
        relay_control_command,relay_control_job,relay_job_list,
        relay_job_state_command,relay_task_command,readonly_job_for,
        new_local_repository,integer_arg,
    },
    cli_revision::{revision_request,validate_revision_receipt},
    cli_unblock::{job_unblock_request,task_unblock_request},
    cli_review::{review_job_request,review_job_response},
    cli_task_complete::task_complete_request,
    cli_workflow::workflow_cli_result,
    cli_worker_task::{
        recovery_diagnosis_from_args,dependency_validity_from_args,
        worker_task_from_args,managed_worker_task_from_args,
    },
    events::random_uuid,
    job_routing_preferences,
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
    require_preflight_cli(args)?;
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
    let task_only=["--start","--task-id","--input","--input-file",
        "--adapter","--provider","--model","--profile","--reasoning",
        "--story-size","--agent","--agent-graph","--agent-graph-file","--parent","--deps","--capabilities",
        "--attachments","--max-attempts","--timeout","--cwd",
        "--output","--draft","--queue"];
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
    if has_arg(args,"--coordinator-graph") || has_arg(args,"--coordinator-input") {
        return Err("Coordinator requires a Project Run .mmd graph and file-backed input".into());
    }
    if !coordinator_enabled && has_arg(args,"--project-run-manifest") {
        return Err("--project-run-manifest requires Coordinator Project Run fields".into());
    }
    let coordinator=if coordinator_enabled{
        validate_project_run(args)?;
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
            "workspaceRoot":arg(args,"--coordinator-workspace-root","")
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
        "title":arg(args,"--title",""),"objective":objective,
        "projectRoot":project,"priority":priority,"tag":tag,
        "preflight":true, // transient Control attestation; not persisted
        "reviewEnabled":!has_arg(args,"--no-review"),
        "autoMerge":!has_arg(args,"--no-auto-merge"),
        "reviewerThreadId":arg(args,"--reviewer-thread-id",""),
        "creatorThreadId":arg(args,"--creator-thread-id",""),
        "implementationThreadId":arg(args,"--implementation-thread-id",""),
        "coordinator":coordinator
    });
    // Node JSON.stringify omits undefined option values; an empty
    // idempotencyKey or ID is NOT an explicit value. Sending "" changes
    // semantics: canonical SQLite allocator correctly rejects that key.
    for (flag,key) in [
        ("--id","id"),
        ("--idempotency-key","idempotencyKey"),
        ("--title","title"),
        ("--reviewer-thread-id","reviewerThreadId"),
        ("--creator-thread-id","creatorThreadId"),
        ("--implementation-thread-id","implementationThreadId"),
    ]{
        let supplied=arg(args,flag,"");
        if !supplied.is_empty(){
            options[key]=json!(supplied);
        }else if let Some(object)=options.as_object_mut(){
            object.remove(key);
        }
    }
    // Node emits no optional property for undefined objective, tag or
    // coordinator. An explicit null can be a rejected binding rather than
    // an absent field.
    if objective.trim().is_empty(){
        options.as_object_mut().expect("JSON object").remove("objective");
    }
    for field in ["tag","coordinator"]{
        if options[field].is_null(){
            options.as_object_mut().expect("JSON object").remove(field);
        }
    }
    if has_arg(args,"--clear-routing-preferences") {
        return Err("--clear-routing-preferences is only valid for job update".into());
    }
    if let Some(preferences)=job_routing_preferences::from_cli(args,None)? {
        options["routingPreferences"]=preferences;
    }
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
    if let Some(preferences)=job_routing_preferences::from_cli(
        args,existing.get("routingPreferences"))? {
        patch["routingPreferences"]=preferences;
    }
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
        // CLI input preflight and real daemon Graph unblock use the same
        // public Node-derived Rust unblock contract, never a loose status
        // override. SQLite remains the only Task-state authority.
        let proposed=job_unblock_request(args,&job,
            crate::unblock::is_effectively_blocked)?;
        return control_response(port,args,&json!({
            "command":"job.unblock","jobId":id,
            "reason":proposed.get("reason")
        }));
    }
    control_response(port,args,&job_update_request(args,&job,stdin)?)
}
pub fn task_update_request(
    args:&[String],job:&Value,task:&Value,stdin:Option<&str>,
)->Result<Value,String>{
    job_routing_preferences::reject_task_flags(args)?;
    if has_arg(args,"--agent-graph") || has_arg(args,"--agent-graph-file") {
        return Err("Task graphs are reserved for neo project run Coordinator creation".into());
    }
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
        if !matches!(adapter,"codex"){
            return Err("--adapter must be codex (use --profile neo for ChatGPT-backed execution)".into());
        }
        candidate["adapter"]=json!(adapter);
        // An adapter switch cannot retain a route/selection bound to the previous worker.
        if field(task,"adapter")!=adapter {
            candidate.as_object_mut().unwrap().remove("routing");
            candidate.as_object_mut().unwrap().remove("workerSelection");
            let mut requirements=candidate.get("workerRequirements")
                .filter(|v|v.is_object()).cloned()
                .unwrap_or(json!({"capabilities":[]}));
            requirements["runtime"]=json!(adapter);
            candidate["workerRequirements"]=requirements;
        }
    }
    let route_flags=["--provider","--model","--profile","--reasoning",
        "--cwd"];
    let explicit_route=route_flags.iter().any(|flag|has_arg(args,flag));
    if has_arg(args,"--clear-routing") && explicit_route {
        return Err("--clear-routing cannot be combined with explicit routing flags".into());
    }
    if has_arg(args,"--clear-routing") {
        candidate.as_object_mut().unwrap().remove("routing");
        candidate.as_object_mut().unwrap().remove("workerSelection");
    }else if explicit_route {
        let mut routing=candidate.get("routing")
            .filter(|v|v.is_object()).cloned().unwrap_or(json!({}));
        // A new model/provider must not accidentally reuse an incompatible
        // profile or reasoning effort from the previous exact route.
        if (has_arg(args,"--model") &&
            arg(args,"--model","")!=field(&routing,"model")) ||
           (has_arg(args,"--provider") &&
            arg(args,"--provider","")!=field(&routing,"provider")) {
            if !has_arg(args,"--profile") {
                routing.as_object_mut().unwrap().remove("profile");
            }
            if !has_arg(args,"--reasoning") {
                routing.as_object_mut().unwrap().remove("reasoning");
            }
        }
        for (flag,key) in [("--provider","provider"),("--model","model"),
            ("--profile","profile"),("--reasoning","reasoning"),
            ("--cwd","cwd")] {
            if has_arg(args,flag) {
                let value=required(args,flag,"Task routing")?;
                routing[key]=json!(value);
            }
        }
        if field(&routing,"model").is_empty() {
            return Err("task update explicit routing requires --model or an existing model".into());
        }
        if field(&routing,"provider").is_empty() {
            routing["provider"]=json!("openai");
        }
        routing["decidedBy"]=json!("cli");
        routing["decidedAt"]=json!(iso8601_now());
        routing.as_object_mut().unwrap().remove("decisionEvidence");
        routing.as_object_mut().unwrap().remove("decisionId");
        candidate["routing"]=routing;
        candidate.as_object_mut().unwrap().remove("workerSelection");
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
        "comments","list","complete","retry","recover","unblock","escalate",
        "resume-troubleshooter","cancel","supersede","classify","revise"];
    if !allowed.contains(&action){
        return Err(format!("Unsupported Task command {action}"));
    }
    if has_arg(args,"--shortcut-local"){
        return Err("Legacy Shortcut local binding is removed".into());
    }
    if action=="complete"{
        // No speculative Task load or success transition: daemon authenticates
        // the active execution, verifies Git and commits through SQLite/Graph.
        return port.control(args,&task_complete_request(args)?);
    }
    if action=="revise"{
        let request=revision_request(args)?;
        let accepted=port.control(args,&request)?;
        return validate_revision_receipt(&request,accepted);
    }
    if matches!(action,"context"|"events"){
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
    if action=="show"||action=="comments"{
        // The same public read-only Task accessor as Node cli-prompt.ts
        // owns the Job/Task identity and optional comment semantics.
        let rendered=crate::cli_prompt::run_task_read_command(action,args,&job)?;
        return serde_json::from_str(&rendered).map_err(|error|error.to_string());
    }
    if action=="create"{
        let task=managed_worker_task_from_args(Path::new("workflow"),
            &job,args,&iso8601_now(),stdin)?;
        let mut request=json!({"jobId":id,"action":"create","task":task});
        let key=arg(args,"--idempotency-key","");
        // An omitted Task retry key is absent on the Node CLI wire, not
        // the explicit invalid empty string rejected by the ID allocator.
        if !key.is_empty(){request["idempotencyKey"]=json!(key);}
        let result=port.task_command(args,&request)?;
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
        "unblock"=>{
            let original=selected.ok_or("Unblock Task missing from Job")?;
            let requested=task_unblock_request(args,original)?;
            json!({"command":"task.unblock","jobId":id,
                "taskId":task_id,"reason":requested.get("reason"),
                "response":requested.get("response")})
        },
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
/// Native equivalent of the original src/cli.ts agent-register and
/// agent-discover admission. Construct the Job-scoped request only; the
/// daemon's existing Graph/SQLite workspace control remains authoritative.
pub fn agent_control_request(action:&str,args:&[String])->Result<Value,String>{
    let id=arg(args,"--id","");
    if id.is_empty(){
        return Err(format!("{action} requires --repo and --id"));
    }
    let csv=|flag:&str,delimiter:char|->Vec<String>{
        arg(args,flag,"").split(delimiter).filter(|v|!v.is_empty())
            .map(str::to_string).collect()
    };
    match action{
        "agent-discover"=>{
            let runtime=arg(args,"--runtime","");
            let trust=arg(args,"--trust-domain","");
            let kind=arg(args,"--task-kind","");
            let mut required=json!({
                "capabilities":csv("--capabilities",','),
                "availability":csv("--availability",','),
                "explore":has_arg(args,"--explore"),
            });
            for (name,value) in [("runtime",runtime),("trustDomain",trust),("taskKind",kind)]{
                if !value.is_empty(){required[name]=json!(value);}
            }
            Ok(json!({"command":"agent.discover","jobId":id,
                "requirements":required}))
        },
        "agent-register"=>{
            let name=arg(args,"--name","");
            let responsibility=arg(args,"--responsibility","");
            let role=arg(args,"--role","");
            let endpoint=arg(args,"--endpoint","");
            if name.is_empty()||responsibility.is_empty()||role.is_empty()
                ||endpoint.is_empty(){
                return Err("--name, --responsibility, --role, and --endpoint are required".into());
            }
            let agent_id=arg(args,"--agent-id","");
            let agent_id=if agent_id.is_empty(){random_uuid()}else{agent_id.into()};
            let now=iso8601_now();
            let mut labels=json!({});
            for label in csv("--labels",','){
                let mut split=label.split('=');
                if let (Some(key),Some(value))=(split.next(),split.next()){
                    if !key.is_empty()&&!value.is_empty(){labels[key]=json!(value);}
                }
            }
            let adapter=arg(args,"--adapter","shell");
            let runtime=arg(args,"--runtime",adapter);
            let mut run=json!({"adapter":runtime});
            for key in ["--provider","--model"]{
                let value=arg(args,key,"");
                if !value.is_empty(){
                    run[key.trim_start_matches("--")]=json!(value);
                }
            }
            let registration=json!({
                "id":agent_id,"name":name,"responsibility":responsibility,"role":role,
                "capabilities":csv("--capabilities",','),
                "boundaries":csv("--boundaries",'|'),
                "endpoint":{"kind":arg(args,"--endpoint-kind","adapter"),"target":endpoint},
                "runtime":run,
                "availability":arg(args,"--availability","available"),
                "routing":{"labels":labels,
                    "trustDomains":csv("--trust-domains",','),
                    "regions":csv("--regions",',')},
                "evidence":{"evaluations":[],"outcomes":{
                    "succeeded":0,"failed":0,"timedOut":0},
                    "lastObservedAt":Value::Null},
                "registeredAt":now,"updatedAt":now
            });
            Ok(json!({"command":"agent.register","jobId":id,
                "agent":registration}))
        },
        _=>Err(format!("Unsupported agent command {action}")),
    }
}
pub fn run_cli<P:CliRuntimePort>(
    port:&mut P,argv:&[String],stdin:Option<&str>,
)->Result<Value,String>{
    crate::cli_option_contract::validate_cli_options(argv)?;
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
    match command{
        "job"=>run_job_command(port,
            args.first().map(String::as_str).unwrap_or(""),
            &args[args.len().min(1)..],stdin),
        "task"=>run_task_command(port,
            args.first().map(String::as_str).unwrap_or(""),
            &args[args.len().min(1)..],stdin),
        "review" if args.first().is_some_and(|a|a=="job")=>{
            let flags=&args[1..];
            let request=review_job_request(flags)?;
            let response=port.control(flags,&request)?;
            Ok(review_job_response(&response))
        },
        // Original Node escalation receives ALL flag arguments. It does not
        // have an action subcommand and must not discard --intent.
        "escalation"=>port.execute("escalation","",args),
        // `prompt` has no action subcommand: its first token is a flag.
        // Never discard --id/--eval-file when forwarding to the production
        // Builder, unlike the action-bearing context/review commands.
        "prompt"=>port.execute("prompt","",args),
        "review"|"artifact"|"context"|"blocker"=>
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

#[cfg(test)]
mod project_mode_cli_tests {
    use super::*;
    #[test]
    fn job_creation_requires_exact_explicit_true_attestation(){
        let base=["--repo","neox","--objective","Fix microphone"]
            .map(str::to_owned).to_vec();
        let expected=crate::cli_job_create::JOB_PREFLIGHT_REQUIRED;
        assert_eq!(job_create_request(&base,None).unwrap_err(),expected);
        for extra in [
            vec!["--preflight=false"],vec!["--preflight=TRUE"],
            vec!["--preflight"],vec!["--preflight","true"],
            vec!["--preflight=1"],vec!["--preflight="],
            vec!["--preflight=true","--preflight=false"],
            vec!["--preflight=true","--preflight=true"],
        ]{
            let mut args=base.clone();args.extend(extra.iter().map(|v|v.to_string()));
            assert_eq!(job_create_request(&args,None).unwrap_err(),expected,"{extra:?}");
        }
        let mut valid=base.clone();valid.push("--preflight=true".into());
        for extra in [&[][..],&["--initial-plan"][..],&["--no-review"][..]]{
            let mut args=valid.clone();args.extend(extra.iter().map(|v|v.to_string()));
            let request=job_create_request(&args,None).unwrap();
            assert_eq!(request["options"]["preflight"],true);
            assert_eq!(request["command"],"job.create");
        }
    }
    #[test]
    fn ordinary_job_does_not_require_a_coordinator_or_planner() {
        let args = vec!["--repo", "neox", "--objective", "Fix microphone", "--preflight=true"]
            .into_iter().map(str::to_owned).collect::<Vec<_>>();
        let request = job_create_request(&args, None).unwrap();
        assert!(request["options"].get("coordinator").is_none());
        assert_eq!(request["initialPlan"], false);
    }
    #[test]
    fn ordinary_job_rejects_unmanaged_graph_and_inline_graph() {
        let basic = ["--repo", "neox", "--objective", "Fix microphone", "--preflight=true"];
        let mut args = basic.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        args.extend(["--coordinator-graph-file", "/tmp/arbitrary.mmd"].map(str::to_owned));
        assert!(job_create_request(&args,None).unwrap_err().contains("neo project run"));
        let mut args = basic.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        args.extend(["--coordinator-graph", "flowchart TD\na[agent:a]"].map(str::to_owned));
        assert!(job_create_request(&args,None).unwrap_err().contains("file-backed"));
        let mut args = basic.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        args.extend(["--agent-graph-file", "/tmp/graph.mmd"].map(str::to_owned));
        assert!(job_create_request(&args,None).unwrap_err().contains("does not accept Task option"));
    }
    #[test]
    fn ordinary_task_rejects_embedded_dag_without_touching_store() {
        let args = ["--input", "Implement change", "--output", "local-git", "--agent-graph-file", "/tmp/graph.mmd"]
            .map(str::to_owned).to_vec();
        let job = json!({"id":"720", "repository":"neox", "tasks":[]});
        let err = managed_worker_task_from_args(Path::new("workflow"), &job,
            &args, "2026-11-22T00:00:00Z", None).unwrap_err();
        assert!(err.contains("Neo Project"));
    }
}
