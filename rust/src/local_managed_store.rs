// Node provenance: src/local-managed-store.ts. Validate local Job/PR
// identity before constructing any SQLite-authoritative store adapters.
use crate::relay_store_discovery::{
    relay_unified_store_path, resolve_unified_job_scope,
};
use regex::Regex;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalManagedStoreLocation {
    pub directory: PathBuf,
    pub sqlite_path: PathBuf,
    pub scope_job_id: String,
    pub github_enabled: bool,
}
pub fn open_local_managed_store_location(
    repository: &str,
    pr_number: i64,
    directory: &Path,
    job_id: Option<&str>,
    no_github: bool,
) -> Result<LocalManagedStoreLocation, String> {
    let valid_repo = Regex::new(r"^[A-Za-z0-9_.-]+$")
        .expect("constant repository identity expression");
    if !valid_repo.is_match(repository) || matches!(repository, "." | "..")
        || pr_number < 0 || (pr_number == 0 && job_id.is_none())
    { return Err("Local managed store requires a local repository identity and either a positive PR number or immutable jobId".into()); }
    let scope_job_id = resolve_unified_job_scope(directory, repository, pr_number, job_id)?;
    Ok(LocalManagedStoreLocation {
        directory: directory.into(), sqlite_path: relay_unified_store_path(directory),
        scope_job_id, github_enabled: pr_number > 0 && !no_github,
    })
}
