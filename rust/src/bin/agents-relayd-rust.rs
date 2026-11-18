//! Runnable, explicitly isolated native Rust daemon observer. The main
//! production daemon is NOT cut over: this binary requires a caller-owned
//! SQLite directory and refuses mutation/Worker launches rather than falsely
//! claiming graph-driven production parity with Node.
use agents_relay_rust2::{
    relayd::{run_daemon,DaemonConfig},
    relayd_sqlite_observer::ReadOnlySQLiteHost,
};
use serde_json::json;
use std::{path::Path,sync::atomic::{AtomicBool,Ordering}};
static STOP:AtomicBool=AtomicBool::new(false);
extern "C" fn stop_signal(_:libc::c_int){STOP.store(true,Ordering::Release);}
fn main(){
    let args=std::env::args().skip(1).collect::<Vec<_>>();
    if args.iter().any(|arg|matches!(arg.as_str(),"--help"|"-h")){
        println!("agents-relayd-rust (isolated read-only preview)\\n  --isolated-store-dir /absolute/path/to/stores\\n  --port N\\n  --interval MS\\nNo production Workers or writes. No Node fallback.");
        return;
    }
    if args.first().is_some_and(|a|a=="--version"){
        println!("agents-relayd-rust {} (isolated read-only preview)",env!("CARGO_PKG_VERSION"));
        return;
    }
    let result=execute(&args);
    if let Err(error)=result{
        eprintln!("{error}");
        std::process::exit(1);
    }
}
fn execute(args:&[String])->Result<(),String>{
    let arg=|name:&str|args.iter().position(|v|v==name)
        .and_then(|i|args.get(i+1)).map(String::as_str).unwrap_or("");
    let store=arg("--isolated-store-dir");
    if store.is_empty()||!Path::new(store).is_absolute()||!Path::new(store).is_dir(){
        return Err("Native daemon requires --isolated-store-dir pointing to an existing absolute caller-owned directory".into());
    }
    // A transient staging directory is not allowed to resolve to the user's
    // live relay.sqlite even if a symlink or renamed path was provided.
    let canonical=std::fs::canonicalize(store).map_err(|e|e.to_string())?;
    let live=agents_relay_rust2::relay_store::relay_store_directory();
    if std::fs::canonicalize(&live).ok().as_deref()==Some(canonical.as_path()){
        return Err("Refusing to run the native read-only preview on the live Relay store".into());
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
    eprintln!("Native Relay isolated read-only observer on 127.0.0.1:{}",config.port);
    run_daemon(config.clone(),ReadOnlySQLiteHost::new(config),&STOP,|_|{
        Err("Isolated native read-only daemon: production Job reconciliation disabled".into())
    })
}
