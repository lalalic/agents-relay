//! Observe verified release facts outside the Dashboard HTTP request path.
//! SQLite publication_state is a projection, not a second Job authority.
use crate::{
    publication_store::{load_publication_from_database, record_publication_in_database},
    relay_store_discovery::relay_unified_store_path,
    relayd::DaemonConfig,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};

fn field<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn identity(event: &Value) -> Option<&str> {
    let outer = field(event, "job_id");
    let inner = field(&event["data"], "jobId");
    if !outer.is_empty() && !inner.is_empty() && outer != inner {
        return None;
    }
    let id = if outer.is_empty() { inner } else { outer };
    if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(id)
}

/// Native releases carry a revision-bound receipt. Job-scoped receipts may
/// use the historical job event envelope and a namespaced package name.
fn verified(event: &Value, repository: &str) -> Option<(String, String, Value, bool)> {
    let id = identity(event)?;
    let data = event.get("data")?.as_object()?;
    let kind = field(event, "type");
    let success = match (kind, field(event, "status")) {
        ("package.published", "succeeded") => true,
        ("package.publish_failed", "failed") => false,
        _ => return None,
    };
    let receipt = field(event, "event_id");
    if receipt.is_empty() || receipt.len() > 512 || event.get("version")?.as_u64() != Some(1) {
        return None;
    }
    let at = DateTime::parse_from_rfc3339(field(event, "timestamp"))
        .ok()?
        .with_timezone(&Utc)
        .to_rfc3339_opts(SecondsFormat::Millis, true);
    let payload = event["data"].clone();
    let package = field(&payload, "package");
    let explicit_repository = field(&payload, "repository");
    if !explicit_repository.is_empty() && explicit_repository != repository {
        return None;
    }
    if field(event, "kind") == "release" {
        let sha = field(&payload, "sha");
        if !success
            || package != repository
            || field(&payload, "registry") != "native"
            || sha.len() != 40
            || !sha.bytes().all(|c| c.is_ascii_hexdigit())
            || event.pointer("/source/id")?.as_str()? != format!("release/{package}/{sha}")
            || receipt != format!("release:{package}:{sha}:package.published")
        {
            return None;
        }
    } else {
        // A Job event must actually carry the immutable outer scope.
        // Explicit repository metadata permits scoped npm package names.
        if field(event, "job_id") != id || (explicit_repository.is_empty() && package != repository)
        {
            return None;
        }
    }
    if success {
        let version = field(&payload, "version");
        if version.is_empty() || version.len() > 128 || version.chars().any(char::is_whitespace) {
            return None;
        }
    } else if field(&payload, "stage").is_empty() {
        return None;
    }
    let mut payload = Value::Object(data.clone());
    payload["jobId"] = json!(id);
    if success {
        payload["publishedAt"] = json!(at);
    }
    Some((receipt.to_owned(), at, payload, success))
}

pub fn record_observed_event(database: &Path, event: &Value) -> Result<bool, String> {
    let Some(id) = identity(event) else {
        return Ok(false);
    };
    // Never create a database, Job, or publication for an unknown Job.
    let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    let repository: Option<String> = db
        .query_row(
            "SELECT json_extract(json,'$.repository') FROM job_snapshot WHERE job_id=?",
            [id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some(repository) = repository else {
        return Ok(false);
    };
    let Some((receipt, at, payload, success)) = verified(event, &repository) else {
        return Ok(false);
    };
    // Keep newer durable publication/failure state, including historical
    // timestamps with a different RFC3339 precision or UTC offset.
    if let Some(previous) = load_publication_from_database(&db, id)? {
        if let (Ok(prior), Ok(next)) = (
            DateTime::parse_from_rfc3339(field(&previous, "updatedAt")),
            DateTime::parse_from_rfc3339(&at),
        ) {
            if prior >= next {
                return Ok(false);
            }
        }
    }
    record_publication_in_database(
        &mut db,
        id,
        &receipt,
        success.then_some(&payload),
        (!success).then_some(&payload),
        Some(&at),
    )
}

pub fn observe_releases(
    config: &DaemonConfig,
    runtime: &Value,
    stop: &AtomicBool,
    mut publish: impl FnMut(&Value),
) {
    let database = relay_unified_store_path(&config.store_directory);
    while !stop.load(Ordering::Acquire) {
        // Select distinct package keys from SQLite; don't parse every Job.
        let packages = (|| -> Result<BTreeSet<String>, String> {
            let db = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|e| e.to_string())?;
            db.pragma_update(None, "query_only", true)
                .map_err(|e| e.to_string())?;
            let mut q = db
                .prepare("SELECT DISTINCT json_extract(json,'$.repository') FROM job_snapshot")
                .map_err(|e| e.to_string())?;
            let rows = q
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<BTreeSet<_>, _>>()
                .map_err(|e| e.to_string())?;
            Ok(rows)
        })()
        .unwrap_or_default();
        for package in packages {
            if stop.load(Ordering::Acquire) {
                return;
            }
            if !config.repositories.is_empty() && !config.repositories.contains(&package) {
                continue;
            }
            if let Ok(rows) = crate::events_bus_runtime::events_bus_release_history_with_timeout(
                &package, 500, runtime, 2000,
            ) {
                for row in rows {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    let event = &row["event"];
                    if field(&event["data"], "package") != package {
                        continue;
                    }
                    match record_observed_event(&database, event) {
                        Ok(true) => publish(event),
                        Ok(false) => {}
                        Err(error) => {
                            eprintln!("warning: Dashboard publication projection: {error}")
                        }
                    }
                }
            }
        }
        // One bounded observer per daemon; no request-spawned workers.
        for _ in 0..50 {
            if stop.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn native(job: Option<&str>, version: &str, sha: &str, at: &str) -> Value {
        let mut e = json!({"version":1,"kind":"release","type":"package.published",
            "status":"succeeded","event_id":format!("release:fixture:{sha}:package.published"),
            "timestamp":at,"source":{"id":format!("release/fixture/{sha}")},
            "data":{"package":"fixture","version":version,"registry":"native","sha":sha}});
        if let Some(id) = job {
            e["job_id"] = json!(id);
        }
        e
    }
    #[test]
    fn accepts_explicit_job_correlation_but_not_jobless_or_conflicting_release() {
        let sha = "a".repeat(40);
        let at = "2026-11-25T10:00:00Z";
        let mut e = native(Some("42"), "2.0.1", &sha, at);
        assert!(verified(&e, "fixture").is_some());
        e["data"]["jobId"] = json!("43");
        assert!(verified(&e, "fixture").is_none());
        assert!(verified(&native(None, "2.0.1", &sha, at), "fixture").is_none());
        assert!(verified(&native(Some("42"), "2.0.1", &sha, at), "another").is_none());
        e.as_object_mut().unwrap().remove("job_id");
        assert!(verified(&e, "fixture").is_some());
    }
    #[test]
    fn persists_only_known_job_and_rejects_stale_duplicate() {
        let root = std::env::temp_dir().join(format!(
            "relay-dashboard-publication-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("relay.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);
            CREATE TABLE publication_state(job_id TEXT PRIMARY KEY,json TEXT NOT NULL);
            CREATE TABLE publication_delivery(job_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,json TEXT NOT NULL,observed_at TEXT NOT NULL,PRIMARY KEY(job_id,delivery_id));
            INSERT INTO job_snapshot VALUES('42','{\"id\":\"42\",\"repository\":\"fixture\"}');").unwrap();
        let mut event = native(Some("42"), "2.0.2", &"a".repeat(40), "2026-11-25T10:00:00Z");
        assert!(record_observed_event(&path, &event).unwrap());
        assert!(!record_observed_event(&path, &event).unwrap());
        assert!(!record_observed_event(
            &path,
            &native(Some("42"), "2.0.1", &"b".repeat(40), "2026-11-25T09:59:59Z")
        )
        .unwrap());
        assert!(!record_observed_event(
            &path,
            &native(Some("43"), "2.0.3", &"c".repeat(40), "2026-11-25T10:01:00Z")
        )
        .unwrap());
        assert_eq!(
            load_publication_from_database(&db, "42").unwrap().unwrap()["latest"]["version"],
            "2.0.2"
        );
        event = json!({"version":1,"job_id":"42","type":"package.published","status":"succeeded","event_id":"scoped-publish",
            "timestamp":"2026-11-25T10:02:00Z","data":{"package":"@example/fixture","repository":"fixture","version":"2.0.3"}});
        assert!(record_observed_event(&path, &event).unwrap());
        assert_eq!(
            load_publication_from_database(&db, "42").unwrap().unwrap()["latest"]["version"],
            "2.0.3"
        );
        drop(db);
        std::fs::remove_dir_all(root).unwrap();
    }
}
