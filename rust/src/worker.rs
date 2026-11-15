//! Native Worker process execution primitive. No Relay workflow policy here:
//! Graph/SQLite own whether a worker is launched; this module owns only OS
//! process groups, output streams, cancellation, timeouts and exit facts.
use nix::sys::signal::{killpg, Signal};
use nix::unistd::Pid;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::OpenOptions;
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

pub struct WorkerSpec {
    /// An absolute executable is mandatory, avoiding PATH or shell injection.
    pub executable: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// Explicit environment. Inherited credentials are never forwarded by default.
    pub env: BTreeMap<String, String>,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
    pub timeout: Duration,
    pub terminate_grace: Duration,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerResult {
    pub pid: u32,
    pub exit_code: Option<i32>,
    pub signal: Option<i32>,
    pub timed_out: bool,
    pub cancelled: bool,
    pub elapsed_ms: u128,
    pub stdout: PathBuf,
    pub stderr: PathBuf,
}

/// A parent/daemon that cannot persist the real process identity must return
/// an error in `on_started`; we kill the exact child process group before
/// returning instead of allowing an untracked worker to continue running.
pub fn run_worker<F>(
    spec: &WorkerSpec,
    cancelled: &AtomicBool,
    on_started: F,
) -> Result<WorkerResult, String>
where
    F: FnOnce(u32) -> Result<(), String>,
{
    run_worker_with_activity(spec, cancelled, on_started, || Ok(None))
}

/// Execute with an optional durable activity timestamp. Newer timestamps move
/// the inactivity deadline to `activity + timeout`; receipts and local wakeups
/// are deliberately not inputs to this effect.
pub fn run_worker_with_activity<F, A>(
    spec: &WorkerSpec,
    cancelled: &AtomicBool,
    on_started: F,
    mut activity_at: A,
) -> Result<WorkerResult, String>
where
    F: FnOnce(u32) -> Result<(), String>,
    A: FnMut() -> Result<Option<SystemTime>, String>,
{
    if !spec.executable.is_absolute() || !spec.cwd.is_absolute() {
        return Err("absolute executable and cwd required".into());
    }
    if !spec.cwd.is_dir() || !spec.executable.is_file() {
        return Err("worker executable or cwd missing".into());
    }
    let output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&spec.stdout)
        .map_err(|e| format!("stdout log: {e}"))?;
    let errors = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&spec.stderr)
        .map_err(|e| format!("stderr log: {e}"))?;
    // The child becomes the leader of its own process group. A timed out
    // command and all its descendants are signalled together.
    let mut cmd = Command::new(&spec.executable);
    cmd.args(&spec.args)
        .current_dir(&spec.cwd)
        .env_clear()
        .envs(&spec.env)
        .stdin(Stdio::null())
        .stdout(Stdio::from(output))
        .stderr(Stdio::from(errors))
        .process_group(0);
    let started_at = Instant::now();
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("worker spawn failed: {e}"))?;
    let pid = child.id();
    let group = Pid::from_raw(i32::try_from(pid).map_err(|_| "invalid child PID")?);
    if let Err(error) = on_started(pid) {
        terminate_group(&mut child, group, spec.terminate_grace)?;
        return Err(format!("worker identity registration failed: {error}"));
    }
    let mut timed_out = false;
    let mut was_cancelled = false;
    let mut deadline = started_at + spec.timeout;
    let mut last_activity = None;
    let status = loop {
        if let Some(status) = child
            .try_wait()
            .map_err(|e| format!("worker wait failed: {e}"))?
        {
            // Normal exit is not permission for a worker's background child
            // processes to survive. The worker owns this exact process group.
            // A group without members returns ESRCH; no process-name matching.
            if let Err(error) = killpg(group, Signal::SIGTERM) {
                if error != nix::errno::Errno::ESRCH {
                    return Err(format!("worker group cleanup failed: {error}"));
                }
            }
            // A background process may ignore SIGTERM. Since the group
            // belongs exclusively to this just-finished Worker, clean it now.
            let _ = killpg(group, Signal::SIGKILL);
            break status;
        }
        if cancelled.load(Ordering::SeqCst) {
            was_cancelled = true;
            break terminate_group(&mut child, group, spec.terminate_grace)?;
        }
        let activity = match activity_at() {
            Ok(activity) => activity,
            Err(error) => {
                return match terminate_group(&mut child, group, spec.terminate_grace) {
                    Ok(_) => Err(error),
                    Err(cleanup) => Err(format!("{error}; Worker cleanup failed: {cleanup}")),
                };
            }
        };
        if let Some(activity) = activity {
            if last_activity.is_none_or(|previous| activity > previous) {
                let activity_deadline = activity
                    .checked_add(spec.timeout)
                    .ok_or("Worker activity deadline overflow")?;
                deadline = Instant::now()
                    + activity_deadline
                        .duration_since(SystemTime::now())
                        .unwrap_or(Duration::ZERO);
                last_activity = Some(activity);
            }
        }
        if Instant::now() >= deadline {
            timed_out = true;
            break terminate_group(&mut child, group, spec.terminate_grace)?;
        }
        thread::sleep(Duration::from_millis(20));
    };
    Ok(WorkerResult {
        pid,
        exit_code: status.code(),
        signal: status.signal(),
        timed_out,
        cancelled: was_cancelled,
        elapsed_ms: started_at.elapsed().as_millis(),
        stdout: spec.stdout.clone(),
        stderr: spec.stderr.clone(),
    })
}

fn terminate_group(
    child: &mut std::process::Child,
    group: Pid,
    grace: Duration,
) -> Result<std::process::ExitStatus, String> {
    let result = killpg(group, Signal::SIGTERM);
    if let Err(error) = result {
        if error != nix::errno::Errno::ESRCH {
            return Err(format!("worker process group termination failed: {error}"));
        }
    }
    let deadline = Instant::now() + grace;
    while Instant::now() < deadline {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            // The group leader may have exited while a grandchild survived.
            // Always send a final group signal for the remaining generation.
            let _ = killpg(group, Signal::SIGKILL);
            return Ok(status);
        }
        thread::sleep(Duration::from_millis(15));
    }
    let _ = killpg(group, Signal::SIGKILL);
    child.wait().map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::Arc;
    fn spec(root: &std::path::Path, name: &str, code: &str, timeout: Duration) -> WorkerSpec {
        WorkerSpec {
            executable: PathBuf::from("/bin/sh"),
            args: vec!["-c".into(), code.into()],
            cwd: root.to_path_buf(),
            env: BTreeMap::from([("PATH".into(), "/usr/bin:/bin".into())]),
            stdout: root.join(format!("{name}.stdout")),
            stderr: root.join(format!("{name}.stderr")),
            timeout,
            terminate_grace: Duration::from_millis(70),
        }
    }
    #[test]
    fn real_worker_streams_stdout_stderr_and_exit_status() {
        let folder = tempfile::tempdir().unwrap();
        let program = spec(
            folder.path(),
            "good",
            "printf hello; printf warning >&2; exit 7",
            Duration::from_secs(3),
        );
        let cancelled = AtomicBool::new(false);
        let mut captured = None;
        let result = run_worker(&program, &cancelled, |pid| {
            captured = Some(pid);
            Ok(())
        })
        .unwrap();
        assert_eq!(captured, Some(result.pid));
        assert_eq!(result.exit_code, Some(7));
        assert!(!result.timed_out && !result.cancelled);
        assert_eq!(fs::read(&program.stdout).unwrap(), b"hello");
        assert_eq!(fs::read(&program.stderr).unwrap(), b"warning");
    }
    #[test]
    fn real_worker_times_out_and_terminates_process_group() {
        let folder = tempfile::tempdir().unwrap();
        let program = spec(
            folder.path(),
            "timeout",
            "sleep 3 & wait",
            Duration::from_millis(100),
        );
        let result = run_worker(&program, &AtomicBool::new(false), |_| Ok(())).unwrap();
        assert!(result.timed_out);
        assert!(result.elapsed_ms < 2500);
    }
    #[test]
    fn accepted_durable_activity_renews_deadline_without_changing_group_cleanup() {
        use std::sync::{Arc, Mutex};
        use std::time::SystemTime;

        let folder = tempfile::tempdir().unwrap();
        let program = spec(
            folder.path(),
            "renewed",
            "sleep 0.30",
            Duration::from_millis(250),
        );
        let activity = Arc::new(Mutex::new(None));
        let writer = Arc::clone(&activity);
        let update = thread::spawn(move || {
            thread::sleep(Duration::from_millis(140));
            *writer.lock().unwrap() = Some(SystemTime::now());
        });
        let result = run_worker_with_activity(
            &program,
            &AtomicBool::new(false),
            |_| Ok(()),
            || Ok(*activity.lock().unwrap()),
        )
        .unwrap();
        update.join().unwrap();
        assert!(
            !result.timed_out,
            "new accepted activity should renew inactivity deadline"
        );
        assert_eq!(result.exit_code, Some(0));
        assert!(result.elapsed_ms >= 250);
    }
    #[test]
    fn activity_reader_failure_terminates_the_exact_worker_group() {
        let folder = tempfile::tempdir().unwrap();
        let pid_file = folder.path().join("child.pid");
        let program = spec(
            folder.path(),
            "reader-error",
            &format!("sleep 5 & echo $! > {}; wait", pid_file.display()),
            Duration::from_secs(3),
        );
        let error = run_worker_with_activity(
            &program,
            &AtomicBool::new(false),
            |_| Ok(()),
            || {
                thread::sleep(Duration::from_millis(50));
                Err("durable activity read failed".into())
            },
        )
        .unwrap_err();
        assert!(error.contains("durable activity read failed"));
        let pid = fs::read_to_string(pid_file)
            .unwrap()
            .trim()
            .parse::<u32>()
            .unwrap();
        let status = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "stat="])
            .output()
            .unwrap();
        let state = String::from_utf8(status.stdout).unwrap();
        assert!(state.trim().is_empty() || state.trim().starts_with('Z'));
    }
    #[test]
    fn real_worker_cancellation_and_failed_registration_stop_child() {
        let folder = tempfile::tempdir().unwrap();
        let flag = Arc::new(AtomicBool::new(false));
        let to_set = Arc::clone(&flag);
        let notifier = thread::spawn(move || {
            thread::sleep(Duration::from_millis(85));
            to_set.store(true, Ordering::SeqCst);
        });
        let program = spec(folder.path(), "cancel", "sleep 3", Duration::from_secs(10));
        let result = run_worker(&program, &flag, |_| Ok(())).unwrap();
        notifier.join().unwrap();
        assert!(result.cancelled && !result.timed_out);
        assert!(result.elapsed_ms < 2500);
        let fail_spec = spec(
            folder.path(),
            "badstart",
            "sleep 3",
            Duration::from_secs(10),
        );
        assert!(run_worker(&fail_spec, &AtomicBool::new(false), |_| {
            Err("cannot write process ledger".into())
        })
        .unwrap_err()
        .contains("identity registration failed"));
    }
}
