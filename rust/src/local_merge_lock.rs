// Direct port of Node src/local-merge-lock.ts: scoped atomic filesystem lock, stale recovery and owner-safe release.
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::Write,
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug)]
struct MergeLockOwner {
    pid: u32,
    host: String,
    started_at: String,
    target_ref: String,
}

impl MergeLockOwner {
    fn json(&self) -> Value {
        json!({"pid":self.pid,"host":self.host,"startedAt":self.started_at,"targetRef":self.target_ref})
    }
}

fn sha_prefix(value: &str, length: usize) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))[..length].to_string()
}

pub fn lock_directory(common_dir: &Path, target_ref: &str) -> PathBuf {
    common_dir.join(format!(
        "agents-relay-merge-{}.lockdir",
        sha_prefix(target_ref, 24)
    ))
}

pub(crate) fn hostname() -> Result<String, String> {
    let mut bytes = [0u8; 256];
    let code = unsafe { libc::gethostname(bytes.as_mut_ptr().cast(), bytes.len()) };
    if code != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let end = bytes
        .iter()
        .position(|&byte| byte == 0)
        .unwrap_or(bytes.len());
    Ok(String::from_utf8_lossy(&bytes[..end]).to_string())
}

pub(crate) fn iso8601_now() -> String {
    // Node `new Date().toISOString()` provides an ISO UTC millisecond stamp.
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let seconds = stamp.as_secs() as libc::time_t;
    let mut raw = std::mem::MaybeUninit::<libc::tm>::uninit();
    let calendar = unsafe { libc::gmtime_r(&seconds, raw.as_mut_ptr()) };
    if calendar.is_null() {
        return format!("{}.{:03}Z", stamp.as_secs(), stamp.subsec_millis());
    }
    let calendar = unsafe { raw.assume_init() };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        calendar.tm_year + 1900,
        calendar.tm_mon + 1,
        calendar.tm_mday,
        calendar.tm_hour,
        calendar.tm_min,
        calendar.tm_sec,
        stamp.subsec_millis()
    )
}

fn write_owner(file: &Path, owner: &MergeLockOwner) -> Result<(), String> {
    let mut output = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(file)
        .map_err(|error| error.to_string())?;
    output
        .write_all(owner.json().to_string().as_bytes())
        .map_err(|error| error.to_string())
}

fn owner_matches(file: &Path, owner: &MergeLockOwner) -> bool {
    let Ok(contents) = fs::read(file) else {
        return false;
    };
    let Ok(current) = serde_json::from_slice::<Value>(&contents) else {
        return false;
    };
    current["pid"].as_u64() == Some(u64::from(owner.pid))
        && current["host"].as_str() == Some(&owner.host)
        && current["startedAt"].as_str() == Some(&owner.started_at)
}

fn process_alive(pid: libc::pid_t) -> bool {
    let outcome = unsafe { libc::kill(pid, 0) };
    outcome == 0 || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
}

fn orphaned(directory: &Path, owner_file: &Path, host: &str, grace_ms: u128) -> bool {
    let Ok(metadata) = fs::metadata(directory) else {
        return false;
    };
    let Ok(age) =
        SystemTime::now().duration_since(metadata.modified().unwrap_or(SystemTime::now()))
    else {
        return false;
    };
    if age.as_millis() < grace_ms {
        return false;
    }
    let Ok(owner_bytes) = fs::read(owner_file) else {
        return true;
    };
    let Ok(owner) = serde_json::from_slice::<Value>(&owner_bytes) else {
        return true;
    };
    if owner["host"].as_str() != Some(host) {
        return false;
    }
    let Some(pid) = owner["pid"]
        .as_i64()
        .filter(|pid| i32::try_from(*pid).is_ok())
    else {
        return false;
    };
    !process_alive(pid as libc::pid_t)
}

struct ScopedLock {
    path: PathBuf,
    owner_file: PathBuf,
    owner: MergeLockOwner,
}

impl Drop for ScopedLock {
    fn drop(&mut self) {
        // As in Node, never remove a lock whose recorded owner no longer
        // matches the current process's lease identity.
        if owner_matches(&self.owner_file, &self.owner) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

pub fn with_local_merge_lock<T, F>(
    common_dir: &Path,
    target_ref: &str,
    action: F,
    timeout: Duration,
) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    let path = lock_directory(common_dir, target_ref);
    let owner_file = path.join("owner.json");
    let recovery_guard = PathBuf::from(format!("{}.recovery", path.to_string_lossy()));
    let recovery_owner_file = recovery_guard.join("owner.json");
    let owner = MergeLockOwner {
        pid: std::process::id(),
        host: hostname()?,
        started_at: iso8601_now(),
        target_ref: target_ref.to_string(),
    };
    let started = Instant::now();
    loop {
        match fs::create_dir(&path) {
            Ok(()) => {
                write_owner(&owner_file, &owner)?;
                break;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.to_string()),
        }
        if orphaned(&recovery_guard, &recovery_owner_file, &owner.host, 3000) {
            let quarantined = PathBuf::from(format!(
                "{}.orphan-{}-{}",
                recovery_guard.to_string_lossy(),
                owner.pid,
                sha_prefix(&owner.started_at, 10)
            ));
            if fs::rename(&recovery_guard, &quarantined).is_ok() {
                let _ = fs::remove_dir_all(quarantined);
            }
        }
        let mut guarded = false;
        if fs::create_dir(&recovery_guard).is_ok() {
            guarded = true;
            let _ = (|| -> Result<(), String> {
                write_owner(&recovery_owner_file, &owner)?;
                if orphaned(&path, &owner_file, &owner.host, 3000) {
                    let _ = fs::remove_dir_all(&path);
                }
                Ok(())
            })();
        }
        if guarded && owner_matches(&recovery_owner_file, &owner) {
            let _ = fs::remove_dir_all(&recovery_guard);
        }
        if started.elapsed() >= timeout {
            return Err(format!("Local merge target locked: {target_ref}"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _lock = ScopedLock {
        path,
        owner_file,
        owner,
    };
    action()
}
