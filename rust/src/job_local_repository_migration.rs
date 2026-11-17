// Direct port of src/job-local-repository-migration.ts.
// Strict preflight -> verified original backup -> single SQLite transaction.
// Never touches a database except the explicit caller-owned path.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Duration,
};

fn git(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|e| e.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}
fn canonical(path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(path).map_err(|e| e.to_string())
}
fn validate_root(input: &str) -> Result<PathBuf, String> {
    let path = Path::new(input);
    if !path.is_absolute() {
        return Err("Job projectRoot must be absolute".into());
    }
    let root = canonical(path)?;
    let top = canonical(Path::new(&git(&root, &["rev-parse", "--show-toplevel"])?))?;
    if root != top {
        return Err(format!(
            "Job projectRoot must be the canonical Git root: {}",
            top.display()
        ));
    }
    let git_dir = canonical(Path::new(&git(
        &root,
        &["rev-parse", "--absolute-git-dir"],
    )?))?;
    let common = canonical(Path::new(&git(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?))?;
    if git_dir != common {
        return Err(
            "Job projectRoot must be the primary Git checkout, not a linked worktree".into(),
        );
    }
    Ok(root)
}
pub fn migration_backup_path(path: &Path) -> PathBuf {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir().unwrap_or_default().join(path)
    };
    PathBuf::from(format!(
        "{}.pre-local-repository-v1.bak",
        absolute.display()
    ))
}
fn recursive_rewrite(v: &Value, aliases: &HashMap<String, String>) -> Value {
    match v {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|x| recursive_rewrite(x, aliases))
                .collect(),
        ),
        Value::Object(entries) => {
            let mut output = serde_json::Map::new();
            for (key, item) in entries {
                let replacement = if key == "repository" {
                    item.as_str()
                        .and_then(|text| aliases.get(text))
                        .map(|s| Value::String(s.clone()))
                } else {
                    None
                };
                output.insert(
                    key.clone(),
                    replacement.unwrap_or_else(|| recursive_rewrite(item, aliases)),
                );
            }
            Value::Object(output)
        }
        _ => v.clone(),
    }
}
struct Plan {
    id: String,
    old_repository: String,
    repository: String,
    root: String,
    github_repo: Option<String>,
    job: Value,
}
struct Outbox {
    job_id: String,
    id: i64,
    payload: Option<String>,
    definition: Option<String>,
    evidence: Option<String>,
    resolution: Option<String>,
}
fn rewrite_json(
    raw: Option<String>,
    aliases: &HashMap<String, String>,
    remote: Option<&str>,
    external: bool,
    owner: &str,
    operation: &str,
) -> Result<Option<String>, String> {
    raw.map(|raw|{
        let parsed:Value=serde_json::from_str(&raw).map_err(|e|e.to_string())?;
        let mut output=recursive_rewrite(&parsed,aliases);
        if external && output["repository"].is_string(){
            let remote=remote.ok_or_else(||format!("Job {owner} has pending GitHub operation {operation} but no explicit githubRepo mapping"))?;
            output["repository"]=Value::String(remote.to_owned());
        }
        Ok(output.to_string())
    }).transpose()
}
pub fn migrate_job_local_repositories(
    database: &Path,
    mapping_path: &Path,
) -> Result<(usize, PathBuf), String> {
    let db_path = if database.is_absolute() {
        database.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|e| e.to_string())?
            .join(database)
    };
    let mapping: Value =
        serde_json::from_slice(&fs::read(mapping_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let items = mapping["jobs"]
        .as_array()
        .ok_or("Mapping file must have version: 1 and jobs: []")?;
    if mapping["version"] != 1 {
        return Err("Mapping file must have version: 1 and jobs: []".into());
    }
    let mut db = Connection::open(&db_path).map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(10000))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA wal_checkpoint(FULL)")
        .map_err(|e| e.to_string())?;
    let rows: Vec<(String, String)> = {
        let mut stmt = db
            .prepare("SELECT job_id,json FROM job_snapshot ORDER BY job_id")
            .map_err(|e| e.to_string())?;
        let selected = stmt
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        selected
    };
    let ids: HashSet<_> = rows.iter().map(|(id, _)| id.clone()).collect();
    let mut map = HashMap::new();
    for item in items {
        let id = item["jobId"]
            .as_str()
            .ok_or("Mapping jobId must be a string")?
            .to_owned();
        if map.insert(id.clone(), item).is_some() {
            return Err(
                "Migration mapping must contain exactly one entry for every durable Job ID".into(),
            );
        }
    }
    if map.len() != rows.len() || map.keys().any(|id| !ids.contains(id)) {
        return Err(
            "Migration mapping must contain exactly one entry for every durable Job ID".into(),
        );
    }
    let mut identities = HashMap::<String, String>::new();
    let mut plans = Vec::<Plan>::new();
    for (id, raw) in rows {
        let job: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let mapping = map
            .get(&id)
            .ok_or("Migration mapping must contain exactly one entry for every durable Job ID")?;
        let root = validate_root(
            mapping["projectRoot"]
                .as_str()
                .ok_or("Missing mapping projectRoot")?,
        )?;
        let repository = root
            .file_name()
            .ok_or("Git root has no basename")?
            .to_string_lossy()
            .to_string();
        let root = root.to_string_lossy().to_string();
        if let Some(old) = identities.insert(repository.clone(), root.clone()) {
            if old != root {
                return Err(format!(
                    "Local repository identity collision {repository}: {old} and {root}"
                ));
            }
        }
        let remote = mapping["githubRepo"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if remote
            .as_ref()
            .is_some_and(|s| s.split('/').count() != 2 || s.split('/').any(str::is_empty))
        {
            return Err(format!("Invalid GitHub remote for Job {id}"));
        }
        plans.push(Plan {
            id,
            old_repository: job["repository"].as_str().unwrap_or("").into(),
            repository,
            root,
            github_repo: remote,
            job,
        });
    }
    let mut aliases = HashMap::<String, String>::new();
    for plan in &plans {
        if let Some(existing) = aliases.insert(plan.old_repository.clone(), plan.repository.clone())
        {
            if existing != plan.repository {
                return Err(format!(
                    "Historical repository alias {} maps to multiple local repositories",
                    plan.old_repository
                ));
            }
        }
    }
    for plan in &plans {
        let registered: Option<String> = db
            .query_row(
                "SELECT repository FROM source_registry WHERE job_id=?",
                params![plan.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if registered.as_deref() != Some(&plan.old_repository) {
            return Err(format!(
                "source_registry does not match Job {}; repair mapping explicitly before migration",
                plan.id
            ));
        }
    }
    let mut updates = Vec::new();
    for plan in &plans {
        let mut rewritten = recursive_rewrite(&plan.job, &aliases);
        rewritten["projectRoot"] = Value::String(plan.root.clone());
        rewritten["repository"] = Value::String(plan.repository.clone());
        if let Some(remote) = &plan.github_repo {
            rewritten["githubRepo"] = Value::String(remote.clone());
        } else if let Some(object) = rewritten.as_object_mut() {
            object.remove("githubRepo");
        }
        updates.push((
            plan.id.clone(),
            plan.repository.clone(),
            rewritten.to_string(),
        ));
    }
    let mut outbox = Vec::new();
    {
        let mut stmt=db.prepare("SELECT scope_job_id,id,operation,payload_json,conflict_definition_json,conflict_evidence_json,conflict_resolution_json FROM projection_outbox").map_err(|e|e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (job_id, id, operation, payload, definition, evidence, resolution) =
                row.map_err(|e| e.to_string())?;
            let owner = plans.iter().find(|p| p.id == job_id).ok_or_else(|| {
                format!("Pending external operation is scoped to unmapped Job {job_id}")
            })?;
            let remote = owner.github_repo.as_deref();
            let external = matches!(
                operation.as_str(),
                "create_pull_request" | "close_pull_request"
            );
            outbox.push(Outbox {
                job_id: job_id.clone(),
                id,
                payload: rewrite_json(payload, &aliases, remote, external, &job_id, &operation)?,
                definition: rewrite_json(
                    definition, &aliases, remote, external, &job_id, &operation,
                )?,
                evidence: rewrite_json(evidence, &aliases, remote, external, &job_id, &operation)?,
                resolution: rewrite_json(
                    resolution, &aliases, remote, external, &job_id, &operation,
                )?,
            });
        }
    }
    let backup_path = migration_backup_path(&db_path);
    if !backup_path.exists() {
        fs::copy(&db_path, &backup_path).map_err(|e| {
            format!(
                "Cannot create migration backup {}: {e}",
                backup_path.display()
            )
        })?;
    }
    let backup =
        Connection::open_with_flags(&backup_path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    let count: i64 = backup
        .query_row("SELECT COUNT(*) FROM job_snapshot", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    if count != updates.len() as i64 {
        return Err("Migration backup verification failed".into());
    }
    drop(backup);
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    for (id, repository, json) in &updates {
        tx.execute(
            "UPDATE job_snapshot SET json=?,updated_at=updated_at WHERE job_id=?",
            params![json, id],
        )
        .map_err(|e| e.to_string())?;
        let changed = tx
            .execute(
                "UPDATE source_registry SET repository=? WHERE job_id=?",
                params![repository, id],
            )
            .map_err(|e| e.to_string())?;
        if changed != 1 {
            return Err(format!("Missing source_registry entry for Job {id}"));
        }
    }
    for item in &outbox {
        tx.execute("UPDATE projection_outbox SET payload_json=?,conflict_definition_json=?,conflict_evidence_json=?,conflict_resolution_json=? WHERE scope_job_id=? AND id=?",
            params![item.payload,item.definition,item.evidence,item.resolution,item.job_id,item.id])
            .map_err(|e|e.to_string())?;
    }
    tx.execute("INSERT INTO migration_metadata(key,value) VALUES('local-repository-v1',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![crate::local_merge_lock::iso8601_now()]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok((updates.len(), backup_path))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recursive_references_dont_modify_non_repository_fields() {
        let aliases = HashMap::from([("old/repo".to_string(), "repo".to_string())]);
        let input = serde_json::json!({"repository":"old/repo","nested":[{"repository":"old/repo","message":"old/repo"}]});
        assert_eq!(
            recursive_rewrite(&input, &aliases),
            serde_json::json!({"repository":"repo","nested":[{"repository":"repo","message":"old/repo"}]})
        );
    }
}
