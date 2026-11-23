// Native local-managed-store: validate immutable local Job
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
}
pub fn open_local_managed_store_location(
    repository:&str,directory:&Path,job_id:&str,
)->Result<LocalManagedStoreLocation,String>{
    let valid_repo=Regex::new(r"^[A-Za-z0-9_.-]+$")
        .expect("constant repository identity expression");
    if !valid_repo.is_match(repository)||matches!(repository,"."|"..")
        ||job_id.is_empty(){
        return Err("Local managed store requires repository and immutable Job ID".into());
    }
    let scope_job_id=resolve_unified_job_scope(directory,repository,job_id)?;
    Ok(LocalManagedStoreLocation{
        directory:directory.into(),sqlite_path:relay_unified_store_path(directory),
        scope_job_id,
    })
}

/// Node openLocalManagedStore: construct the actual canonical SQLite-backed
/// LocalAuthority Store using the same validated immutable Job scope.
/// Rust owns the SQLite connection inside `authority` (single source of truth).
pub fn open_local_managed_store(
    repository:&str,directory:&Path,job_id:&str,
)->Result<crate::local_authority_store::LocalAuthorityDurableStore,String>{
    let location=open_local_managed_store_location(repository,directory,job_id)?;
    let relay=crate::relay_store::SQLiteRelayStore::open(
        &location.sqlite_path,Some(&location.scope_job_id))?;
    Ok(crate::local_authority_store::LocalAuthorityDurableStore::new(relay,true))
}
