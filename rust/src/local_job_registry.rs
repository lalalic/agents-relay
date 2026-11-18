// Node provenance: src/local-job-registry.ts. Resolve a unique immutable Job ID
// from readonly SQLite snapshots before any writable scope is constructed.
use crate::relay_store_discovery::{
    discover_local_relay_store_snapshots, LocalRelayStoreSnapshot,
};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone)]
pub struct MatchedJob {
    pub snapshot: LocalRelayStoreSnapshot,
    pub job: Value,
}

pub fn find_job_id_snapshot(
    directory: &Path, job_id: &str,
) -> Result<Option<MatchedJob>, String> {
    let snapshots = discover_local_relay_store_snapshots(directory)?;
    Ok(select_job_id_snapshot(snapshots, job_id))
}
pub fn select_job_id_snapshot(
    snapshots: Vec<LocalRelayStoreSnapshot>, job_id: &str,
) -> Option<MatchedJob> {
    let matching: Vec<MatchedJob> = snapshots.into_iter().flat_map(|snapshot| {
        let jobs: Vec<Value> = snapshot.jobs.iter()
            .filter(|job| job.get("id").and_then(Value::as_str) == Some(job_id))
            .cloned().collect();
        jobs.into_iter().map(move |job| MatchedJob { snapshot: snapshot.clone(), job })
    }).collect();
    let live: Vec<&MatchedJob> = matching.iter().filter(|match_| {
        !matches!(match_.job.get("state").and_then(Value::as_str),
            Some("COMPLETED" | "CANCELLED"))
    }).collect();
    match live.len() {
        1 => Some((*live[0]).clone()),
        0 if matching.len() == 1 => matching.into_iter().next(),
        _ => None,
    }
}

/// The cache key cannot alias two Jobs sharing the unified SQLite file.
pub fn scoped_store_cache_key(selected: &MatchedJob) -> Result<String, String> {
    let id = selected.job.get("id").and_then(Value::as_str)
        .ok_or("Job missing immutable ID")?;
    Ok(format!("{}#{id}", selected.snapshot.path.display()))
}
pub fn should_enable_github(job: &Value, no_github: bool, client_available: bool) -> bool {
    !no_github && client_available
        && job.get("githubRepo").and_then(Value::as_str).is_some_and(|s| !s.is_empty())
        && job.get("prNumber").and_then(Value::as_i64).is_some_and(|n| n > 0)
}

/// Node createJobIdRegistryResolver. The resolver is an explicit, single-owner
/// cache: one immutable `(SQLite file, Job ID)` key corresponds to exactly one
/// writable LocalAuthority Store. Inventory remains read-only until selected.
pub struct LocalJobRegistryResolver {
    directory:std::path::PathBuf,
    no_github:bool,
    cached:std::collections::HashMap<String,ResolvedLocalJob>,
}
pub struct ResolvedLocalJob {
    pub job:Value,
    pub store:crate::local_authority_store::LocalAuthorityDurableStore,
}
impl ResolvedLocalJob {
    pub fn relay(&self)->&crate::relay_store::SQLiteRelayStore{
        &self.store.authority
    }
}
impl LocalJobRegistryResolver {
    pub fn resolve(&mut self,job_id:&str)->Result<Option<&ResolvedLocalJob>,String>{
        let selected=match find_job_id_snapshot(&self.directory,job_id)?{
            Some(selected)=>selected,None=>return Ok(None),
        };
        let key=scoped_store_cache_key(&selected)?;
        if !self.cached.contains_key(&key){
            let scoped=crate::relay_store::SQLiteRelayStore::open(
                &selected.snapshot.path,Some(job_id))?;
            self.cached.insert(key.clone(),ResolvedLocalJob{
                job:selected.job.clone(),
                store:crate::local_authority_store::LocalAuthorityDurableStore::new(
                    scoped,self.no_github),
            });
        }
        if let Some(entry)=self.cached.get_mut(&key){
            entry.job=selected.job;
        }
        Ok(self.cached.get(&key))
    }
    pub fn cached_count(&self)->usize{self.cached.len()}
}
pub fn create_job_id_registry_resolver(
    directory:&Path,no_github:bool,
)->LocalJobRegistryResolver{
    LocalJobRegistryResolver{
        directory:directory.to_path_buf(),no_github,
        cached:std::collections::HashMap::new(),
    }
}
