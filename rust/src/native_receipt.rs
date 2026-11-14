//! Exact, bounded local Worker terminal receipt reader shared by the Script
//! and Model adapters. A worker-controlled symlink must never redirect the
//! daemon to unrelated files during receipt validation.
use nix::libc;
use serde_json::Value;
use std::fs::OpenOptions;
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;

pub(crate) fn read_bounded_json(path: &Path, context: &str) -> Result<Value, String> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(path)
        .map_err(|e| format!("missing {context}: {e}"))?;
    let meta = file
        .metadata()
        .map_err(|e| format!("{context} metadata failed: {e}"))?;
    if !meta.is_file() || meta.len() > 1_048_576 {
        return Err(format!("{context} must be a bounded regular file"));
    }
    let mut bytes = Vec::new();
    file.take(1_048_577)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{context} read failed: {e}"))?;
    if bytes.len() > 1_048_576 {
        return Err(format!("{context} exceeds 1MiB"));
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("invalid {context} JSON: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn refuses_symlink_and_oversized_receipt() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("proof.json");
        std::fs::write(&file, b"{\"status\":\"COMPLETED\"}").unwrap();
        assert!(read_bounded_json(&file, "Worker completion evidence").is_ok());
        let redirect = dir.path().join("redirect.json");
        std::os::unix::fs::symlink(&file, &redirect).unwrap();
        assert!(read_bounded_json(&redirect, "Worker completion evidence").is_err());
        std::fs::write(&file, vec![b'A'; 1_048_577]).unwrap();
        assert!(read_bounded_json(&file, "Worker completion evidence").is_err());
    }
}
