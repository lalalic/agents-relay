//! Small native worker owner. Parent death or stdin disconnect cancels the
//! process group. The worker's stdout/stderr go directly to separate log files.
//! Protocol is newline-delimited JSON over helper stdout and stdin.
use agents_relay_rust::worker::{run_worker, WorkerSpec};
use nix::unistd::getppid;
use serde::Deserialize;
use serde_json::json;
use std::collections::BTreeMap;
use std::io::{self, BufRead, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::thread;
use std::time::Duration;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    parent_pid: u32,
    executable: PathBuf,
    args: Vec<String>,
    cwd: PathBuf,
    env: BTreeMap<String, String>,
    stdout: PathBuf,
    stderr: PathBuf,
    timeout_ms: u64,
    terminate_grace_ms: u64,
}
fn publish(message: serde_json::Value) -> Result<(), String> {
    let mut out = io::stdout().lock();
    writeln!(out, "{message}").map_err(|e| e.to_string())?;
    out.flush().map_err(|e| e.to_string())
}
fn main() {
    if let Err(error) = run() {
        let _ = publish(json!({"type":"failed","error":error}));
        eprintln!("relay-worker-helper: {error}");
        std::process::exit(2);
    }
}
fn run() -> Result<(), String> {
    let mut first = String::new();
    if io::stdin()
        .read_line(&mut first)
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err("missing worker config".into());
    }
    if first.len() > 1_048_576 {
        return Err("worker config too large".into());
    }
    let config: Config = serde_json::from_str(&first).map_err(|e| e.to_string())?;
    let parent = getppid().as_raw();
    if config.parent_pid != u32::try_from(parent).map_err(|_| "invalid parent PID")? {
        return Err("parent process identity mismatch".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    signal_hook::flag::register(signal_hook::consts::SIGTERM, Arc::clone(&cancelled))
        .map_err(|e| e.to_string())?;
    signal_hook::flag::register(signal_hook::consts::SIGINT, Arc::clone(&cancelled))
        .map_err(|e| e.to_string())?;
    let parent_flag = Arc::clone(&cancelled);
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(65));
        if getppid().as_raw() != parent {
            parent_flag.store(true, Ordering::SeqCst);
            return;
        }
    });
    let (ack_sender, ack_receiver) = mpsc::channel::<String>();
    let stdin_flag = Arc::clone(&cancelled);
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(message) if message.trim() == "ack" => {
                    let _ = ack_sender.send("ack".into());
                }
                Ok(message) if message.trim() == "cancel" => {
                    stdin_flag.store(true, Ordering::SeqCst);
                    return;
                }
                _ => {
                    stdin_flag.store(true, Ordering::SeqCst);
                    return;
                }
            }
        }
        stdin_flag.store(true, Ordering::SeqCst);
    });
    let spec = WorkerSpec {
        executable: config.executable,
        args: config.args,
        cwd: config.cwd,
        env: config.env,
        stdout: config.stdout,
        stderr: config.stderr,
        timeout: Duration::from_millis(config.timeout_ms),
        terminate_grace: Duration::from_millis(config.terminate_grace_ms),
    };
    let result = run_worker(&spec, &cancelled, |pid| {
        publish(json!({"type":"started","pid":pid}))?;
        match ack_receiver.recv_timeout(Duration::from_secs(3)) {
            Ok(message) if message == "ack" && !cancelled.load(Ordering::SeqCst) => Ok(()),
            _ => Err("parent did not confirm durable launch identity".into()),
        }
    })?;
    publish(json!({"type":"finished","result":result}))
}
