//! Observe verified release facts outside the Dashboard HTTP request path.
//! SQLite publication_state is a projection, not a second Job authority.
use crate::{
    publication_store::{
        load_publication_from_database, record_first_publication_in_database,
        record_publication_in_database,
    },
    relay_store_discovery::relay_unified_store_path,
    relayd::DaemonConfig,
};
use chrono::{DateTime, SecondsFormat, Utc};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
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
    if field(event, "kind") == "release" {
        if !verified_release(event, repository) {
            return None;
        }
    } else {
        if (!explicit_repository.is_empty() && explicit_repository != repository)
            || field(event, "job_id") != id
            || (explicit_repository.is_empty() && package != repository)
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

fn hex_sha(sha: &str) -> bool {
    sha.len() == 40
        && sha
            .bytes()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase())
}
fn verified_release(event: &Value, repository: &str) -> bool {
    let data = &event["data"];
    let outer = field(event, "job_id");
    let inner = field(data, "jobId");
    if !outer.is_empty() && !inner.is_empty() && outer != inner {
        return false;
    }

    let sha = field(data, "sha");
    let package = field(data, "package");
    let kind = field(event, "type");
    let status = field(event, "status");
    let remote = field(data, "repository");
    let registry = field(data, "registry");
    let ver = field(data, "version");
    static SEMVER: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let valid_version = SEMVER
        .get_or_init(|| regex::Regex::new(r"^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$").unwrap())
        .is_match(ver);
    // The bus no longer validates publication business data. Fail closed
    // on every field previously checked by the transport-side contract.
    let Some(fields)=data.as_object() else{return false;};
    if fields.keys().any(|k|!matches!(k.as_str(),"package"|"sha"|"registry"|"version"|"stage"|"jobId"|"repository"|"artifact")){
        return false;
    }
    static PACKAGE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static REPOSITORY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static ARTIFACT: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if !PACKAGE.get_or_init(||regex::Regex::new(r"^[a-z][a-z0-9-]{0,63}$").unwrap()).is_match(package)
        || data.get("version").is_some_and(|_|!valid_version)
        || data.get("jobId").is_some_and(|v|v.as_str().is_none_or(|id|id.is_empty()||!id.bytes().all(|b|b.is_ascii_digit())))
        || data.get("repository").is_some_and(|_|!REPOSITORY.get_or_init(||regex::Regex::new(r"^[A-Za-z0-9_.-]+/[a-z][a-z0-9-]{0,63}$").unwrap()).is_match(remote))
        || data.get("artifact").is_some_and(|_|{
            let artifact=field(data,"artifact");
            artifact.len()>214||!ARTIFACT.get_or_init(||regex::Regex::new(r"^(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$").unwrap()).is_match(artifact)
        })
    {return false;}

    field(event, "kind") == "release"
        && event["version"].as_u64() == Some(1)
        && package == repository
        && hex_sha(sha)
        && matches!(registry, "native" | "npm")
        && (remote.is_empty()
            || remote
                .split_once('/')
                .is_some_and(|(owner, name)| !owner.is_empty() && name == repository))
        && (registry != "npm" || (!remote.is_empty() && !field(data, "artifact").is_empty()))
        && event.pointer("/source/id").and_then(Value::as_str)
            == Some(format!("release/{package}/{sha}").as_str())
        && field(event, "event_id") == format!("release:{package}:{sha}:{kind}")
        && DateTime::parse_from_rfc3339(field(event, "timestamp")).is_ok()
        && match (kind, status) {
            ("package.published", "succeeded") => valid_version && data.get("stage").is_none(),
            ("package.publish_failed", "failed") => data["stage"].as_str().is_some_and(|s|!s.trim().is_empty() && s.encode_utf16().count()<=128),
            _ => false,
        }
}

fn repository_identity(root: &Path) -> Option<String> {
    let url = crate::local_git_merge::git(root, &["remote", "get-url", "origin"]).ok()?;
    let url = url.trim_end_matches('/').trim_end_matches(".git");
    let path = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("git@github.com:"))
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))?;
    let (owner, name) = path.split_once('/')?;
    (!owner.is_empty() && !name.is_empty() && !name.contains('/')).then(|| path.to_owned())
}

/// Earliest durable receipt whose timestamp follows the actual successful
/// merge and whose commit contains it. Never use chronological proximity
/// alone or bind an unmerged/unknown Job. Only repository-scoped observations.
fn correlate_releases(
    database: &Path,
    package: &str,
    rows: &[Value],
    stop: &AtomicBool,
    mut notify: impl FnMut(&Value),
) -> Result<(), String> {
    let mut releases: Vec<_> = rows
        .iter()
        .map(|r| &r["event"])
        .filter(|e| verified_release(e, package) && field(e, "type") == "package.published")
        .collect();
    releases.sort_by_key(|e| DateTime::parse_from_rfc3339(field(e, "timestamp")).ok());
    if releases.is_empty() {
        return Ok(());
    }
    let db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    // Relay repository identity is a unique immutable local root. Refuse
    // ambiguous historical bindings rather than assigning a release by name.
    let distinct_roots:i64=db.query_row(
        "SELECT count(DISTINCT json_extract(json,'$.projectRoot')) FROM job_snapshot WHERE json_extract(json,'$.repository')=?",
        [package],|r|r.get(0)).map_err(|e|e.to_string())?;
    if distinct_roots != 1 {
        return Ok(());
    }
    // Only unpublished completed Jobs are candidates; explicit publications
    // are processed first. The query doesn't hold a lock across Git I/O.
    let mut q = db
        .prepare(
            "SELECT j.json FROM job_snapshot j LEFT JOIN publication_state p ON p.job_id=j.job_id
        WHERE json_extract(j.json,'$.repository')=? AND json_extract(j.json,'$.state')='COMPLETED'
        AND json_extract(j.json,'$.localMerge.status')='succeeded'
        AND (p.json IS NULL OR json_extract(p.json,'$.latest') IS NULL)",
        )
        .map_err(|e| e.to_string())?;
    let jobs = q
        .query_map([package], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())?;
    drop(q);
    drop(db);
    // Compute actual ancestor sets once per repository/release per sweep.
    // The shared owned Git helper has bounded time and output.
    let mut ancestry: HashMap<(std::path::PathBuf, String), Option<HashSet<String>>> =
        HashMap::new();
    let mut roots: HashMap<std::path::PathBuf, Option<String>> = HashMap::new();
    for raw in jobs {
        if stop.load(Ordering::Acquire) {
            break;
        }
        let job: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let id = field(&job, "id");
        let merge = &job["localMerge"];
        let merged = field(merge, "mergedCommitSha");
        let Ok(merged_at) = DateTime::parse_from_rfc3339(field(merge, "updatedAt")) else {
            continue;
        };
        if id.is_empty() || !id.bytes().all(|c| c.is_ascii_digit()) || !hex_sha(merged) {
            continue;
        }
        let supplied = Path::new(field(&job, "projectRoot"));
        if !supplied.is_absolute() {
            continue;
        }
        let Ok(root) = supplied.canonicalize() else {
            continue;
        };
        if root.file_name().and_then(|n| n.to_str()) != Some(package) {
            continue;
        }
        if !roots.contains_key(&root) {
            let valid = crate::local_git_merge::git(&root, &["rev-parse", "--show-toplevel"])
                .ok()
                .and_then(|r| Path::new(&r).canonicalize().ok())
                .is_some_and(|r| r == root);
            if !valid {
                continue;
            }
            roots.insert(root.clone(), repository_identity(&root));
        }
        for event in &releases {
            if stop.load(Ordering::Acquire) {
                return Ok(());
            }
            let published_at = DateTime::parse_from_rfc3339(field(event, "timestamp")).unwrap();
            if published_at < merged_at {
                continue;
            }
            // Explicit legacy associations remain authoritative; a receipt
            // for one Job does not preclude other Jobs in the same release.
            let remote = field(&event["data"], "repository");
            if !remote.is_empty()
                && !roots
                    .get(&root)
                    .and_then(Option::as_deref)
                    .is_some_and(|v| v.eq_ignore_ascii_case(remote))
            {
                continue;
            }
            let sha = field(&event["data"], "sha");
            let key = (root.clone(), sha.to_owned());
            let ancestors = ancestry.entry(key).or_insert_with(|| {
                crate::local_git_merge::git(&root, &["rev-list", sha])
                    .ok()
                    .map(|lines| {
                        lines
                            .lines()
                            .filter(|s| hex_sha(s))
                            .map(str::to_owned)
                            .collect()
                    })
            });
            // An unknown/too-large ancestry result is not evidence. Don't
            // skip an earlier uncertain receipt and claim a later one.
            let Some(ancestors) = ancestors else {
                break;
            };
            if !ancestors.contains(merged) {
                continue;
            }
            let mut payload = event["data"].clone();
            payload["jobId"] = json!(id);
            let at = published_at
                .with_timezone(&Utc)
                .to_rfc3339_opts(SecondsFormat::Millis, true);
            payload["publishedAt"] = json!(at);
            payload["correlation"] = json!({"kind":"first-observed-ancestor","mergedCommitSha":merged,
                "releaseEventId":event["event_id"]});
            let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
                .map_err(|e| e.to_string())?;
            db.busy_timeout(Duration::from_millis(500))
                .map_err(|e| e.to_string())?;
            // A display-only notification, not a new bus publication fact.
            if record_first_publication_in_database(
                &mut db,
                id,
                field(event, "event_id"),
                &payload,
                &at,
            )? {
                let mut observation = (*event).clone();
                observation["job_id"] = json!(id);
                observation["data"] = payload;
                notify(&observation);
            }
            break;
        }
    }
    Ok(())
}

pub fn record_observed_event(database: &Path, event: &Value) -> Result<bool, String> {
    record_observed_event_inner(database, event, false)
}
fn record_observed_event_inner(
    database: &Path,
    event: &Value,
    background: bool,
) -> Result<bool, String> {
    let Some(id) = identity(event) else {
        return Ok(false);
    };
    // Never create a database, Job, or publication for an unknown Job.
    let mut db = Connection::open_with_flags(database, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_millis(500))
        .map_err(|e| e.to_string())?;
    let repository: Option<(String,Option<String>)> = db
        .query_row(
            "SELECT json_extract(json,'$.repository'),json_extract(json,'$.projectRoot') FROM job_snapshot WHERE job_id=?",
            [id],
            |row| Ok((row.get(0)?,row.get(1)?)),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let Some((repository, project_root)) = repository else {
        return Ok(false);
    };
    let remote = field(&event["data"], "repository");
    if field(event, "kind") == "release" && !remote.is_empty() {
        // Repository-origin Git I/O is only allowed in the independent
        // release observer, never in the scheduler's NATS drain or an API.
        if !background {
            return Ok(false);
        }

        let Some(root) = project_root.as_deref().map(Path::new) else {
            return Ok(false);
        };
        if !root.is_absolute()
            || !repository_identity(root).is_some_and(|v| v.eq_ignore_ascii_case(remote))
        {
            return Ok(false);
        }
    }
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
                for row in &rows {
                    if stop.load(Ordering::Acquire) {
                        return;
                    }
                    let event = &row["event"];
                    if field(&event["data"], "package") != package {
                        continue;
                    }
                    match record_observed_event_inner(&database, event, true) {
                        Ok(true) => publish(event),
                        Ok(false) => {}
                        Err(error) => {
                            eprintln!("warning: Dashboard publication projection: {error}")
                        }
                    }
                }
                if let Err(error) =
                    correlate_releases(&database, &package, &rows, stop, |event| publish(event))
                {
                    eprintln!("warning: Release ancestry projection: {error}");
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
    fn generic_release_consumer_rejects_malformed_metadata() {
        let mut raw=native(None,"2.0.1",&"a".repeat(40),"2026-11-25T10:00:00Z");
        raw.as_object_mut().unwrap().remove("kind");
        raw.as_object_mut().unwrap().remove("status");
        raw["data"]["registry"]=json!("npm");
        raw["data"]["repository"]=json!("owner/fixture");
        raw["data"]["artifact"]=json!("@owner/fixture");
        let valid=crate::events_bus_runtime::normalize_release_receipt(&raw).unwrap();
        assert!(verified_release(&valid,"fixture"));
        for (field,value) in [
            ("artifact",json!("bad artifact")),("registry",json!("unknown")),
            ("repository",json!("owner/other")),("jobId",json!(42)),
            ("stage",json!("unexpected stage")),("extra",json!(true)),
        ] {
            let mut invalid=raw.clone();invalid["data"][field]=value;
            assert!(!verified_release(&crate::events_bus_runtime::normalize_release_receipt(&invalid).unwrap(),"fixture"),"{field}");
        }
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
