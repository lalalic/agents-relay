// Direct port of Node src/job-task-id-sequence.ts: globally numeric SQLite Job/Task allocation with scoped idempotency and snapshot high-water marks.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{collections::HashSet, fs, path::Path, time::Duration};

pub fn is_generated_entity_id(id: &str, _repository: &str, _kind: &str) -> bool {
    !id.is_empty()
        && id.as_bytes()[0].is_ascii_digit()
        && id.as_bytes()[0] != b'0'
        && id.as_bytes()[1..].iter().all(u8::is_ascii_digit)
}

fn snapshot_high_water(db: &rusqlite::Transaction<'_>, kind: &str) -> Result<f64, String> {
    let exists: i64 = db
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='job_snapshot'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if exists == 0 {
        return Ok(0.0);
    }
    let mut query = db
        .prepare("SELECT json FROM job_snapshot")
        .map_err(|error| error.to_string())?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| error.to_string())?;
    let mut highest = 0.0f64;
    for raw in rows {
        let raw = raw.map_err(|error| error.to_string())?;
        let Ok(job) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let ids: Vec<&Value> = if kind == "job" {
            job.get("id").into_iter().collect()
        } else {
            job.get("tasks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|task| task.get("id"))
                .collect()
        };
        for id in ids {
            let digits = match id {
                Value::String(s) => s.clone(),
                Value::Number(number) => number.to_string(),
                _ => continue,
            };
            if is_generated_entity_id(&digits, "", kind) {
                if let Ok(value) = digits.parse::<f64>() {
                    highest = highest.max(value);
                }
            }
        }
    }
    Ok(highest)
}
/// The caller owns the repository path. SQLite remains sole allocator, even if
/// multiple local Node/Rust callers race for a Job or Task ID.
pub fn allocate_entity_id(
    directory: &Path,
    repository: &str,
    kind: &str,
    request_key: Option<&str>,
    occupied: &HashSet<String>,
) -> Result<String, String> {
    if repository.is_empty() {
        return Err("Task ID allocation requires a repository context".into());
    }
    if !matches!(kind, "job" | "task") {
        return Err(format!("Invalid entity kind: {kind}"));
    }
    if request_key.is_some_and(|key| key.is_empty() || key.encode_utf16().count() > 512) {
        return Err("Invalid idempotency key".into());
    }
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let parent = directory.parent().unwrap_or_else(|| Path::new("."));
    let store_path = parent.join("relay.sqlite");
    let mut db = Connection::open(store_path).map_err(|error| error.to_string())?;
    db.busy_timeout(Duration::from_millis(10000))
        .map_err(|error| error.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=10000; \
      CREATE TABLE IF NOT EXISTS sequences (repository TEXT NOT NULL,kind TEXT NOT NULL,value INTEGER NOT NULL,PRIMARY KEY(repository,kind)); \
      CREATE TABLE IF NOT EXISTS idempotency (repository TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,entity_id TEXT NOT NULL,PRIMARY KEY(repository,kind,request_key));")
        .map_err(|error|error.to_string())?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let scoped = request_key.map(|key| {
        if kind == "task" {
            key.to_string()
        } else {
            format!("{repository}:{key}")
        }
    });
    if let Some(key) = scoped.as_deref() {
        let existing: Option<String> = tx
            .query_row(
                "SELECT entity_id FROM idempotency WHERE repository=? AND kind=? AND request_key=?",
                params!["*", kind, key],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if let Some(id) = existing {
            tx.commit().map_err(|error| error.to_string())?;
            return Ok(id);
        }
    }
    let current: Option<i64> = tx
        .query_row(
            "SELECT value FROM sequences WHERE repository='*' AND kind=?",
            params![kind],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let mut next = (current.unwrap_or(0) as f64).max(snapshot_high_water(&tx, kind)?) + 1.0;
    while occupied.contains(&format!("{next:.0}")) {
        next += 1.0;
    }
    if !next.is_finite() || next > i64::MAX as f64 {
        return Err("Next ID exceeds SQLite integer range".into());
    }
    let numeric = next as i64;
    let id = format!("{next:.0}");
    tx.execute("INSERT INTO sequences VALUES ('*',?,?) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value",
        params![kind,numeric]).map_err(|error|error.to_string())?;
    if let Some(key) = scoped {
        tx.execute(
            "INSERT INTO idempotency VALUES ('*',?,?,?)",
            params![kind, key, id],
        )
        .map_err(|error| error.to_string())?;
    }
    tx.commit().map_err(|error| error.to_string())?;
    Ok(id)
}
