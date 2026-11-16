//! Experimental native Relay daemon: explicitly marked temporary SQLite only.
//! No production switch. --once and --loop run the same Graph/SQLite tick.
#[cfg(unix)]
use agents_relay_rust::native_daemon::NativeControlLoop;
use agents_relay_rust::native_daemon::NativeDaemonOptions;
use agents_relay_rust::single_node::SingleNodeDaemon;
use serde_json::json;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
fn opt(args: &[String], name: &str) -> Result<String, String> {
    let i = args
        .iter()
        .position(|a| a == name)
        .ok_or_else(|| format!("missing {name}"))?;
    args.get(i + 1)
        .cloned()
        .ok_or_else(|| format!("missing value for {name}"))
}
fn run() -> Result<(), String> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    if !(args.contains(&"--once".into()) || args.contains(&"--loop".into()))
        || (args.contains(&"--once".into()) && args.contains(&"--loop".into()))
    {
        return Err("usage: relay-native-daemon --once|--loop --db ABSOLUTE --manifest ABSOLUTE --helper ABSOLUTE [--interval-ms N]".into());
    }
    let options = NativeDaemonOptions {
        db: PathBuf::from(opt(&args, "--db")?),
        manifest: PathBuf::from(opt(&args, "--manifest")?),
        helper: PathBuf::from(opt(&args, "--helper")?),
        max_tasks: opt(&args, "--max-tasks")
            .unwrap_or_else(|_| "20".into())
            .parse::<usize>()
            .map_err(|e| e.to_string())?,
    };
    let repeat = args.contains(&"--loop".into());
    let interval = opt(&args, "--interval-ms")
        .unwrap_or_else(|_| "1000".into())
        .parse::<u64>()
        .map_err(|e| e.to_string())?;
    if !(100..=300_000).contains(&interval) {
        return Err("interval-ms must be 100..300000".into());
    }
    let stopped = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&stopped))
        .map_err(|e| e.to_string())?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&stopped))
        .map_err(|e| e.to_string())?;
    let publish_port = if args.contains(&"--nats-port".to_string()) {
        let parsed = opt(&args, "--nats-port")?
            .parse::<u16>()
            .map_err(|e| e.to_string())?;
        if parsed == 0 {
            return Err("NATS port must be nonzero".into());
        }
        Some(parsed)
    } else {
        None
    };
    let ingress_port = if args.contains(&"--nats-ingress-port".to_string()) {
        let parsed = opt(&args, "--nats-ingress-port")?
            .parse::<u16>()
            .map_err(|e| e.to_string())?;
        if parsed == 0 || !repeat {
            return Err("--nats-ingress-port requires --loop and a nonzero port".into());
        }
        Some(parsed)
    } else {
        None
    };
    let db = options.db.clone();
    let daemon = SingleNodeDaemon::acquire(options)?;
    #[cfg(unix)]
    let _control = if repeat {
        Some(NativeControlLoop::bind(&db)?)
    } else {
        None
    };
    let ingress = ingress_port.map(|port| {
        let path = db.clone();
        let stopped = Arc::clone(&stopped);
        thread::spawn(move || {
            agents_relay_rust::native_ingress::run_nats_ingress(path, port, stopped)
        })
    });
    loop {
        if stopped.load(Ordering::SeqCst) {
            break;
        }
        let report = daemon.tick(Arc::clone(&stopped))?;
        let published = if let Some(port) = publish_port {
            let mut authority = agents_relay_rust::authority::RelayAuthority::open_existing(&db)?;
            agents_relay_rust::native_outbox::publish_pending(&mut authority, port)?
        } else {
            0
        };
        println!(
            "{}",
            json!({"type":"tick","report":report,"eventsPublished":published})
        );
        if !repeat {
            break;
        }
        let parts = interval.div_ceil(100);
        for _ in 0..parts {
            if stopped.load(Ordering::SeqCst) {
                break;
            }
            thread::sleep(Duration::from_millis(100.min(interval)));
        }
    }
    if let Some(ingress) = ingress {
        let _ = ingress.join();
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() {
        eprintln!("relay-native-daemon: {error}");
        std::process::exit(2);
    }
}
