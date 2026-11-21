//! Runnable, explicitly isolated native Rust daemon observer. The main
//! production daemon is NOT cut over: this binary requires a caller-owned
//! SQLite directory and refuses mutation/Worker launches rather than falsely
//! claiming graph-driven production parity with Node.
use agents_relay_rust2::{
    relayd::{run_daemon,DaemonConfig},
    relayd_sqlite_observer::ReadOnlySQLiteHost,
    relayd_sqlite_write::IsolatedSQLiteWriteHost,
    reconciler::Reconciler,
    relayd_main::run_relayd_main,
};
use serde_json::json;
use std::{path::Path,sync::atomic::{AtomicBool,Ordering}};
static STOP:AtomicBool=AtomicBool::new(false);
extern "C" fn stop_signal(_:libc::c_int){STOP.store(true,Ordering::Release);}
fn main(){
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg|matches!(arg.as_str(),"--help"|"-h")){
        println!("agents-relayd-rust (isolated preview)\n  --isolated-store-dir /absolute/path/to/stores (read-only)\n  --isolated-write-store-dir /absolute/path/to/stores (SQLite/Graph isolated mutations)\n  --event-history-api http://127.0.0.1:PORT/ (explicit read-only loopback Events Bus history, write mode only)\n  --trust-isolated-model-events (opt-in caller-owned loopback events as Graph-verified Worker ingress)\n  --isolated-nats-url nats://127.0.0.1:PORT/ (optional caller-owned isolated NATS subscriber, requires trust flag)\n  --isolated-nats-token-file /absolute/path/to/store/token (0600 isolated loopback authentication only)\n  --port N\n  --interval MS\nNo production Workers or live state. No Node fallback.");
        return;
    }
    if args.first().is_some_and(|a|a=="--version"){
        println!("agents-relayd-rust {} (isolated read-only preview)",env!("CARGO_PKG_VERSION"));
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
    let writable=!arg("--isolated-write-store-dir").is_empty();
    if writable&&!arg("--isolated-store-dir").is_empty(){
        return Err("Select exactly one isolated daemon store mode".into());
    }
    if args.iter().any(|value|value=="--event-history-api")
        &&arg("--event-history-api").is_empty(){
        return Err("--event-history-api requires an explicit loopback HTTP URL".into());
    }
    let store=if writable{arg("--isolated-write-store-dir")}else{arg("--isolated-store-dir")};
    if !writable&&!arg("--event-history-api").is_empty(){
        return Err("Read-only daemon does not permit external event history provider bindings".into());
    }
    if !writable&&!arg("--isolated-nats-url").is_empty(){
        return Err("Read-only daemon does not permit isolated NATS source".into());
    }
    if args.iter().any(|flag|flag=="--isolated-nats-token-file") &&
       (arg("--isolated-nats-token-file").is_empty()
        || arg("--isolated-nats-url").is_empty() || !writable) {
        return Err("Isolated NATS token file requires writable mode and explicit NATS URL".into());
    }
    if !arg("--isolated-nats-url").is_empty()
        &&!args.iter().any(|arg|arg=="--trust-isolated-model-events"){
        return Err("Isolated model NATS requires --trust-isolated-model-events".into());
    }
    if store.is_empty()||!Path::new(store).is_absolute()||!Path::new(store).is_dir(){
        return Err("Native daemon requires --isolated-store-dir pointing to an existing absolute caller-owned directory".into());
    }
    // A transient staging directory is not allowed to resolve to the user's
    // live relay.sqlite even if a symlink or renamed path was provided.
    let canonical=std::fs::canonicalize(store).map_err(|e|e.to_string())?;
    let live=agents_relay_rust2::relay_store::relay_store_directory();
    if std::fs::canonicalize(&live).ok().as_deref()==Some(canonical.as_path()){
        return Err("Refusing to run the native preview on the live Relay store".into());
    }
    let database=agents_relay_rust2::relay_store_discovery::relay_unified_store_path(&canonical);
    let live_database=agents_relay_rust2::relay_store_discovery::relay_unified_store_path(&live);
    if writable {
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
    let cwd=std::env::current_dir().map_err(|e|e.to_string())?;
    let options=json!({
        "storeDirectory":canonical,"graphDirectory":cwd.join("workflow"),
        "dashboardAsset":cwd.join("dashboard/index.html"),
    });
    let config=DaemonConfig::from_argv(args,&options)?;
    unsafe{
        libc::signal(libc::SIGTERM,stop_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGINT,stop_signal as *const () as libc::sighandler_t);
    }
    eprintln!("Native Relay isolated {} observer on 127.0.0.1:{}",if writable{"write"}else{"read-only"},config.port);
    if writable{
        // This is the original production Reconciler Graph, not a fake timer
        // that directly edits Task status. Worker effects remain explicitly
        // unbound until a lifecycle-owned process/provider adapter is proven.
        let runtime=config.clone();
        let mut host=IsolatedSQLiteWriteHost::new(config.clone());
        let history=arg("--event-history-api");
        if !history.is_empty(){
            host.set_loopback_event_history_api(history)?;
        }
        let nats=arg("--isolated-nats-url");
        if !nats.is_empty(){
            let token_file=arg("--isolated-nats-token-file");
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
        if args.iter().any(|arg|arg=="--trust-isolated-model-events"){
            host.enable_isolated_model_event_ingress()?;
        }
        run_daemon(config.clone(),host,&STOP,move |_|{
            Ok(Reconciler::new(
                runtime.graph_directory.clone(),runtime.store_directory.clone(),
                runtime.profile_home.clone(),runtime.policy_path.clone(),
                runtime.router_rules_path.clone(),
                json!({"owner":format!("isolated-rust-daemon-{}",std::process::id()),
                    "maxConcurrent":runtime.concurrency,"leaseMs":runtime.lease_ms,
                    "noGitHub":true,"productionReady":false})
            ))
        })
    }else{
        run_daemon(config.clone(),ReadOnlySQLiteHost::new(config),&STOP,|_|{
            Err("Isolated native read-only daemon: production Job reconciliation disabled".into())
        })
    }
}
