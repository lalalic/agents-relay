// Direct port of Node src/task-id-migration.ts: offline-only SQLite backup, numeric Task-ID rewrite and atomic cross-table migration.
use rusqlite::{
    backup::Backup, params, Connection, OpenFlags, OptionalExtension, Transaction,
    TransactionBehavior,
};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path, PathBuf},
    time::Duration,
};

const META_KEY: &str = "task_id_numeric_migration";
const REFERENCES: &[&str] = &[
    "taskId",
    "task_id",
    "parentTaskId",
    "parent_task_id",
    "originalTaskId",
    "targetTaskId",
    "recoveryTaskId",
    "reviewTaskId",
    "revisionTaskId",
    "coordinatorTaskId",
];
const ID_LISTS: &[&str] = &["dependencies", "generatedTaskIds", "restateTaskIds"];
const ID_KEYED_OBJECTS: &[&str] = &["dependencyValidity", "dependencyVector"];

fn path_resolve(raw: &str) -> Result<PathBuf, String> {
    let path = Path::new(raw);
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    let mut root = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                root.pop();
            }
            Component::CurDir => {}
            other => root.push(other.as_os_str()),
        }
    }
    Ok(root)
}
fn sqlite_error(error: rusqlite::Error) -> String {
    error.to_string()
}
fn js_truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        _ => true,
    }
}
fn string_property<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}
fn rewrite_json(
    value: &Value,
    ids: &HashMap<String, String>,
    parent_key: &str,
    task_record: bool,
) -> Value {
    if parent_key == "input" {
        if let Some(original) = value
            .as_str()
            .filter(|original| original.trim_start().starts_with('{'))
        {
            if let Ok(parsed) = serde_json::from_str::<Value>(original) {
                return Value::String(rewrite_json(&parsed, ids, "", false).to_string());
            }
        }
    }
    match value {
        Value::Array(list) => Value::Array(
            list.iter()
                .map(|item| {
                    if ID_LISTS.contains(&parent_key) {
                        if let Some(text) = item.as_str() {
                            return json!(ids.get(text).map(String::as_str).unwrap_or(text));
                        }
                    }
                    rewrite_json(item, ids, parent_key, false)
                })
                .collect(),
        ),
        Value::Object(object) => {
            let mut output = Map::new();
            for (key, item) in object {
                let new_key = if ID_KEYED_OBJECTS.contains(&parent_key) {
                    ids.get(key).cloned().unwrap_or_else(|| key.clone())
                } else {
                    key.clone()
                };
                let mapped = if (task_record && key == "id")
                    || REFERENCES.contains(&key.as_str())
                    || (parent_key == "nodes" && item.is_string())
                {
                    if let Some(text) = item.as_str() {
                        json!(ids.get(text).map(String::as_str).unwrap_or(text))
                    } else {
                        item.clone()
                    }
                } else if key == "tasks" || key == "next_tasks" {
                    if let Some(tasks) = item.as_array() {
                        Value::Array(
                            tasks
                                .iter()
                                .map(|task| rewrite_json(task, ids, "", true))
                                .collect(),
                        )
                    } else {
                        item.clone()
                    }
                } else if parent_key == "dependencyVector" && item.is_string() {
                    let text = item.as_str().unwrap_or("");
                    if let Some(position) = text.find(':') {
                        if let Some(new_id) = ids.get(&text[..position]) {
                            json!(format!("{new_id}{}", &text[position..]))
                        } else {
                            item.clone()
                        }
                    } else {
                        item.clone()
                    }
                } else if key == "value"
                    && item.as_object().is_some_and(|value| {
                        ["jobId", "dependencies", "parentTaskId"]
                            .iter()
                            .all(|name| value.contains_key(*name))
                    })
                {
                    rewrite_json(item, ids, key, true)
                } else {
                    rewrite_json(item, ids, key, false)
                };
                output.insert(new_key, mapped);
            }
            Value::Object(output)
        }
        Value::String(text) if REFERENCES.contains(&parent_key) || parent_key == "nodes" => {
            json!(ids.get(text).map(String::as_str).unwrap_or(text))
        }
        _ => value.clone(),
    }
}
fn rows_for_jobs(db: &Connection, sql: &str) -> Result<Vec<(String, String)>, String> {
    let mut query = db.prepare(sql).map_err(sqlite_error)?;
    let rows = query
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}
fn table_names(tx: &Transaction<'_>) -> Result<Vec<String>, String> {
    let mut query = tx
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .map_err(sqlite_error)?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}
fn quote_identifier(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}
fn table_columns(tx: &Transaction<'_>, table: &str) -> Result<Vec<String>, String> {
    let sql = format!("PRAGMA table_info({})", quote_identifier(table));
    let mut query = tx.prepare(&sql).map_err(sqlite_error)?;
    let rows = query
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(sqlite_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sqlite_error)
}

pub fn migrate_task_ids(database_path: &str, backup_path: &str) -> Result<Value, String> {
    let path = path_resolve(database_path)?;
    let backup = path_resolve(backup_path)?;
    if path == backup {
        return Err("Backup path must differ from database path".into());
    }
    let mut db = Connection::open(&path).map_err(sqlite_error)?;
    db.busy_timeout(Duration::from_millis(10000))
        .map_err(sqlite_error)?;
    let marker: Option<String> = db
        .query_row(
            "SELECT value FROM migration_metadata WHERE key=?",
            params![META_KEY],
            |row| row.get(0),
        )
        .optional()
        .map_err(sqlite_error)?;
    let original = rows_for_jobs(&db, "SELECT job_id,json FROM job_snapshot")?;
    for (job_id, payload) in &original {
        let job: Value = serde_json::from_str(payload).map_err(|error| error.to_string())?;
        if job.get("state").and_then(Value::as_str) == Some("ACTIVE") {
            return Err(format!("Preflight failed: Job {job_id} is ACTIVE"));
        }
    }
    let current_seq = db
        .query_row(
            "SELECT value FROM sequences WHERE repository='*' AND kind='task'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(sqlite_error)?
        .unwrap_or(0);
    if marker.as_deref() == Some("complete") {
        return Ok(
            json!({"backupPath":backup.to_string_lossy(),"taskCount":0,"duplicateTaskRecords":0,
        "maxId":current_seq,"alreadyMigrated":true}),
        );
    }
    if backup.exists() {
        return Err(format!("Backup already exists: {}", backup.display()));
    }
    if let Some(parent) = backup.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    {
        let mut destination = Connection::open(&backup).map_err(sqlite_error)?;
        let backup_handle = Backup::new(&db, &mut destination).map_err(sqlite_error)?;
        backup_handle
            .run_to_completion(128, Duration::from_millis(2), None)
            .map_err(sqlite_error)?;
    }
    {
        let copy = Connection::open_with_flags(&backup, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(sqlite_error)?;
        let integrity: String = copy
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .map_err(sqlite_error)?;
        if integrity != "ok" {
            return Err("Migration backup failed integrity_check".into());
        }
        let count: i64 = copy
            .query_row("SELECT COUNT(*) AS n FROM job_snapshot", [], |row| {
                row.get(0)
            })
            .map_err(sqlite_error)?;
        if count != original.len() as i64 {
            return Err("Migration backup Job count mismatch".into());
        }
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(sqlite_error)?;
    let result = migrate_in_transaction(&tx, &original, current_seq)?;
    tx.commit().map_err(sqlite_error)?;
    Ok(
        json!({"backupPath":backup.to_string_lossy(),"taskCount":result.0,
    "duplicateTaskRecords":result.1,"maxId":result.2,"alreadyMigrated":false}),
    )
}
fn migrate_in_transaction(
    tx: &Transaction<'_>,
    existing: &[(String, String)],
    current_seq: i64,
) -> Result<(i64, i64, i64), String> {
    let rows = rows_for_jobs(
        tx,
        "SELECT job_id,json FROM job_snapshot ORDER BY CAST(job_id AS INTEGER),job_id",
    )?;
    if rows.len() != existing.len()
        || rows.iter().any(|(job_id, payload)| {
            !existing.iter().any(|(original_id, original_payload)| {
                original_id == job_id && original_payload == payload
            })
        })
    {
        return Err("Job data changed after backup; migration refused".into());
    }
    let mut mappings = HashMap::<String, HashMap<String, String>>::new();
    let mut assigned = HashMap::<String, Vec<String>>::new();
    let (mut count, mut duplicate) = (0i64, 0i64);
    for (job_id, payload) in &rows {
        let job: Value = serde_json::from_str(payload).map_err(|error| error.to_string())?;
        let tasks = job.get("tasks").and_then(Value::as_array);
        let mut aliases = HashMap::<String, String>::new();
        let mut local = Vec::new();
        for task in tasks.into_iter().flatten() {
            let Some(id) = string_property(task, "id").filter(|id| !id.is_empty()) else {
                return Err(format!("Invalid Task ID in Job {job_id}"));
            };
            count += 1;
            let new_id = count.to_string();
            local.push(new_id.clone());
            if aliases.contains_key(id) {
                duplicate += 1;
            } else {
                aliases.insert(id.to_string(), new_id);
            }
        }
        mappings.insert(job_id.to_string(), aliases);
        assigned.insert(job_id.to_string(), local);
    }
    {
        let mut update = tx
            .prepare("UPDATE job_snapshot SET json=? WHERE job_id=?")
            .map_err(sqlite_error)?;
        for (job_id, payload) in &rows {
            let ids = mappings.get(job_id).expect("one alias map per job");
            let mut job = rewrite_json(
                &serde_json::from_str::<Value>(payload).map_err(|error| error.to_string())?,
                ids,
                "",
                false,
            );
            if let Some(tasks) = job.get_mut("tasks").and_then(Value::as_array_mut) {
                for (index, task) in tasks.iter_mut().enumerate() {
                    let number = &assigned[job_id][index];
                    let Some(object) = task.as_object_mut() else {
                        continue;
                    };
                    object.insert("id".into(), json!(number));
                    if object.get("parentTaskId").and_then(Value::as_str) == Some("orchestrator") {
                        object.insert("parentTaskId".into(), Value::Null);
                    }
                    let agent = object
                        .get("agentName")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    let title = if js_truthy(object.get("agentGraph")) {
                        Some("Coordinator".to_string())
                    } else if agent == "troubleshooter" {
                        Some("Troubleshooter".into())
                    } else if agent == "job-acceptance-reviewer" || agent == "reviewer" {
                        Some("Final Review".into())
                    } else if js_truthy(object.get("dagNode")) && !agent.is_empty() {
                        Some(agent)
                    } else {
                        None
                    };
                    if let Some(title) = title {
                        object.insert("title".into(), json!(title));
                    }
                }
            }
            update
                .execute(params![job.to_string(), job_id])
                .map_err(sqlite_error)?;
        }
    }
    let tables = table_names(tx)?;
    for name in &tables {
        let escaped = quote_identifier(name);
        let columns = table_columns(tx, name)?;
        let names = columns.iter().map(String::as_str).collect::<HashSet<_>>();
        let job_col = if names.contains("job_id") {
            Some("job_id")
        } else if names.contains("scope_job_id") {
            Some("scope_job_id")
        } else {
            None
        };
        let Some(job_col) = job_col else { continue };
        if name == "job_snapshot" {
            continue;
        }
        if names.contains("task_id") {
            let sql = format!("SELECT rowid,{job_col} AS owner,task_id FROM {escaped}");
            let mut query = tx.prepare(&sql).map_err(sqlite_error)?;
            let rows = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                })
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            let changed = rows
                .iter()
                .filter_map(|(rowid, owner, id)| {
                    let id = id.as_deref()?;
                    let next = mappings.get(owner)?.get(id)?;
                    Some((*rowid, next.clone()))
                })
                .collect::<Vec<_>>();
            let mut update = tx
                .prepare(&format!("UPDATE {escaped} SET task_id=? WHERE rowid=?"))
                .map_err(sqlite_error)?;
            for (rowid, _) in &changed {
                update
                    .execute(params![format!("__task_id_migration_{rowid}__"), rowid])
                    .map_err(sqlite_error)?;
            }
            for (rowid, next) in &changed {
                update.execute(params![next, rowid]).map_err(sqlite_error)?;
            }
        }
        for field in &columns {
            if field != "json" && !field.ends_with("_json") {
                continue;
            }
            let escaped_field = quote_identifier(field);
            let sql=format!("SELECT rowid,{job_col} AS owner,{escaped_field} AS payload FROM {escaped} WHERE {escaped_field} IS NOT NULL");
            let mut query = tx.prepare(&sql).map_err(sqlite_error)?;
            let records = query
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                    ))
                })
                .map_err(sqlite_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sqlite_error)?;
            let mut update = tx
                .prepare(&format!(
                    "UPDATE {escaped} SET {escaped_field}=? WHERE rowid=?"
                ))
                .map_err(sqlite_error)?;
            for (rowid, owner, raw) in records {
                let Some(ids) = mappings.get(&owner) else {
                    continue;
                };
                let Ok(parsed) = serde_json::from_str::<Value>(&raw) else {
                    continue;
                };
                let changed = rewrite_json(&parsed, ids, "", false).to_string();
                if changed != raw {
                    update
                        .execute(params![changed, rowid])
                        .map_err(sqlite_error)?;
                }
            }
        }
    }
    if tables.iter().any(|name| name == "workflow_event_outbox") {
        let mut query = tx
            .prepare("SELECT rowid,payload_json FROM workflow_event_outbox")
            .map_err(sqlite_error)?;
        let rows = query
            .query_map([], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        let mut update = tx
            .prepare("UPDATE workflow_event_outbox SET payload_json=? WHERE rowid=?")
            .map_err(sqlite_error)?;
        for (rowid, raw) in rows {
            let Ok(event) = serde_json::from_str::<Value>(&raw) else {
                continue;
            };
            let Some(ids) =
                string_property(&event, "job_id").and_then(|job_id| mappings.get(job_id))
            else {
                continue;
            };
            let changed = rewrite_json(&event, ids, "", false).to_string();
            if changed != raw {
                update
                    .execute(params![changed, rowid])
                    .map_err(sqlite_error)?;
            }
        }
    }
    if tables.iter().any(|name| name == "idempotency") {
        let mut query = tx
            .prepare("SELECT rowid,request_key,entity_id FROM idempotency WHERE kind='task'")
            .map_err(sqlite_error)?;
        let entries = query
            .query_map([], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(sqlite_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sqlite_error)?;
        let mut update = tx
            .prepare("UPDATE idempotency SET entity_id=? WHERE rowid=?")
            .map_err(sqlite_error)?;
        let mut remove = tx
            .prepare("DELETE FROM idempotency WHERE rowid=?")
            .map_err(sqlite_error)?;
        for (rowid, request_key, entity_id) in entries {
            let candidates = mappings
                .iter()
                .filter_map(|(job_id, ids)| ids.get(&entity_id).map(|next| (job_id, next)))
                .collect::<Vec<_>>();
            let chosen = if candidates.len() == 1 {
                candidates.first().copied()
            } else {
                candidates
                    .iter()
                    .copied()
                    .find(|(job_id, _)| request_key.contains(&format!(":{job_id}:")))
            };
            if let Some((_, next)) = chosen {
                update.execute(params![next, rowid]).map_err(sqlite_error)?;
            } else {
                remove.execute(params![rowid]).map_err(sqlite_error)?;
            }
        }
    }
    let next = count.max(current_seq);
    tx.execute("INSERT INTO sequences(repository,kind,value) VALUES('*','task',?) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value",params![next]).map_err(sqlite_error)?;
    tx.execute("INSERT INTO migration_metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![META_KEY,"complete"]).map_err(sqlite_error)?;
    Ok((count, duplicate, next))
}
