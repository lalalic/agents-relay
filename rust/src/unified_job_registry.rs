// Direct port of Node src/unified-job-registry.ts: immutable local Git repository identity and atomic SQLite Job creation.
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::Value;

fn job_str<'a>(job: &'a Value, key: &str) -> Result<&'a str, String> {
    job.get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Job {key} must be a string"))
}
fn pr_number(job: &Value) -> Result<i64, String> {
    job.get("prNumber")
        .and_then(Value::as_i64)
        .ok_or_else(|| "Job prNumber must be an integer".into())
}

pub fn ensure_unified_job_registry(
    db: &Connection,
    job: &Value,
    expected_job_id: &str,
) -> Result<(), String> {
    let id = job_str(job, "id")?;
    if id != expected_job_id {
        return Err(format!(
            "Wrong scoped Job ID {id}; expected {expected_job_id}"
        ));
    }
    let repository = job_str(job, "repository")?;
    let pr_number = pr_number(job)?;
    db.execute("INSERT INTO source_registry(job_id,source_file,repository,pr_number) VALUES(?,?,?,?) ON CONFLICT(job_id) DO NOTHING",
        params![id,format!("unified:{id}"),repository,pr_number]).map_err(|error|error.to_string())?;
    let binding = db
        .query_row(
            "SELECT repository,pr_number FROM source_registry WHERE job_id=?",
            params![id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let Some((existing_repo, existing_number)) = binding else {
        return Err(format!("Job {id} has conflicting repository identity"));
    };
    if existing_repo != repository {
        return Err(format!("Job {id} has conflicting repository identity"));
    }
    if existing_number > 0 && pr_number != existing_number {
        return Err(format!("Job {id} cannot change an established PR binding"));
    }
    if existing_number == 0 && pr_number > 0 {
        db.execute(
            "UPDATE source_registry SET pr_number=? WHERE job_id=? AND pr_number=0",
            params![pr_number, id],
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// The callback writes the new immutable snapshot using the supplied SQLite
/// transaction; it never performs a GitHub PR or remote operation.
pub fn create_unified_job_if_absent(
    db: &mut Connection,
    job: &Value,
    mut write_snapshot: impl FnMut(&Transaction<'_>, &str) -> Result<(), String>,
) -> Result<Value, String> {
    let id = job_str(job, "id")?;
    let repository = job_str(job, "repository")?;
    let project_root = job_str(job, "projectRoot")?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let existing: Option<String> = tx
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?",
            params![id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    if let Some(existing) = existing.filter(|value| !value.is_empty()) {
        let result = serde_json::from_str::<Value>(&existing).map_err(|error| error.to_string())?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(result);
    }
    let mut query=tx.prepare("SELECT job_id,json FROM job_snapshot WHERE job_id<>? AND json_extract(json,'$.repository')=?")
        .map_err(|error|error.to_string())?;
    let rows = query
        .query_map(params![id, repository], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(query);
    for (sibling_id, raw) in rows {
        let prior: Value = serde_json::from_str(&raw).map_err(|error| error.to_string())?;
        let sibling_root = prior.get("projectRoot").and_then(Value::as_str);
        if sibling_root.is_none_or(|root| root.is_empty() || root != project_root) {
            let registered = sibling_root
                .filter(|root| !root.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| format!("unmigrated Job {sibling_id}"));
            return Err(format!("Local repository identity collision: {repository} belongs to {registered}, not {project_root}"));
        }
    }
    let now = crate::local_merge_lock::iso8601_now();
    write_snapshot(&tx, &now)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(job.clone())
}
