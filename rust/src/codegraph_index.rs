//! Optional checkout-local code intelligence cache. No lifecycle authority.
use crate::{
    continuation::{run_delivery_owned_process, DeliveryProcessOptions},
    local_git_merge::git,
    local_merge_lock::with_local_merge_lock,
    owned_process::OwnedProcessManager,
};
use rusqlite::{
    backup::{Backup, StepResult},
    Connection, OpenFlags,
};
use std::{
    env, fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const INDEX: &str = ".codegraph";
const DB: &str = "codegraph.db";
static STAGE: AtomicU64 = AtomicU64::new(0);

/// Only use host-installed tooling. Missing tools must not prevent dispatch.
pub fn installed_codegraph() -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?)
        .filter(|p| p.is_absolute())
        .map(|p| p.join("codegraph"))
        .find(|p| p.is_file() && fs::metadata(p).is_ok_and(|m| m.permissions().mode() & 0o111 != 0))
}

fn run(executable: &Path, root: &Path, index: &str, init: bool) -> Result<(), String> {
    let mut environment = env::vars().collect::<std::collections::HashMap<_, _>>();
    environment.insert("CODEGRAPH_DIR".into(), index.into());
    environment.insert("CODEGRAPH_TELEMETRY".into(), "0".into());
    let root_arg = root.to_str().ok_or("Non-UTF8 CodeGraph checkout path")?;
    let args = if init {
        vec!["init", "--yes", "--local-only", root_arg]
    } else {
        vec!["sync", "--quiet", root_arg]
    };
    let result = run_delivery_owned_process(
        &mut OwnedProcessManager::default(),
        executable
            .to_str()
            .ok_or("Non-UTF8 CodeGraph executable path")?,
        &args,
        Some(root),
        "codegraph.checkout_index",
        DeliveryProcessOptions {
            timeout: Some(Duration::from_secs(120)),
            environment: Some(&environment),
            ..Default::default()
        },
    )?;
    if result.code != 0 {
        return Err(format!(
            "CodeGraph exited {}: {}",
            result.code,
            result.stderr.chars().take(500).collect::<String>()
        ));
    }
    Ok(())
}

fn index_db(root: &Path) -> Result<Option<PathBuf>, String> {
    let index = root.join(INDEX);
    match fs::symlink_metadata(&index) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.to_string()),
        Ok(m) if !m.is_dir() || m.file_type().is_symlink() => {
            return Err("CodeGraph index path is not an owned directory".into())
        }
        _ => {}
    }
    let db = index.join(DB);
    let meta = fs::symlink_metadata(&db).map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("CodeGraph database is not a regular file".into());
    }
    Ok(Some(db))
}

fn snapshot(source: &Path, destination: &Path) -> Result<(), String> {
    // WAL databases may need to create their shared-memory sidecar even
    // for a read. Open without CREATE and forbid SQL writes on this connection.
    let source = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    source
        .pragma_update(None, "query_only", true)
        .map_err(|e| e.to_string())?;
    let mut destination = Connection::open(destination).map_err(|e| e.to_string())?;
    let backup = Backup::new(&source, &mut destination).map_err(|e| e.to_string())?;
    let start = Instant::now();
    loop {
        match backup.step(256).map_err(|e| e.to_string())? {
            StepResult::Done => return Ok(()),
            _ if start.elapsed() >= Duration::from_secs(15) => {
                return Err("CodeGraph snapshot timed out".into())
            }
            _ => std::thread::sleep(Duration::from_millis(10)),
        }
    }
}

/// Build privately, then publish the complete index. Never copy WAL files,
/// watcher state, locks, or sockets. Never replace an existing index.
fn install(executable: &Path, root: &Path, seed: Option<&Path>) -> Result<(), String> {
    if index_db(root)?.is_some() {
        return Ok(());
    }
    if !git(root, &["ls-files", "--", INDEX])?.is_empty() {
        return Err("Refusing to modify tracked CodeGraph index".into());
    }
    let stage_name = format!(
        ".codegraph-relay-seed-{}-{}",
        std::process::id(),
        STAGE.fetch_add(1, Ordering::Relaxed)
    );
    let stage = root.join(&stage_name);
    fs::create_dir(&stage).map_err(|e| e.to_string())?;
    let result = (|| {
        fs::write(stage.join(".gitignore"), "*\n").map_err(|e| e.to_string())?;
        if let Some(source) = seed {
            snapshot(source, &stage.join(DB))?;
            run(executable, root, &stage_name, false)?;
        } else {
            run(executable, root, &stage_name, true)?;
        }
        if !stage.join(DB).is_file() {
            return Err("CodeGraph did not produce a database".into());
        }
        if fs::symlink_metadata(root.join(INDEX)).is_ok() {
            return Err("CodeGraph destination appeared during preparation".into());
        }
        fs::rename(&stage, root.join(INDEX)).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(&stage);
    }
    result
}

/// Called before a coding worker starts, not after individual edits.
/// Existing indexes are owned by the MCP watcher; do not sync them again.
/// Refresh the Main seed on demand, since Main may have no active watcher.
pub fn prepare_worktree_index(
    executable: &Path,
    primary: &Path,
    checkout: &Path,
) -> Result<(), String> {
    if primary == checkout || index_db(checkout)?.is_some() {
        return Ok(());
    }
    let common = PathBuf::from(git(
        primary,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?);
    with_local_merge_lock(
        &common,
        "refs/heads/main",
        || {
            if index_db(checkout)?.is_some() {
                return Ok(());
            }
            // Only a clean checked-out main may seed another checkout. Never
            // cache unrelated private changes from a dirty primary checkout.
            if git(primary, &["symbolic-ref", "-q", "HEAD"])
                .ok()
                .as_deref()
                != Some("refs/heads/main")
                || !git(primary, &["status", "--porcelain"])?.is_empty()
            {
                return install(executable, checkout, None);
            }
            let seed = (|| match index_db(primary)? {
                Some(db) => {
                    run(executable, primary, INDEX, false)?;
                    Ok::<PathBuf, String>(db)
                }
                None => {
                    install(executable, primary, None)?;
                    index_db(primary)?.ok_or("Main CodeGraph index missing".into())
                }
            })();
            match seed {
                Ok(db) => match install(executable, checkout, Some(&db)) {
                    Ok(()) => Ok(()),
                    Err(e) => {
                        eprintln!("warning: CodeGraph snapshot unavailable: {e}; indexing checkout independently");
                        install(executable, checkout, None)
                    }
                },
                Err(e) => {
                    eprintln!("warning: Main CodeGraph cache unavailable: {e}; indexing checkout independently");
                    install(executable, checkout, None)
                }
            }
        },
        Duration::from_secs(5),
    )
}
