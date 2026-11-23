// Node provenance: src/relay-store-discovery.ts. Read-only, SQLite-authoritative
// Job inventory and immutable scope lookup; never opens a writable connection.
use crate::json_wire_parse::parse_js_json;
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

/// The read-only live shadow must not deserialize every Job on each
/// /api/job?id= request. Fetch one immutable Job ID through SQLite's index
/// and project the exact same publication/PR facts as the full inventory.
/// This function never opens a writable connection or resets a lease.
pub fn discover_unified_job_by_id(
    directory:&Path,id:&str,
)->Result<Option<LocalRelayStoreSnapshot>,String>{
    let path=relay_unified_store_path(directory);
    if !path.is_file(){return Ok(None);}
    let db=open_read_only(&path)?;
    let raw:Option<String>=db.query_row(
        "SELECT json FROM job_snapshot WHERE job_id=?",params![id],
        |row|row.get(0)).optional().map_err(|e|e.to_string())?;
    let Some(raw)=raw else{return Ok(None);};
    let job=parse_js_json(&raw)?;
    if job.get("id").and_then(Value::as_str)!=Some(id){
        return Err("Immutable SQLite Job ID differs from row scope".into());
    }
    let fact:Option<(String,Option<String>,Option<String>,String)>=db.query_row(
        "SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts WHERE scope_job_id=? AND id=1",
        params![id],
        |row|Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?)),
    ).optional().map_err(|e|e.to_string())?;
    let facts=fact.map(|(state,head_ref,head_sha,observed_at)|{
        let head=head_ref.zip(head_sha).map(|(reference,sha)|
            serde_json::json!({"ref":reference,"sha":sha}));
        serde_json::json!({"state":state,"head":head,"observedAt":observed_at})
    });
    let publication_raw:Option<String>=db.query_row(
        "SELECT json FROM publication_state WHERE job_id=?",params![id],
        |row|row.get(0)).optional().map_err(|e|e.to_string())?;
    let mut publications=Map::new();
    if let Some(raw)=publication_raw{
        publications.insert(id.to_owned(),parse_js_json(&raw)?);
    }
    Ok(Some(LocalRelayStoreSnapshot{
        path,jobs:vec![job],facts,publications
    }))
}

/// Resolve a local Job only from its immutable Job ID and repository.
pub fn resolve_unified_job_scope(
    directory:&Path,repository:&str,job_id:&str,
)->Result<String,String>{
    if job_id.is_empty() {return Err("Immutable Job ID is required".into());}
    let path=relay_unified_store_path(directory);
    if !path.exists() {return Ok(job_id.into());}
    let db=open_read_only(&path)?;
    let bound:Option<String>=db.query_row(
        "SELECT repository FROM source_registry WHERE job_id=?",params![job_id],
        |row|row.get(0)).optional().map_err(|e|e.to_string())?;
    if bound.as_deref().is_some_and(|name|name!=repository){
        return Err(format!("Job {job_id} belongs to another local repository"));
    }
    Ok(job_id.into())
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
        let job = parse_js_json(&raw)?;
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
