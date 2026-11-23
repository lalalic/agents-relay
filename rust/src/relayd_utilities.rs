// Node provenance: src/relayd-utilities.ts. Daemon-side orchestration only;
// the existing Dashboard client HTML/CSS/JS is deliberately left unchanged.
use serde_json::Value;
use std::{collections::HashMap, env, future::Future, path::{Path,PathBuf}};

pub const DAEMON_HELP:&str=r#"Agents Relay daemon runs the dashboard and worker pool.

Usage:
  npx agents-relayd [options]

Options:
  --repo LOCAL_ROOT_NAME       Optional local Git identity; Job inventory comes from SQLite
  --workspace-root PATH        Optional worktree/execution placement; never scans for repositories
  --workspace PATH             Legacy alias for --workspace-root (not needed for normal daemon)
  --port PORT             Dashboard port (default: 8787)
  --concurrency N         Maximum concurrent workers (default: 4)
  --interval MS           Recovery interval
  --execution-router-rules PATH
                         Router Rules file (default: ~/.agents-relay/execution-router-rules.md)
  --events nats            Require NATS event wakeups (otherwise auto-detect reachable NATS)

Examples:
  npx agents-relayd
  npx agents-relayd --repo LOCAL_ROOT_NAME

No recursive Workspace search: persisted Job projectRoot in SQLite
are authoritative. Changing Workspace directory layout does not select Jobs."#;
/// Original JavaScript public constant export preserved for exact API parity.
#[allow(non_upper_case_globals)]
pub const daemonHelp:&str=DAEMON_HELP;

#[derive(Debug,Clone,PartialEq,Eq)]
pub struct DaemonArguments {
    pub repository:Option<String>,
    pub workspace_root:Option<PathBuf>,
    pub service_arguments:Vec<String>,
}
pub fn value<'a>(args:&'a [String],name:&str,fallback:&'a str)->&'a str {
    args.iter().position(|arg|arg==name)
        .and_then(|idx|args.get(idx+1)).map(String::as_str).unwrap_or(fallback)
}
fn absolute_path(value:&str)->Result<PathBuf,String> {
    let path=Path::new(value);
    let cwd=env::current_dir().map_err(|error|error.to_string())?;
    let joined=if path.is_absolute(){path.into()}else{cwd.join(path)};
    let mut normalized=PathBuf::new();
    for component in joined.components() {
        use std::path::Component::*;
        match component {
            ParentDir=>{normalized.pop();},
            CurDir=>{},
            other=>normalized.push(other.as_os_str()),
        }
    }
    Ok(normalized)
}
pub fn normalize_daemon_arguments(
    argv:&[String],env_workspace_root:Option<&str>,
)->Result<DaemonArguments,String>{
    crate::cli_option_contract::validate_daemon_options(argv)?;
    let repository=value(argv,"--repo","");
    if !repository.is_empty() && argv.iter().any(|arg|arg=="--workspace") {
        return Err("--repo and --workspace are mutually exclusive".into());
    }
    if argv.iter().any(|arg|arg=="--workspace-root")
        && argv.iter().any(|arg|arg=="--workspace") {
        return Err("--workspace-root and --workspace cannot both be supplied".into());
    }
    let configured=value(argv,"--workspace-root","");
    let legacy=value(argv,"--workspace","");
    let workspace=if !configured.is_empty(){Some(configured)}
        else if !legacy.is_empty(){Some(legacy)}
        else{env_workspace_root.filter(|root|!root.is_empty())};
    let workspace_root=workspace.map(absolute_path).transpose()?;
    Ok(DaemonArguments{
        repository:(!repository.is_empty()).then(||repository.into()),
        workspace_root,
        service_arguments:argv.to_vec(),
    })
}
pub fn first_stage_choices(decision:Option<&Value>)->Vec<String> {
    decision.and_then(|d|d.get("stages")).and_then(Value::as_array)
        .and_then(|stages|stages.first()).and_then(|first|first.get("contract"))
        .and_then(|contract|contract.get("choices")).and_then(Value::as_array)
        .into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect()
}
fn overview_key(item:&Value)->String {
    let job=&item["job"];
    let repository=job.get("repository").and_then(Value::as_str).unwrap_or("undefined");
    let id=job.get("id").and_then(Value::as_str).unwrap_or("undefined");
    format!("{repository}:{id}")
}
pub fn merge_operational_inventory(current:&[Value],discovered:&[Value])->Vec<Value> {
    let mut values=Vec::<Value>::new();
    let mut indices=HashMap::<String,usize>::new();
    for entry in current.iter().chain(discovered.iter()) {
        let key=overview_key(entry);
        if let Some(index)=indices.get(&key){values[*index]=entry.clone();}
        else{indices.insert(key,values.len());values.push(entry.clone());}
    }
    values
}
pub fn recovery_scan_repositories(
    repositories:&[String],cached:&[Value],dormant_probe_index:i64,
)->Vec<String>{
    let mut by_repository:HashMap<String,Vec<&Value>>=HashMap::new();
    for overview in cached {
        if let Some(repository)=overview.pointer("/job/repository").and_then(Value::as_str){
            by_repository.entry(repository.into()).or_default().push(overview);
        }
    }
    let mut active=Vec::new();
    let mut dormant=Vec::new();
    for repo in repositories {
        let found=by_repository.get(repo);
        if found.is_none_or(|items|items.is_empty() || items.iter().any(|item|{
            !matches!(item.pointer("/job/state").and_then(Value::as_str),
                Some("COMPLETED"|"CANCELLED"))
        })){active.push(repo.clone());}
        else{dormant.push(repo.clone());}
    }
    if !dormant.is_empty(){
        let idx=dormant_probe_index.unsigned_abs() as usize%dormant.len();
        active.push(dormant[idx].clone());
    }
    active
}
/// Hydration uses caller's SQLite adapter; cached GitHub metadata never
/// overwrites the authoritative local Job snapshot.
pub async fn overlay_operational_overviews<Hydrate,HFut>(
    overviews:&[Value],mut hydrate:Hydrate,
)->Result<Vec<Value>,String>
where
    Hydrate:FnMut(String,String,Value)->HFut,
    HFut:Future<Output=Result<Value,String>>,
{
    let mut result=Vec::with_capacity(overviews.len());
    for overview in overviews {
        let job=overview.get("job").ok_or("Managed overview missing Job")?;
        let repo=job.get("repository").and_then(Value::as_str)
            .ok_or("Managed Job missing repository")?;
        let id=job.get("id").and_then(Value::as_str).ok_or("Managed Job missing ID")?;
        let authoritative=hydrate(repo.into(),id.into(),job.clone()).await?;
        let mut row=overview.clone();
        row["job"]=authoritative;
        result.push(row);
    }
    Ok(result)
}

/// Node configureDaemonObservability: select and install the process-wide
/// structured observer from trusted daemon environment, not Task content.
pub fn configure_daemon_observability(env:&Value)->crate::observability::RelayObservability {
    let configured=crate::observability::RelayObservability::from_environment(env);
    crate::observability::set_observability(configured.clone());
    configured
}

/// Mechanical daemon CLI router file configuration. Returns the same selected
/// path as src/relayd-utilities.ts and keeps the explicit option in the
/// inherited process environment for all subsequent providers.
pub fn configure_execution_router_rules_path(argv:&[String])->String {
    let mut config=env::vars().collect::<HashMap<_,_>>();
    let home=env::var("HOME").map(PathBuf::from)
        .unwrap_or_else(|_|PathBuf::from("/"));
    let selected=configure_execution_router_rules_path_with_env(argv,&mut config,&home);
    if !value(argv,"--execution-router-rules","").is_empty(){
        // The option is trusted operator-controlled CLI input.
        env::set_var("AGENTS_RELAY_EXECUTION_ROUTER_RULES",&selected);
    }
    selected
}

/// Injectable environment used only to verify daemon CLI selection without
/// mutating the test runner's environment or touching a real rules file.
pub fn configure_execution_router_rules_path_with_env(
    argv:&[String],env:&mut HashMap<String,String>,home:&Path,
)->String {
    let explicit=value(argv,"--execution-router-rules","");
    if !explicit.is_empty(){
        let selected=crate::routing_policy::execution_router_rules_path(
            Some(explicit),None,home);
        env.insert("AGENTS_RELAY_EXECUTION_ROUTER_RULES".into(),selected);
    }
    crate::routing_policy::execution_router_rules_path(
        None,env.get("AGENTS_RELAY_EXECUTION_ROUTER_RULES").map(String::as_str),home)
}
