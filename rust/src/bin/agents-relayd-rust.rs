//! Native Rust Relay daemon: one Graph/SQLite owner and one Dashboard.
//! The live writable mode requires an exact canonical store, an exclusive
//! on-disk owner lock and an externally stopped Node.js Relay service.
//! Incomplete provider transports remain fail-closed, never simulated.
use agents_relay_rust2::{
    relayd::{run_daemon,DaemonConfig},
    relayd_sqlite_observer::ReadOnlySQLiteHost,
    relayd_sqlite_write::IsolatedSQLiteWriteHost,
    reconciler::Reconciler,
    relayd_main::run_relayd_main,
};
use serde_json::json;
use std::{path::Path,sync::atomic::{AtomicBool,Ordering}};
use std::os::fd::AsRawFd;
static STOP:AtomicBool=AtomicBool::new(false);
extern "C" fn stop_signal(_:libc::c_int){STOP.store(true,Ordering::Release);}
fn main(){
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if let Err(error)=agents_relay_rust2::cli_option_contract::validate_daemon_options(&args){
        eprintln!("{error}");
        std::process::exit(1);
    }
    if args.iter().any(|arg|matches!(arg.as_str(),"--help"|"-h")){
        println!("agents-relayd-rust (native Relay daemon)\n  --live-store-dir /absolute/canonical/live/stores (exclusive writable production owner)\n  --isolated-store-dir /absolute/path/to/stores (read-only)\n  --shadow-live-store-dir /absolute/path/to/live/stores (strictly read-only, explicit opt-in)\n  --isolated-write-store-dir /absolute/path/to/stores (SQLite/Graph isolated mutations)\n  --event-history-api http://127.0.0.1:PORT/ (explicit read-only loopback Events Bus history, write mode only)\n  --trust-isolated-model-events (opt-in caller-owned loopback events as Graph-verified Worker ingress)\n  --isolated-nats-url nats://127.0.0.1:PORT/ (optional caller-owned isolated NATS subscriber, requires trust flag)\n  --isolated-nats-token-file /absolute/path/to/store/token (0600 isolated loopback authentication only)\n  --model-nats-url nats://127.0.0.1:PORT/ (explicit live NATS)\n  --model-nats-token-file /absolute/path/to/store/token\n  --trust-model-events (explicit Graph-fenced ingress)\n  --port N\n  --interval MS\nLive mode requires Node stopped and exclusive SQLite ownership. No Node fallback.");
        return;
    }
    if args.first().is_some_and(|a|a=="--version"){
        println!("agents-relayd-rust {} (native SQLite/Graph daemon)",env!("CARGO_PKG_VERSION"));
        return;
    }
    // The original Node relayd-main entrypoint forwards the complete argv
    // to one daemon owner and maps rejected startup to a nonzero exit.
    // A synchronous native daemon is Ready on its one-shot Future; no
    // second worker/executor or process is ever spawned here.
    let run=run_relayd_main(args,|argv|async move{execute(&argv)});
    let mut run=std::pin::pin!(run);
    let exit=loop{
        let mut ctx=std::task::Context::from_waker(std::task::Waker::noop());
        match std::future::Future::poll(run.as_mut(),&mut ctx){
            std::task::Poll::Ready(exit)=>break exit,
            std::task::Poll::Pending=>std::thread::yield_now(),
        }
    };
    if exit!=0{std::process::exit(exit);}

}
fn execute(args:&[String])->Result<(),String>{
    let arg=|name:&str|args.iter().position(|v|v==name)
        .and_then(|i|args.get(i+1)).map(String::as_str).unwrap_or("");
    let isolated_write=!arg("--isolated-write-store-dir").is_empty();
    let live_write=!arg("--live-store-dir").is_empty();
    let writable=isolated_write||live_write;
    let shadow_live=args.iter().any(|flag|flag=="--shadow-live-store-dir");
    // The operator configures the native Codex executable; the verified
    // Job project root, not a parallel repository allowlist, scopes execution.
    let codex_exec_env=std::env::var("AGENTS_RELAY_LIVE_CODEX_EXECUTABLE")
        .unwrap_or_default();
    let codex_exec=if !arg("--live-codex-executable").is_empty(){
        arg("--live-codex-executable")
    }else{&codex_exec_env};
    let live_codex=args.iter().any(|flag|flag=="--live-codex-executable")
        ||!codex_exec_env.is_empty();
    let trust_events=if live_write{
        args.iter().any(|flag|flag=="--trust-model-events")
    }else{
        args.iter().any(|flag|flag=="--trust-isolated-model-events")
    };
    let nats=if live_write{arg("--model-nats-url")}
        else{arg("--isolated-nats-url")};
    let nats_token_file=if live_write{arg("--model-nats-token-file")}
        else{arg("--isolated-nats-token-file")};
    if live_write&&args.iter().any(|flag|matches!(flag.as_str(),
        "--trust-isolated-model-events"|"--isolated-nats-url"
        |"--isolated-nats-token-file")){
        return Err("Live Rust EventBus must use live-only flags".into());
    }
    if !live_write&&args.iter().any(|flag|matches!(flag.as_str(),
        "--trust-model-events"|"--model-nats-url"|"--model-nats-token-file"
        |"--live-codex-executable")){
        return Err("Live Model/EventBus options require --live-store-dir".into());
    }
    if live_codex&&(!live_write||codex_exec.is_empty()
        ||!trust_events||nats.is_empty()){
        return Err("Live non-browser Codex Worker requires --live-store-dir, an explicit absolute executable, and trusted NATS Events Bus".into());
    }
    let store_mode_count=(isolated_write as u8)
        +(live_write as u8)
        +(!arg("--isolated-store-dir").is_empty() as u8)
        +(shadow_live as u8);
    if store_mode_count==0 {
        return Err("Native daemon requires --live-store-dir, --isolated-store-dir, --isolated-write-store-dir or --shadow-live-store-dir pointing to an existing absolute directory".into());
    }
    if store_mode_count!=1 {
        return Err("Select exactly one native daemon store mode".into());
    }
    if shadow_live&&(arg("--shadow-live-store-dir").is_empty()
        || args.iter().any(|flag|matches!(flag.as_str(),
            "--trust-isolated-model-events"|"--isolated-nats-token-file"
            |"--isolated-nats-url"|"--event-history-api"
            |"--live-codex-executable"))){
        return Err("Production shadow is read-only and cannot attach EventBus or Worker inputs".into());
    }
    if args.iter().any(|value|value=="--event-history-api")
        &&arg("--event-history-api").is_empty(){
        return Err("--event-history-api requires an explicit loopback HTTP URL".into());
    }
    let store=if shadow_live{arg("--shadow-live-store-dir")}
        else if live_write{arg("--live-store-dir")}
        else if isolated_write{arg("--isolated-write-store-dir")}
        else{arg("--isolated-store-dir")};
    if !writable&&!arg("--event-history-api").is_empty(){
        return Err("Read-only daemon does not permit external event history provider bindings".into());
    }
    if !writable&&!nats.is_empty(){
        return Err("Read-only daemon does not permit isolated NATS source".into());
    }
    if args.iter().any(|flag|flag==
        if live_write{"--model-nats-token-file"}else{"--isolated-nats-token-file"})
        &&(nats_token_file.is_empty()||nats.is_empty()||!writable){
        return Err("Model NATS token file requires writable mode and explicit NATS URL".into());
    }
    if !nats.is_empty()&&!trust_events{
        return Err("Model NATS requires the matching explicit trusted Events Bus flag".into());
    }
    if store.is_empty()||!Path::new(store).is_absolute()||!Path::new(store).is_dir(){
        return Err("Native daemon requires --live-store-dir, --isolated-store-dir, --isolated-write-store-dir or --shadow-live-store-dir pointing to an existing absolute directory".into());
    }
    // A transient staging directory is not allowed to resolve to the user's
    // live relay.sqlite even if a symlink or renamed path was provided.
    let canonical=std::fs::canonicalize(store).map_err(|e|e.to_string())?;
    let live=agents_relay_rust2::relay_store::relay_store_directory();
    let live_canonical=std::fs::canonicalize(&live).ok();
    if shadow_live || live_write {
        if live_canonical.as_deref()!=Some(canonical.as_path()){
            return Err("Live Rust store must exactly match the configured production Relay store".into());
        }
        let database=agents_relay_rust2::relay_store_discovery::relay_unified_store_path(&canonical);
        let metadata=std::fs::symlink_metadata(&database)
            .map_err(|_|"Live Rust store requires an existing unified SQLite database")?;
        if !metadata.is_file()||metadata.file_type().is_symlink(){
            return Err("Live Rust store requires a regular non-symlink SQLite database".into());
        }
        // A shadow never writes. A live writer must acquire the exclusive
        // Rust owner lock BEFORE opening WAL-mode SQLite read/write, because
        // a clean Node shutdown may remove -wal/-shm sidecars. Opening a
        // fresh WAL copy strictly READ_ONLY can fail despite valid contents.
        if shadow_live{
            rusqlite::Connection::open_with_flags(
                &database,rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                .map_err(|e|format!("Cannot open read-only shadow SQLite: {e}"))?;
        }
    }else if live_canonical.as_deref()==Some(canonical.as_path()){
        return Err("Refusing to run the native preview on the live Relay store".into());
    }
    let database=agents_relay_rust2::relay_store_discovery::relay_unified_store_path(&canonical);
    let live_database=agents_relay_rust2::relay_store_discovery::relay_unified_store_path(&live);
    if isolated_write {
        for suffix in ["", "-wal", "-shm", "-journal"] {
            let selected=database.with_file_name(format!("relay.sqlite{suffix}"));
            if !selected.exists() && !selected.is_symlink(){continue;}
            let meta=std::fs::symlink_metadata(&selected).map_err(|e|e.to_string())?;
            if meta.file_type().is_symlink(){
                return Err("Refusing native isolated writes through a linked SQLite database".into());
            }
            let live_file=live_database.with_file_name(format!("relay.sqlite{suffix}"));
            if let (Ok(selected_meta),Ok(live_meta))=(
                std::fs::metadata(&selected),std::fs::metadata(&live_file)){
                // Hard links share the same inode even with different paths;
                // protect the database and WAL/journal components alike.
                #[cfg(unix)] {
                    use std::os::unix::fs::MetadataExt;
                    if selected_meta.dev()==live_meta.dev()
                        &&selected_meta.ino()==live_meta.ino(){
                        return Err("Refusing native isolated writes to the live SQLite database".into());
                    }
                }
            }
        }
    }
    // A real live daemon must be the *only* native writer; hold this advisory
    // OS lock for the full process lifetime. PM2's old Node service must
    // additionally be stopped (Node does not understand this Rust lock).
    let _live_owner_lock=if live_write{
        let path=canonical.join("relayd-rust-owner.lock");
        if path.is_symlink(){
            return Err("Live owner lock cannot be a symlink".into());
        }
        let file=std::fs::OpenOptions::new().read(true).write(true)
            .create(true).open(&path)
            .map_err(|e|format!("Cannot open live Rust owner lock: {e}"))?;
        if unsafe{libc::flock(file.as_raw_fd(),libc::LOCK_EX|libc::LOCK_NB)}!=0{
            return Err("Another Rust process already owns the production Relay store".into());
        }
        Some(file)
    }else{None};
    if live_write {
        let db=rusqlite::Connection::open_with_flags(
            &database,rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE)
            .map_err(|e|format!("Cannot open owned canonical WAL SQLite: {e}"))?;
        let integrity:String=db.query_row("PRAGMA quick_check",[],|row|row.get(0))
            .map_err(|e|format!("Owned SQLite integrity preflight: {e}"))?;
        if integrity!="ok"{
            return Err("Owned SQLite integrity check failed; refusing live writer".into());
        }
        // The native writable host is constructed only after this invariant
        // and the process-wide owner lock are both established.
    }
    let cwd=std::env::current_dir().map_err(|e|e.to_string())?;
    // In production, resolve the operator's actual Codex profiles and Relay
    // routing policy. Relative .codex/.agents-relay paths under the daemon
    // checkout silently fall back to an invented default model.
    // Disposable isolated daemons retain fixture-scoped relative defaults.
    let home=std::env::var_os("HOME").map(std::path::PathBuf::from)
        .unwrap_or_else(||cwd.clone());
    let config_home=if live_write{
        agents_relay_rust2::model_routing::default_codex_home()
    }else{cwd.join(".codex")};
    let router_home=if live_write{home}else{cwd.clone()};
    let resources=if live_write {agents_relay_rust2::runtime_resources::package_root()?} else {cwd.clone()};
    let options=json!({
        "storeDirectory":canonical,"graphDirectory":resources.join("workflow"),
        "dashboardAsset":resources.join("dashboard/index.html"),
        "codexHome":config_home,
        "routingPolicyPath":router_home.join(".agents-relay/routing-policy.json"),
        "routerRulesPath":router_home.join(".agents-relay/execution-router-rules.md"),
    });
    let config=DaemonConfig::from_argv(args,&options)?;
    unsafe{
        libc::signal(libc::SIGTERM,stop_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT,stop_signal as *const () as libc::sighandler_t);
    }
    eprintln!("Native Relay {} observer on 127.0.0.1:{}",
        if shadow_live{"production shadow read-only"}
        else if live_write{"live writable"}else if writable{"isolated write"}else{"isolated read-only"},config.port);
    if writable{
        // This is the original production Reconciler Graph, not a fake timer
        // that directly edits Task status. Worker effects remain explicitly
        // unbound until a lifecycle-owned process/provider adapter is proven.
        let runtime=config.clone();
        let mut host=if live_write{
            IsolatedSQLiteWriteHost::new_live(config.clone())
        }else{IsolatedSQLiteWriteHost::new(config.clone())};
        let history=arg("--event-history-api");
        if !history.is_empty(){
            host.set_loopback_event_history_api(history)?;
        }
        if !nats.is_empty(){
            let token_file=nats_token_file;
            let token=if token_file.is_empty(){None}else{
                let provided=Path::new(token_file);
                if !provided.is_absolute(){
                    return Err("Isolated NATS token file requires an absolute path".into());
                }
                let metadata=std::fs::symlink_metadata(provided)
                    .map_err(|_|"Cannot read isolated NATS token file metadata")?;
                if !metadata.is_file() || metadata.file_type().is_symlink() {
                    return Err("Isolated NATS token file must be a regular non-symlink file".into());
                }
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    if metadata.permissions().mode() & 0o077 != 0 {
                        return Err("Isolated NATS token file must have mode 0600 or stricter".into());
                    }
                }
                let path=std::fs::canonicalize(provided)
                    .map_err(|_|"Cannot resolve isolated NATS token file")?;
                if !path.starts_with(&canonical){
                    return Err("Isolated NATS token file must be inside its caller-owned store".into());
                }
                if metadata.len()==0 || metadata.len()>4096 {
                    return Err("Isolated NATS token file length must be 1..4096 bytes".into());
                }
                let secret=std::fs::read_to_string(provided)
                    .map_err(|_|"Cannot read isolated NATS token file")?;
                Some(secret)
            };
            host.set_loopback_model_nats_with_token(nats,token.as_deref())?;
        }
        if trust_events{
            host.enable_isolated_model_event_ingress()?;
        }
        if live_codex{
            host.set_live_codex_executable(codex_exec)?;
        }
        run_daemon(config.clone(),host,&STOP,move |_|{
            Ok(Reconciler::new(
                runtime.graph_directory.clone(),runtime.store_directory.clone(),
                runtime.profile_home.clone(),runtime.policy_path.clone(),
                runtime.router_rules_path.clone(),
                json!({"owner":format!("{}-rust-daemon-{}",
                        if live_write{"live"}else{"isolated"},std::process::id()),
                    "maxConcurrent":runtime.concurrency,
                    "noGitHub":true,"productionReady":false,
                    "decisionMode":if live_write{agents_relay_rust2::decision::decision_mode()}else{"off"},
                    "useDecisionEngine":live_write,"recordDecisionAudit":live_write})
            ))
        })
    }else{
        let host=if shadow_live{
            ReadOnlySQLiteHost::new_live_shadow(config.clone())
        }else{ReadOnlySQLiteHost::new(config.clone())};
        run_daemon(config,host,&STOP,|_|{
            Err("Native read-only daemon: production Job reconciliation disabled".into())
        })
    }
}
