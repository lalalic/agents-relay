//! Locate shipped Relay resources without depending on the build checkout or cwd.
use std::path::{Path, PathBuf};

fn valid(root: &Path) -> bool {
    root.join("skills/agents-relay/agents").is_dir()
        && root.join("skills/agents-relay/contracts").is_dir()
        && root.join("workflow").is_dir()
}

pub fn package_root() -> Result<PathBuf, String> {
    if let Some(root) = std::env::var_os("AGENTS_RELAY_RESOURCE_ROOT") {
        let root = PathBuf::from(root);
        if !root.is_absolute() || !valid(&root) {
            return Err(format!(
                "Invalid AGENTS_RELAY_RESOURCE_ROOT: {}",
                root.display()
            ));
        }
        return root.canonicalize().map_err(|e| e.to_string());
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.canonicalize().map_err(|e| e.to_string())?;
    exe.ancestors().skip(1).find(|root| valid(root)).map(Path::to_path_buf)
        .ok_or_else(|| format!("Relay resources not installed beside {}; set AGENTS_RELAY_RESOURCE_ROOT to an absolute package root", exe.display()))
}

pub fn bundled_agents_root() -> Result<String, String> {
    Ok(package_root()?
        .join("skills/agents-relay/agents")
        .to_string_lossy()
        .into_owned())
}

/// Resolve the native CLI beside the running binary (also for Cargo test bins).
pub fn native_cli() -> Result<PathBuf, String> {
    let host = std::env::current_exe().map_err(|e| e.to_string())?;
    let sibling = host.with_file_name("agents-relay-rust");
    let candidate = if sibling.is_file() { sibling } else {
        host.parent().and_then(Path::parent).ok_or("Native Relay CLI parent unavailable")?
            .join("agents-relay-rust")
    };
    candidate.canonicalize().map_err(|e| format!("Native Relay CLI unavailable: {e}"))
}
