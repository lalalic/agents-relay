// Node provenance: src/relay-store-discovery.ts. Read-only, SQLite-authoritative
// Job inventory and immutable scope lookup; never opens a writable connection.
use crate::job_pr_number_migration::{normalize_legacy_job_pr_number, parse_js_json};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct LocalRelayStoreSnapshot {
    pub path: PathBuf,
    pub jobs: Vec<Value>,
    pub facts: Option<Value>,
    pub publications: Map<String, Value>,
}

pub fn relay_unified_store_path(directory: &Path) -> PathBuf {
    directory.parent().unwrap_or(Path::new("")).join("relay.sqlite")
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())
}

/// Reject a missing or ambiguous PR binding. A caller-supplied immutable ID
/// remains authoritative, unless an existing registry proves it belongs elsewhere.
pub fn resolve_unified_job_scope(
    directory: &Path,
    repository: &str,
    pr_number: i64,
    hint_id: Option<&str>,
) -> Result<String, String> {
    let path = relay_unified_store_path(directory);
    if let Some(id) = hint_id {
        if !path.exists() { return Ok(id.to_string()); }
    }
    let db = open_read_only(&path)?;
    let has_registry: Option<i64> = db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_registry'",
        [], |row| row.get(0),
    ).optional().map_err(|error| error.to_string())?;
    if has_registry.is_none() {
        return hint_id.map(str::to_owned).ok_or_else(||
            format!("Unified Job scope is missing for {repository} PR {pr_number}; supply immutable Job ID"));
    }
    if let Some(id) = hint_id {
        let binding: Option<(String, i64)> = db.query_row(
            "SELECT repository,pr_number FROM source_registry WHERE job_id=?",
            params![id], |row| Ok((row.get(0)?, row.get(1)?)),
        ).optional().map_err(|error| error.to_string())?;
        if let Some((bound_repo, bound_pr)) = binding {
            if bound_repo != repository || (pr_number > 0 && bound_pr != pr_number) {
                return Err(format!("Job {id} is bound to another repository or PR"));
            }
        }
        return Ok(id.to_string());
    }
    let mut stmt = db.prepare(
        "SELECT job_id FROM source_registry WHERE repository=? AND pr_number=?",
    ).map_err(|error| error.to_string())?;
    let ids = stmt.query_map(params![repository, pr_number], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    if ids.len() != 1 {
        let kind = if ids.is_empty() { "missing" } else { "ambiguous" };
        return Err(format!("Unified Job scope is {kind} for {repository} PR {pr_number}; supply immutable Job ID"));
    }
    Ok(ids[0].clone())
}

/// Inventory reads must not reset leases, projection claims or outbox state.
pub fn discover_local_relay_store_snapshots(
    directory: &Path,
) -> Result<Vec<LocalRelayStoreSnapshot>, String> {
    let path = relay_unified_store_path(directory);
    if !path.exists() {
        let legacy_exists = match std::fs::read_dir(directory) {
            Ok(entries) => entries.filter_map(Result::ok).any(|entry|
                entry.path().extension().is_some_and(|extension| extension == "db")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        if legacy_exists {
            return Err(format!("Unified Relay SQLite database missing at {}; legacy Job databases exist in {}",
                path.display(), directory.display()));
        }
        return Ok(Vec::new());
    }
    let db = open_read_only(&path)?;
    let mut publication_query = db.prepare("SELECT job_id,json FROM publication_state")
        .map_err(|error| error.to_string())?;
    let publication_rows = publication_query.query_map([], |row| Ok((
        row.get::<_, String>(0)?, row.get::<_, String>(1)?
    ))).map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut publications = Map::new();
    for (id, raw) in publication_rows {
        publications.insert(id, parse_js_json(&raw)?);
    }
    let mut stmt = db.prepare(
        "SELECT json FROM job_snapshot ORDER BY CAST(job_id AS INTEGER), job_id",
    ).map_err(|error| error.to_string())?;
    let jobs = stmt.query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
    let mut snapshots = Vec::with_capacity(jobs.len());
    for raw in jobs {
        let job = normalize_legacy_job_pr_number(&parse_js_json(&raw)?);
        let job_id = job.get("id").and_then(Value::as_str)
            .ok_or("Snapshot Job missing immutable id")?;
        let fact: Option<(String, Option<String>, Option<String>, String)> = db.query_row(
            "SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE scope_job_id=? AND id=1",
            params![job_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        ).optional().map_err(|error| error.to_string())?;
        let facts = fact.map(|(state, head_ref, head_sha, observed_at)| {
            let head = head_ref.zip(head_sha).map(|(reference, sha)|
                serde_json::json!({"ref": reference, "sha": sha}));
            serde_json::json!({"state": state, "head": head, "observedAt": observed_at})
        });
        let mut per_job = Map::new();
        if let Some(publication) = publications.get(job_id) {
            per_job.insert(job_id.to_string(), publication.clone());
        }
        snapshots.push(LocalRelayStoreSnapshot {
            path: path.clone(), jobs: vec![job], facts, publications: per_job,
        });
    }
    Ok(snapshots)
}
