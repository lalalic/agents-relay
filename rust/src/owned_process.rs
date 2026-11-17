// Direct port of Node src/owned-process.ts. Relay owns ONLY freshly spawned
// process groups, never arbitrary caller-supplied PIDs or process-name matches.
// A separate native supervisor watches its creator on parent death (Unix).
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::{
    collections::HashMap,
    io::BufRead,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TerminationReason {
    Abort,
    Cancel,
    Timeout,
    LeaderExit,
    ParentShutdown,
    Retry,
    Reconcile,
}
impl TerminationReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Abort => "abort",
            Self::Cancel => "cancel",
            Self::Timeout => "timeout",
            Self::LeaderExit => "leader-exit",
            Self::ParentShutdown => "parent-shutdown",
            Self::Retry => "retry",
            Self::Reconcile => "reconcile",
        }
    }
}
#[derive(Debug, Clone)]
pub struct OwnedProcessOptions {
    pub invocation: String,
    pub cwd: Option<PathBuf>,
    pub timeout_ms: Option<u64>,
    pub grace_ms: u64,
    /// Native companion bin path (defaults to adjacent built binary).
    pub supervisor_path: Option<PathBuf>,
}
impl Default for OwnedProcessOptions {
    fn default() -> Self {
        Self {
            invocation: "worker".into(),
            cwd: None,
            timeout_ms: None,
            grace_ms: 750,
            supervisor_path: None,
        }
    }
}
#[derive(Debug, Clone)]
pub struct OwnedProcessSnapshot {
    pub invocation_id: String,
    pub invocation: String,
    pub pid: u32,
    pub process_group: Option<u32>,
    pub elapsed_ms: u128,
}
struct Record {
    pid: u32,
    invocation_id: String,
    invocation: String,
    started: Instant,
    grace_ms: u64,
    child: Mutex<Child>,
    supervisor: Mutex<Option<Child>>,
    terminating: AtomicBool,
    reason: Mutex<Option<TerminationReason>>,
    finished: AtomicBool,
}
#[derive(Clone)]
pub struct OwnedProcess {
    inner: Arc<Record>,
}
impl OwnedProcess {
    pub fn pid(&self) -> u32 {
        self.inner.pid
    }
    pub fn termination_reason(&self) -> Option<TerminationReason> {
        *self.inner.reason.lock().expect("reason mutex")
    }
    pub fn snapshot(&self) -> OwnedProcessSnapshot {
        OwnedProcessSnapshot {
            invocation_id: self.inner.invocation_id.clone(),
            invocation: self.inner.invocation.clone(),
            pid: self.inner.pid,
            process_group: Some(self.inner.pid),
            elapsed_ms: self.inner.started.elapsed().as_millis(),
        }
    }
    pub fn finished(&self) -> bool {
        self.inner.finished.load(Ordering::Acquire)
    }
    pub fn terminate(&self, reason: TerminationReason, grace_ms: Option<u64>) {
        if self.inner.terminating.swap(true, Ordering::AcqRel) {
            return;
        }
        *self.inner.reason.lock().expect("reason mutex") = Some(reason);
        let _ = signal_record(&self.inner, libc::SIGTERM);
        let record = Arc::clone(&self.inner);
        let delay = grace_ms.unwrap_or(record.grace_ms);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(delay));
            // While descendants remain in the isolated group, leader exit alone
            // is not proof of cleanup. Force only the originally recorded group.
            let _ = signal_record(&record, libc::SIGKILL);
        });
    }
    pub fn wait_for_leader(&self, timeout: Duration) -> bool {
        let started = Instant::now();
        while started.elapsed() < timeout {
            if self.finished() {
                return true;
            }
            thread::sleep(Duration::from_millis(10));
        }
        self.finished()
    }
}
/// Fail-closed ownership fence: reject any signal outside a fresh, positive,
/// self-distinct OS process group this manager itself created.
#[cfg(unix)]
fn signal_record(record: &Record, signal: i32) -> Result<(), String> {
    let pid = i32::try_from(record.pid).map_err(|_| "invalid owned PID")?;
    if pid <= 1 || pid == std::process::id() as i32 {
        return Err("Refusing non-owned PID or own process".into());
    }
    // When the leader is alive it must still lead its original group; a
    // different PGID is proof the ownership fence is no longer valid.
    let actual = unsafe { libc::getpgid(pid) };
    if actual >= 0 && actual != pid {
        return Err("Owned leader moved process group".into());
    }
    let result = unsafe { libc::kill(-pid, signal) };
    if result == 0 {
        return Ok(());
    }
    let error = std::io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Ok(());
    }
    Err(error.to_string())
}
#[cfg(not(unix))]
fn signal_record(record: &Record, _signal: i32) -> Result<(), String> {
    record
        .child
        .lock()
        .map_err(|e| e.to_string())?
        .kill()
        .map_err(|e| e.to_string())
}

pub struct OwnedProcessManager {
    processes: Arc<Mutex<HashMap<u32, OwnedProcess>>>,
}
impl Default for OwnedProcessManager {
    fn default() -> Self {
        Self {
            processes: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}
impl OwnedProcessManager {
    pub fn spawn_owned_process(
        &mut self,
        command: &str,
        args: &[&str],
        options: OwnedProcessOptions,
    ) -> Result<OwnedProcess, String> {
        // A POSIX bootstrap shell immediately stops itself before exec. This
        // gives the supervisor time to prove parent/leader ownership even
        // when the requested executable exits in less than one millisecond.
        // `exec "$@"` passes arguments literally, never through shell eval.
        #[cfg(unix)]
        let mut cmd = {
            let mut command_line = Command::new("/bin/sh");
            command_line.args(["-c", "kill -STOP $$; exec \"$@\"", "owned-process", command]);
            command_line
        };
        #[cfg(not(unix))]
        let mut cmd = Command::new(command);
        cmd.args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(cwd) = &options.cwd {
            cmd.current_dir(cwd);
        }
        #[cfg(unix)]
        {
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|e| e.to_string())?;
        let pid = child.id();
        if pid <= 1 || pid == std::process::id() {
            let _ = child.kill();
            return Err("Refusing unsafe spawned PID".into());
        }
        #[cfg(unix)]
        {
            // No external process may be registered as owned. The child must
            // lead the brand-new group established by CommandExt::process_group.
            let pgid = unsafe { libc::getpgid(pid as i32) };
            if pgid >= 0 && pgid != pid as i32 {
                let _ = child.kill();
                return Err("Spawned child lacks isolated process group".into());
            }
        }
        let record = Arc::new(Record {
            pid,
            invocation_id: format!(
                "{pid}-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_nanos())
            ),
            invocation: options.invocation,
            started: Instant::now(),
            grace_ms: options.grace_ms,
            child: Mutex::new(child),
            supervisor: Mutex::new(None),
            terminating: AtomicBool::new(false),
            reason: Mutex::new(None),
            finished: AtomicBool::new(false),
        });
        #[cfg(unix)]
        {
            let fallback = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .parent()
                .map(PathBuf::from)
                .unwrap_or_default();
            let supervisor_path = options.supervisor_path.unwrap_or_else(|| {
                let direct = fallback.join("owned-process-supervisor");
                if direct.is_file() {
                    direct
                } else {
                    fallback
                        .parent()
                        .unwrap_or(&fallback)
                        .join("owned-process-supervisor")
                }
            });
            let result = Command::new(&supervisor_path)
                .args([
                    std::process::id().to_string(),
                    pid.to_string(),
                    options.grace_ms.to_string(),
                ])
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .process_group(0)
                .spawn();
            match result {
                Ok(mut supervisor) => {
                    let mut line = String::new();
                    let ready = supervisor.stdout.take().is_some_and(|output| {
                        std::io::BufReader::new(output).read_line(&mut line).is_ok()
                    });
                    if !ready || line.trim() != "READY" {
                        let _ = signal_record(&record, libc::SIGKILL);
                        let _ = supervisor.kill();
                        let _ = supervisor.wait();
                        return Err(
                            "Native supervisor could not attest parent/child ownership".into()
                        );
                    }
                    *record.supervisor.lock().expect("supervisor mutex") = Some(supervisor);
                }
                Err(error) => {
                    let _ = signal_record(&record, libc::SIGKILL);
                    return Err(format!(
                        "Native parent-death supervisor unavailable at {}: {error}",
                        supervisor_path.display()
                    ));
                }
            }
        }
        #[cfg(unix)]
        if unsafe { libc::kill(pid as i32, libc::SIGCONT) } != 0 {
            let error = std::io::Error::last_os_error().to_string();
            let _ = signal_record(&record, libc::SIGKILL);
            return Err(format!(
                "Cannot resume owned child after supervision: {error}"
            ));
        }
        let owned = OwnedProcess {
            inner: Arc::clone(&record),
        };
        self.processes
            .lock()
            .expect("owned map")
            .insert(pid, owned.clone());
        let processes = Arc::clone(&self.processes);
        let monitored = owned.clone();
        thread::spawn(move || {
            loop {
                let exited = monitored
                    .inner
                    .child
                    .lock()
                    .expect("child mutex")
                    .try_wait();
                match exited {
                    Ok(Some(_)) | Err(_) => {
                        monitored.inner.finished.store(true, Ordering::Release);
                        if !monitored.inner.terminating.load(Ordering::Acquire) {
                            monitored.terminate(TerminationReason::LeaderExit, None);
                        }
                        break;
                    }
                    Ok(None) => thread::sleep(Duration::from_millis(15)),
                }
            }
            thread::sleep(Duration::from_millis(monitored.inner.grace_ms + 100));
            if let Some(mut supervisor) = monitored
                .inner
                .supervisor
                .lock()
                .expect("supervisor mutex")
                .take()
            {
                let _ = supervisor.kill();
                let _ = supervisor.wait();
            }
            processes.lock().expect("owned map").remove(&pid);
        });
        if let Some(ms) = options.timeout_ms {
            let timeout = owned.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(ms));
                if !timeout.finished() && !timeout.inner.terminating.load(Ordering::Acquire) {
                    timeout.terminate(TerminationReason::Timeout, None);
                }
            });
        }
        Ok(owned)
    }
    pub fn owned_process_snapshot(&self) -> Vec<OwnedProcessSnapshot> {
        self.processes
            .lock()
            .expect("owned map")
            .values()
            .map(OwnedProcess::snapshot)
            .collect()
    }
    pub fn terminate_owned_process(
        &self,
        pid: u32,
        reason: TerminationReason,
        grace_ms: Option<u64>,
    ) -> bool {
        let process = self.processes.lock().expect("owned map").get(&pid).cloned();
        if let Some(process) = process {
            process.terminate(reason, grace_ms);
            true
        } else {
            false
        }
    }
    pub fn shutdown_owned_processes(&self, reason: TerminationReason) {
        for process in self.processes.lock().expect("owned map").values() {
            process.terminate(reason, None);
        }
    }
}
impl Drop for OwnedProcessManager {
    fn drop(&mut self) {
        self.shutdown_owned_processes(TerminationReason::ParentShutdown);
    }
}

/// Called only by the dedicated native child process after OS parent/child
/// validation. Never accept user-supplied negative PID or unrelated groups.
#[cfg(unix)]
pub fn supervisor_main(args: &[String]) -> Result<(), String> {
    if args.len() != 3 {
        return Err("expected parent-pid leader-pid grace-ms".into());
    }
    let parent: i32 = args[0].parse().map_err(|_| "invalid parent PID")?;
    let leader: i32 = args[1].parse().map_err(|_| "invalid leader PID")?;
    let grace: u64 = args[2].parse().map_err(|_| "invalid grace")?;
    if parent <= 1
        || leader <= 1
        || parent == leader
        || parent == std::process::id() as i32
        || grace > 60_000
    {
        return Err("unsafe supervisor owner identity".into());
    }
    // The initial direct-parent relationship is a kernel-provided capability.
    if unsafe { libc::getppid() } != parent {
        return Err("supervisor parent PID mismatch".into());
    }
    let pgid = unsafe { libc::getpgid(leader) };
    if pgid != leader {
        return Err("supervisor refuses non-isolated or exited leader".into());
    }
    // Verify leader is a child of the same parent; a malicious invocation
    // must not watch another user's PID or their process group.
    let evidence = Command::new("/bin/ps")
        .args(["-p", &leader.to_string(), "-o", "ppid="])
        .output()
        .map_err(|e| e.to_string())?;
    let observed = String::from_utf8_lossy(&evidence.stdout)
        .trim()
        .parse::<i32>()
        .map_err(|_| "unverifiable leader owner")?;
    if observed != parent {
        return Err("supervisor leader ownership mismatch".into());
    }
    println!("READY");
    loop {
        thread::sleep(Duration::from_millis(250));
        if unsafe { libc::kill(-leader, 0) } != 0 {
            return Ok(());
        }
        if unsafe { libc::getppid() } != parent {
            if unsafe { libc::kill(-leader, libc::SIGTERM) } != 0 {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(grace));
            let _ = unsafe { libc::kill(-leader, libc::SIGKILL) };
            return Ok(());
        }
    }
}

#[cfg(not(unix))]
pub fn supervisor_main(_args: &[String]) -> Result<(), String> {
    Err("parent-death supervisor requires POSIX process groups".into())
}
