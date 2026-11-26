//! Native Agents Relay CLI front door. The daemon and SQLite/Graph own state;
//! the CLI only parses arguments and invokes the same control/HTTP routes as
//! Node. Unwired host actions explicitly fail rather than launching Node.
use agents_relay_rust2::{
    cli::{agent_control_request, run_cli, CliRuntimePort},
    cli_artifact::{result_json, validate_artifact},
    cli_blocker::run_blocker_command,
    cli_context::run_context_command,
    cli_coordinator::validate_coordinator_args,
    cli_core_support::{arg, has_arg, text_option},
    cli_escalation::run_escalation_command,
    cli_foreground::attach_foreground_daemon,
    cli_job_create::{require_preflight_cli, JOB_PREFLIGHT_REQUIRED},
    cli_prompt::{
        run_plan_context_command, run_prompt_command, run_task_context_command,
        run_task_events_command, run_task_read_command,
    },
    cli_review::run_review_command,
    cli_support::{
        priority as cli_priority, relay_cli_runtime_summary, relay_control_command,
        relay_control_job, relay_job_events,
    },
    cli_workflow_action::workflow_operation,
    events_bus_runtime::events_bus_history_page,
    execution_context::resolve_execution_context,
    managed_worker_input::managed_worker_input_resolved,
    outcome_review::run_outcome_review,
    planner::planner_input,
    planner_adapters::build_planner_execution_prompt,
};
use serde_json::{json, Value};
use std::{
    sync::atomic::{AtomicI32, Ordering},
    time::Duration,
};

static FOREGROUND_SIGNAL: AtomicI32 = AtomicI32::new(0);
extern "C" fn foreground_interrupt_signal(signal: libc::c_int) {
    FOREGROUND_SIGNAL.store(signal, Ordering::SeqCst);
}
struct ForegroundSignalGuard {
    sigint: libc::sighandler_t,
    sigterm: libc::sighandler_t,
}
impl ForegroundSignalGuard {
    fn install() -> Result<Self, String> {
        FOREGROUND_SIGNAL.store(0, Ordering::SeqCst);
        // Signal handlers only update one atomic. No allocations, locks,
        // subprocess kills or async HTTP requests execute in signal context.
        let old_int = unsafe {
            libc::signal(
                libc::SIGINT,
                foreground_interrupt_signal as *const () as libc::sighandler_t,
            )
        };
        if old_int == libc::SIG_ERR {
            return Err("Cannot install foreground SIGINT handler".into());
        }
        let old_term = unsafe {
            libc::signal(
                libc::SIGTERM,
                foreground_interrupt_signal as *const () as libc::sighandler_t,
            )
        };
        if old_term == libc::SIG_ERR {
            unsafe {
                libc::signal(libc::SIGINT, old_int);
            }
            return Err("Cannot install foreground SIGTERM handler".into());
        }
        Ok(Self {
            sigint: old_int,
            sigterm: old_term,
        })
    }
}
impl Drop for ForegroundSignalGuard {
    fn drop(&mut self) {
        unsafe {
            libc::signal(libc::SIGINT, self.sigint);
            libc::signal(libc::SIGTERM, self.sigterm);
        }
    }
}

struct DaemonClient;
impl CliRuntimePort for DaemonClient {
    fn execute(&mut self, group: &str, action: &str, args: &[String]) -> Result<Value, String> {
        match (group,action){
            ("init","")=>{
                require_preflight_cli(args)?;
                if !arg(args,"--file","").is_empty(){
                    return Err("Legacy --file Job initialization is not supported; use the canonical local SQLite daemon".into());
                }
                let repo=arg(args,"--repo","");
                if repo.is_empty() || repo=="." || repo==".."
                    || !repo.bytes().all(|c|c.is_ascii_alphanumeric()
                        || matches!(c,b'_'|b'.'|b'-')){
                    return Err("--repo must be a local Git root basename, not a path or remote owner/repo".into());
                }
                let project=arg(args,"--project-root","");
                let project=if project.is_empty(){
                    std::env::current_dir().map_err(|e|e.to_string())?
                }else{std::path::PathBuf::from(project)};
                let mut options=json!({
                    "title":arg(args,"--title","Agents Relay job"),
                    "projectRoot":project,
                    "priority":cli_priority(args,"P2")?,
                    "reviewEnabled":!args.iter().any(|a|a=="--no-review"),
                    "continuation":Value::Null,
                    "preflight":true, // transient; never included in Job snapshot
                });
                let continue_kind=arg(args,"--continue-kind","");
                let continue_target=arg(args,"--continue-target","");
                if !continue_kind.is_empty()&&!continue_target.is_empty(){
                    let mut continuation=json!({"kind":continue_kind,
                        "target":continue_target});
                    let value=arg(args,"--continue-input","");
                    if !value.is_empty(){continuation["input"]=json!(value);}
                    options["continuation"]=continuation;
                }
                for (flag,key) in [("--id","id"),("--objective","objective")]{
                    let value=arg(args,flag,"");
                    if !value.is_empty(){options[key]=json!(value);}
                }
                relay_control_command(args,&json!({"command":"job.create",
                    "repository":repo,"options":options}))
            },
            ("reconcile","")=>{
                if !arg(args,"--file","").is_empty(){
                    return Err("Legacy --file reconcile is unavailable in native managed Relay".into());
                }
                let id=arg(args,"--id","");
                if id.is_empty(){return Err("reconcile requires --repo and --id".into());}
                relay_control_command(args,&json!({"command":"job.reconcile","jobId":id}))
            },
            ("review","job"|"run"|"interactive")=>{
                run_review_command(action,args,
                    |path|{
                        // Explicit interactive review.preview request only.
                        // Private 0600 JSON file is constructed by the
                        // original verified review CLI helper.
                        let output=std::process::Command::new("neo")
                            .args(["mcp","call","review.preview","--args-file"])
                            .arg(path).output().map_err(|e|e.to_string())?;
                        if !output.status.success(){
                            return Err(format!("Neo review.preview failed: {}",
                                String::from_utf8_lossy(&output.stderr)));
                        }
                        String::from_utf8(output.stdout).map_err(|e|e.to_string())
                    },
                    |flags,body|relay_control_command(flags,body),
                    |_flags|Err("Native review run requires an explicitly configured reviewer runner".into()),
                )
            },
            ("agent-register"|"agent-discover","")=>{
                relay_control_command(args,&agent_control_request(group,args)?)
            },
            ("artifact","validate") => {
                // The installed native CLI must use the same read-only
                // validator as the original Node artifact command and the
                // direct Node/Rust parity fixture. No daemon, subprocess,
                // or Job mutation is involved.
                let artifact=arg(args,"--artifact","");
                let schema=arg(args,"--schema","");
                validate_artifact(artifact,schema).map(|result|result_json(&result))
            },
            ("artifact",_)=>Err("artifact supports only validate".into()),
            ("context","resolve")=>run_context_command("resolve",args),
            ("context",_)=>Err("context supports only resolve".into()),
            ("blocker",action)=>run_blocker_command(action,args,None),
            ("workflow","action")=>{
                // The original runWorkflowAction maps one supported Graph
                // task action and delegates the EXACT Task's CLI command;
                // never synthesize a state update or retry an HTTP POST.
                let operation=workflow_operation(args)?;
                agents_relay_rust2::cli::run_task_command(self,&operation,args,None)
            },
            ("status","") => relay_cli_runtime_summary(args),
            ("prompt","")=>{
                let package_root=agents_relay_rust2::runtime_resources::package_root()?;
                let graph=package_root.join("workflow");
                let binding=arg(args,"--id","");
                let job=if binding.is_empty(){None}
                    else{Some(relay_control_job(args,binding)?)};
                let rendered=run_prompt_command(&graph,args,job.as_ref(),
                    |project,role|resolve_execution_context(project,role,&json!({})),
                    |job,task,context,mode|managed_worker_input_resolved(
                        job,task,Some(context),mode,&package_root,None),
                    |context,_resolved,adapter|build_planner_execution_prompt(
                        context,&package_root,None,adapter,None))?;
                Ok(Value::String(rendered))
            },
            ("plan","apply")=>{
                let id=arg(args,"--id","");
                let plan_id=arg(args,"--plan-id","");
                let execution_id=arg(args,"--execution-id","");
                let file=arg(args,"--file","");
                if id.is_empty()||plan_id.is_empty()
                    ||execution_id.is_empty()||file.is_empty(){
                    return Err("plan apply requires --id --plan-id --execution-id --file".into());
                }
                let bytes=if file=="-"{
                    use std::io::Read;
                    let mut input=Vec::new();
                    std::io::stdin().take(1024*1024+1)
                        .read_to_end(&mut input).map_err(|e|e.to_string())?;
                    input
                }else{
                    std::fs::read(file).map_err(|e|e.to_string())?
                };
                if bytes.len()>1024*1024{
                    return Err("Planner proposal exceeds 1 MiB".into());
                }
                let proposal:Value=serde_json::from_slice(&bytes)
                    .map_err(|e|format!("Invalid Planner proposal JSON: {e}"))?;
                if !proposal.is_object(){
                    return Err("Planner proposal must be a JSON object".into());
                }
                relay_control_command(args,&json!({"command":"plan.apply",
                    "jobId":id,"planId":plan_id,
                    "executionId":execution_id,"proposal":proposal}))
            },
            ("plan","context")=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err("plan context requires --id".into());}
                let job=relay_control_job(args,binding)?;
                let rendered=run_plan_context_command(args,&job,
                    |project,role|resolve_execution_context(project,role,&json!({})),
                    |input|{
                        let mut native=input.clone();
                        native["nativeRustCli"]=json!(std::env::current_exe()
                            .map_err(|e|e.to_string())?.to_string_lossy().to_string());
                        Ok(planner_input(&native))
                    })?;
                Ok(Value::String(rendered))
            },
            ("task","context")=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err("task context requires --id".into());}
                let job=relay_control_job(args,binding)?;
                Ok(Value::String(run_task_context_command(args,&job)?))
            },
            ("task",action @ ("show"|"comments"))=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err(format!("task {action} requires --id"));}
                let job=relay_control_job(args,binding)?;
                Ok(Value::String(run_task_read_command(action,args,&job)?))
            },
            ("task","events")=>{
                let binding=arg(args,"--id","");
                if binding.is_empty(){return Err("task events requires --id".into());}
                let job=relay_control_job(args,binding)?;
                let environment=json!(std::env::vars().collect::<std::collections::HashMap<_,_>>());
                let rendered=run_task_events_command(args,&job,
                    |job_id,task_id,limit,order,after|{
                        events_bus_history_page(job_id,Some(task_id),&json!(limit),
                            &json!({"order":order,"after":after}),&environment)
                    })?;
                Ok(Value::String(rendered))
            },
            ("escalation","") => {
                // The operator-selected executable is the ONLY effect
                // provider. The canonical escalation Graph owns the result
                // and no Neo/default shell fallback is ever permitted.
                let env=std::env::vars().collect::<std::collections::HashMap<_,_>>();
                let graph=agents_relay_rust2::runtime_resources::package_root()?.join("workflow");
                run_escalation_command(args,&env,&graph)
            },
            ("job",action @ ("pause"|"resume")) => {
                let id=arg(args,"--id","");
                if id.is_empty(){return Err("job requires --id".into());}
                relay_control_command(args,&json!({
                    "command":if action=="resume"{"job.resume"}else{"job.pause"},
                    "jobId":id,
                }))
            },
            ("job","run") => {
                // Original Node CLI Coordinator contract. The daemon owns
                // the Graph decision and authoritative SQLite transaction.
                let foreground=has_arg(args,"--foreground");
                validate_coordinator_args(args,true)?;
                let id=arg(args,"--id","");
                if id.is_empty(){return Err("job requires --id".into());}
                let task_id=arg(args,"--task-id","");
                if task_id.is_empty(){return Err("job run requires --task-id".into());}
                let override_graph=if has_arg(args,"--agent-graph-file"){
                    let source=text_option(args,"--agent-graph",
                        "--agent-graph-file",None)?;
                    if source.is_empty(){None}else{Some(source)}
                }else{None};
                if has_arg(args,"--project-path"){
                    return Err("Job --project-path is removed; use the independent Git repository root".into());
                }
                let workspace=arg(args,"--workspace-root","");
                let global=arg(args,"--global-root","");
                let was_terminal=if foreground{
                    let current=relay_control_job(args,id)?;
                    matches!(current.get("state").and_then(Value::as_str),
                        Some("COMPLETED"|"CANCELLED"))
                }else{false};
                let receipt=if was_terminal{Value::Null}else{
                    relay_control_command(args,&json!({
                        "command":"job.run","jobId":id,"taskId":task_id,
                        "graphOverride":override_graph,
                        "workspaceRoot":if workspace.is_empty(){None}else{Some(workspace)},
                        "globalRoot":if global.is_empty(){
                            std::env::var("AGENTS_HOME").ok()
                        }else{Some(global.into())}
                    }))?
                };
                if !foreground{return Ok(receipt);}
                // Attach to the same daemon/Graph/SQLite ownership as
                // background job.run; NEVER launch a second local scheduler.
                let _signals=ForegroundSignalGuard::install()?;
                let attached=attach_foreground_daemon(
                    id,task_id,
                    ||relay_control_job(args,id),
                    ||relay_control_command(args,&json!({
                        "command":"job.reconcile","jobId":id
                    })).map(|_|()),
                    ||relay_job_events(args,id,128),
                    |message|println!("{message}"),
                    Duration::from_millis(1000),&FOREGROUND_SIGNAL,
                )?;
                Ok(attached.job)
            },
            // --foreground, background worker scheduling, local job
            // migrations and human escalation need the actual host ports,
            // not a fabricated success response or Node.js subprocess.
            _=>Err(format!(
                "Native Relay CLI action {group} {action} is not yet bound to the daemon; refusing to mutate state"
            )),
        }
    }
}
/// The Node CLI's "serve" owns one daemon process. Re-exec the native
/// daemon binary in-place (same PID / signals / single listener), never
/// fork a second in-process Scheduler or silently fallback to Node Relay.
/// The daemon itself requires explicit isolated-store options for mutation.
#[cfg(unix)]
fn native_serve(arguments: &[String]) -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let executable =
        std::env::current_exe().map_err(|e| format!("Native CLI binary path unavailable: {e}"))?;
    let owned = executable.with_file_name("agents-relayd-rust");
    if !owned.is_file() {
        return Err(format!(
            "Installed native Relay daemon binary not found: {}",
            owned.display()
        ));
    }
    // CommandExt::exec replaces the current process and retains its PID,
    // stdin/stdout/stderr and inherited signal semantics. No child/process
    // monitor or untracked launch is left behind.
    let error = std::process::Command::new(&owned)
        .args(&arguments[1..])
        .exec();
    Err(format!("Native Relay daemon exec failed: {error}"))
}
fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    // Local, read-only prompt-part builder. No Relay daemon, Job ID or
    // project source checkout required; Neo owns the platform assembly.
    if arguments == ["prompt", "--parts-stdin"] {
        match agents_relay_rust2::prompt_bootstrap::read_stdin() {
            Ok(parts) => {
                println!("{}", serde_json::to_string_pretty(&parts).unwrap());
                return;
            }
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if let Err(error) = agents_relay_rust2::cli_option_contract::validate_cli_options(&arguments) {
        eprintln!("{error}");
        std::process::exit(1);
    }
    if arguments.first().is_some_and(|arg| arg == "serve")
        && !arguments
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        #[cfg(unix)]
        {
            if let Err(error) = native_serve(&arguments) {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
        #[cfg(not(unix))]
        {
            eprintln!("Native Relay serve requires a supported Unix host");
            std::process::exit(1);
        }
        return;
    }
    if arguments.get(0).is_some_and(|arg| arg == "review")
        && arguments.get(1).is_some_and(|arg| arg == "run")
    {
        // Node runOutcomeReview publishes its verdict and has distinct
        // completed/changes-needed/blocked POSIX exit statuses. Preserve
        // that contract instead of serializing a generic {"ok":true}
        // around the already-published review output. This owned runner
        // executes ONLY on an explicitly requested review run, never while
        // starting a daemon or processing a Worker receipt.
        let flags = &arguments[2..];
        let cwd = match std::env::current_dir() {
            Ok(value) => value,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
        let workspace = arg(flags, "--workspace-root", "");
        let workspace = if workspace.is_empty() {
            cwd.clone()
        } else {
            std::path::PathBuf::from(workspace)
        };
        let relay_root = match agents_relay_rust2::runtime_resources::package_root() {
            Ok(root) => root,
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        };
        let model =
            std::env::var("AGENTS_RELAY_REVIEW_MODEL_BIN").unwrap_or_else(|_| "codex".into());
        match run_outcome_review(flags, &cwd, &workspace, &relay_root, &model) {
            Ok(exit) => std::process::exit(exit),
            Err(error) => {
                eprintln!("{error}");
                std::process::exit(1);
            }
        }
    }
    if arguments.first().is_some_and(|arg| arg == "--version") {
        println!(
            "agents-relay-rust {} (native preview)",
            env!("CARGO_PKG_VERSION")
        );
        return;
    }
    let mut port = DaemonClient;
    match run_cli(&mut port, &arguments, None) {
        Ok(Value::String(help))
            if arguments.is_empty()
                || arguments
                    .first()
                    .is_some_and(|a| matches!(a.as_str(), "--help" | "-h"))
                || arguments
                    .iter()
                    .any(|a| matches!(a.as_str(), "--help" | "-h")) =>
        {
            println!("{help}");
        }
        Ok(result) => {
            let raw = arguments.first().is_some_and(|command| command == "prompt")
                || matches!(arguments.first().map(String::as_str), Some("plan" | "task"))
                    && arguments
                        .get(1)
                        .is_some_and(|action| matches!(action.as_str(), "context" | "events"));
            if raw {
                if let Some(message) = result.as_str().filter(|message| !message.is_empty()) {
                    println!("{message}");
                }
            } else {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&result).unwrap_or_else(|_| "null".to_string())
                );
            }
            let foreground_signal = FOREGROUND_SIGNAL.load(Ordering::SeqCst);
            if foreground_signal == libc::SIGINT {
                std::process::exit(130);
            }
            if foreground_signal == libc::SIGTERM {
                std::process::exit(143);
            }
            if arguments.first().is_some_and(|cmd| cmd == "artifact")
                && arguments.get(1).is_some_and(|action| action == "validate")
                && result.get("valid").and_then(Value::as_bool) == Some(false)
            {
                eprintln!("Artifact validation failed");
                std::process::exit(1);
            }
            if arguments.first().is_some_and(|cmd| cmd == "job")
                && arguments.get(1).is_some_and(|action| action == "run")
                && arguments.iter().any(|argument| argument == "--foreground")
                && result.get("state").and_then(Value::as_str) == Some("CANCELLED")
            {
                std::process::exit(1);
            }
            if arguments.first().is_some_and(|cmd| cmd == "escalation")
                && result.get("state").and_then(Value::as_str) == Some("technical_failure")
            {
                std::process::exit(2);
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(if error == JOB_PREFLIGHT_REQUIRED {
                2
            } else {
                1
            });
        }
    }
}
