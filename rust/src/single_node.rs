//! Single-host process ownership for the experimental native Relay daemon.
//! Exactly one daemon instance may reconcile a marked SQLite store at a time.
//! Flock is owned by the process (not persisted in SQLite); SIGKILL releases
//! it automatically, while helper child FDs do not inherit this lock.
use crate::native_daemon::{isolated_store_root, NativeDaemonOptions, NativeTick};
use nix::fcntl::{Flock, FlockArg};
use std::fs::{File, OpenOptions};
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

pub struct SingleNodeDaemon {
    options: NativeDaemonOptions,
    _guard: Flock<File>,
}

fn single_node_lock(root: &Path) -> Result<Flock<File>, String> {
    let path = root.join(".relay-native-daemon.lock");
    // O_NOFOLLOW + CLOEXEC protects the lock's identity and prevents the
    // helper subprocess from accidentally prolonging ownership after death.
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_CLOEXEC)
        .open(&path)
        .map_err(|e| format!("invalid native single-node lock file: {e}"))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.file_type().is_file() {
        return Err("native single-node lock must be a regular file".into());
    }
    Flock::lock(file, FlockArg::LockExclusiveNonblock).map_err(|(_, e)| {
        format!("native single-node daemon already active or lock unavailable: {e}")
    })
}

impl SingleNodeDaemon {
    pub fn acquire(options: NativeDaemonOptions) -> Result<Self, String> {
        let root = isolated_store_root(&options.db)?;
        let guard = single_node_lock(&root)?;
        Ok(Self {
            options,
            _guard: guard,
        })
    }

    pub fn tick(&self, stopped: Arc<AtomicBool>) -> Result<NativeTick, String> {
        crate::native_daemon::tick_with_stop(&self.options, stopped)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exclusive_file_lock_released_on_drop_and_rejects_symlink() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let first = single_node_lock(root).unwrap();
        assert!(
            single_node_lock(root).is_err(),
            "second daemon must fail closed"
        );
        drop(first);
        assert!(single_node_lock(root).is_ok());
        std::fs::remove_file(root.join(".relay-native-daemon.lock")).unwrap();
        std::os::unix::fs::symlink(root.join("target"), root.join(".relay-native-daemon.lock"))
            .unwrap();
        assert!(
            single_node_lock(root).is_err(),
            "symlink lock path is not trustworthy"
        );
    }
}
