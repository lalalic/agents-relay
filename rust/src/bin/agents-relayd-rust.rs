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
        println!("agents-relayd-rust (isolated preview)\n  --isolated-store-dir /absolute/path/to/stores (read-only)\n  --isolated-write-store-dir /absolute/path/to/stores (SQLite/Graph isolated mutations)\n  --port N\n  --interval MS\nNo production Workers or live state. No Node fallback.");
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
    let store=if writable{arg("--isolated-write-store-dir")}else{arg("--isolated-store-dir")};
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
        run_daemon(config.clone(),IsolatedSQLiteWriteHost::new(config),&STOP,move |_|{
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
