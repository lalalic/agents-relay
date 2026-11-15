//! Rust-native Node-compatible Agent registry commands backed by Relay SQLite.
use agents_relay_rust::native_daemon::isolated_store_root;
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

fn options(args: &[String], command: &str) -> Result<(HashMap<String, String>, bool), String> {
    let register = command == "agent-register";
    let allowed: &[&str] = if register {
        &[
            "--db",
            "--id",
            "--repo",
            "--agent-id",
            "--name",
            "--responsibility",
            "--role",
            "--capabilities",
            "--boundaries",
            "--endpoint",
            "--endpoint-kind",
            "--runtime",
            "--adapter",
            "--provider",
            "--model",
            "--availability",
            "--labels",
            "--trust-domains",
            "--regions",
        ]
    } else {
        &[
            "--db",
            "--id",
            "--repo",
            "--capabilities",
            "--runtime",
            "--availability",
            "--trust-domain",
            "--task-kind",
        ]
    };
    let mut parsed = HashMap::new();
    let mut explore = false;
    let mut no_github = false;
    let mut index = 0;
    while index < args.len() {
        let key = args[index].as_str();
        if key == "--no-github" {
            if no_github {
                return Err("duplicate option --no-github".into());
            }
            no_github = true;
            index += 1;
            continue;
        }
        if !register && key == "--explore" {
            if explore {
                return Err("duplicate option --explore".into());
            }
            explore = true;
            index += 1;
            continue;
        }
        if key == "--file" {
            return Err("--file is unsupported by relay-native-job: local JSON demo mode is not a SQLite authority".into());
        }
        if key == "--store-dir" {
            return Err("--store-dir is unsupported by relay-native-job: pass the authoritative SQLite file with --db".into());
        }
        if !allowed.contains(&key) {
            return Err(format!(
                "unsupported {command} option {key}: no Rust-native parity"
            ));
        }
        if parsed.contains_key(key) {
            return Err(format!("duplicate option {key}"));
        }
        let value = args
            .get(index + 1)
            .filter(|value| !value.starts_with("--"))
            .ok_or_else(|| format!("{key} requires a value"))?;
        parsed.insert(key.to_owned(), value.clone());
        index += 2;
    }
    Ok((parsed, explore))
}

fn split_list(value: Option<&String>, delimiter: char) -> Vec<String> {
    value
        .map(|value| {
            value
                .split(delimiter)
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}
fn enum_list(value: Option<&String>, name: &str) -> Result<Vec<String>, String> {
    let values = split_list(value, ',');
    for value in &values {
        if !["available", "degraded", "offline"].contains(&value.as_str()) {
            return Err(format!("{name} values must be available, degraded, or offline (Node AgentAvailability has no busy state)"));
        }
    }
    Ok(values)
}
fn required<'a>(opts: &'a HashMap<String, String>, name: &str) -> Result<&'a str, String> {
    opts.get(name)
        .map(String::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("{name} is required and must be nonempty"))
}
fn validated_db(opts: &HashMap<String, String>) -> Result<PathBuf, String> {
    let path = PathBuf::from(required(opts, "--db")?);
    if !path.is_absolute() {
        return Err("--db must be absolute".into());
    }
    isolated_store_root(&path)?;
    Ok(path)
}
fn has_column(db: &Connection, table: &str, column: &str) -> Result<bool, String> {
    let mut statement = db
        .prepare(&format!(
            "PRAGMA table_info('{}')",
            table.replace('\'', "''")
        ))
        .map_err(|e| e.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|e| e.to_string())?;
    for found in columns {
        if found.map_err(|e| e.to_string())? == column {
            return Ok(true);
        }
    }
    Ok(false)
}
fn validate_job_binding(
    db: &Connection,
    job_id: &str,
    repo: &str,
    path: &Path,
) -> Result<(), String> {
    let job: Option<String> = db
        .query_row(
            "SELECT json FROM job_snapshot WHERE job_id=?1",
            [job_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|e| e.to_string())?;
    let job = job.ok_or_else(|| format!("Job {job_id} not found in {}", path.display()))?;
    let job: Value =
        serde_json::from_str(&job).map_err(|e| format!("invalid Job snapshot: {e}"))?;
    if job["id"].as_str() != Some(job_id) || job["repository"].as_str() != Some(repo) {
        return Err("Job identity/repository trust boundary mismatch".into());
    }
    if has_column(db, "agent_snapshot", "scope_job_id")? {
        let binding: Option<String> = db
            .query_row(
                "SELECT repository FROM source_registry WHERE job_id=?1",
                [job_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if binding.as_deref() != Some(repo) {
            return Err("source_registry Job/repository trust boundary mismatch".into());
        }
    }
    Ok(())
}
fn open_registry(
    path: &Path,
    opts: &HashMap<String, String>,
) -> Result<(Connection, String, String, bool), String> {
    let job_id = required(opts, "--id")?;
    let repo = required(opts, "--repo")?;
    let db = Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_WRITE | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.pragma_update(None, "foreign_keys", "ON")
        .map_err(|e| e.to_string())?;
    validate_job_binding(&db, job_id, repo, path)?;
    let scoped = has_column(&db, "agent_snapshot", "scope_job_id").map_err(|_| {
        "canonical agent_snapshot table is missing; initialize Relay SQLite schema first"
            .to_string()
    })?;
    if !has_column(&db, "agent_snapshot", "agent_id")?
        || !has_column(&db, "agent_snapshot", "json")?
        || !has_column(&db, "agent_snapshot", "updated_at")?
    {
        return Err("canonical agent_snapshot table has an unsupported layout".into());
    }
    Ok((db, job_id.to_owned(), repo.to_owned(), scoped))
}
fn list_agents(db: &Connection, job_id: &str, scoped: bool) -> Result<Vec<Value>, String> {
    let sql = if scoped {
        "SELECT json FROM agent_snapshot WHERE scope_job_id=?1 ORDER BY agent_id"
    } else {
        "SELECT json FROM agent_snapshot ORDER BY agent_id"
    };
    let mut statement = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = if scoped {
        statement
            .query_map([job_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
    } else {
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
    }
    .map_err(|e| e.to_string())?;
    rows.iter()
        .map(|row| serde_json::from_str(row).map_err(|e| format!("invalid Agent snapshot: {e}")))
        .collect()
}
fn register(args: &[String]) -> Result<Value, String> {
    if std::env::var("RELAY_RUST_LIVE_MODE").ok().as_deref() == Some("pilot-live") {
        return Err("live agent-register requires daemon-owned authenticated control; refusing a competing SQLite writer".into());
    }
    let (opts, _) = options(args, "agent-register")?;
    let path = validated_db(&opts)?;
    let id = opts
        .get("--agent-id")
        .cloned()
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    if id.trim().is_empty() {
        return Err("--agent-id must be nonempty".into());
    }
    let name = required(&opts, "--name")?;
    let responsibility = required(&opts, "--responsibility")?;
    let role = required(&opts, "--role")?;
    let target = required(&opts, "--endpoint")?;
    let endpoint_kind = opts
        .get("--endpoint-kind")
        .map(String::as_str)
        .unwrap_or("adapter");
    if !["adapter", "command", "http"].contains(&endpoint_kind) {
        return Err("--endpoint-kind must be adapter, command, or http".into());
    }
    let availability = opts
        .get("--availability")
        .map(String::as_str)
        .unwrap_or("available");
    if !["available", "degraded", "offline"].contains(&availability) {
        return Err("--availability must be available, degraded, or offline".into());
    }
    let runtime = opts
        .get("--runtime")
        .or_else(|| opts.get("--adapter"))
        .map(String::as_str)
        .unwrap_or("shell");
    let mut labels = Map::new();
    for item in split_list(opts.get("--labels"), ',') {
        let mut parts = item.split('=');
        let key = parts.next().unwrap_or("");
        let value = parts.next().unwrap_or("");
        if !key.is_empty() && !value.is_empty() {
            labels.insert(key.into(), json!(value));
        }
    }
    let now = agents_relay_rust::supervised_script::current_time();
    let agent = json!({"id":id,"name":name,"responsibility":responsibility,"role":role,
        "capabilities":split_list(opts.get("--capabilities"), ','),"boundaries":split_list(opts.get("--boundaries"), '|'),
        "endpoint":{"kind":endpoint_kind,"target":target},
        "runtime":{"adapter":runtime,"provider":opts.get("--provider").filter(|v| !v.is_empty()),"model":opts.get("--model").filter(|v| !v.is_empty())},
        "availability":availability,"routing":{"labels":labels,"trustDomains":split_list(opts.get("--trust-domains"), ','),"regions":split_list(opts.get("--regions"), ',')},
        "evidence":{"evaluations":[],"outcomes":{"succeeded":0,"failed":0,"timedOut":0},"lastObservedAt":null},"registeredAt":now,"updatedAt":now});
    let (mut db, job_id, _, scoped) = open_registry(&path, &opts)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&agent).map_err(|e| e.to_string())?;
    if scoped {
        tx.execute("INSERT INTO agent_snapshot(scope_job_id,agent_id,json,updated_at) VALUES(?1,?2,?3,?4) ON CONFLICT(scope_job_id,agent_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at", rusqlite::params![job_id,id,json,now]).map_err(|e| format!("agent_snapshot write failed: {e}"))?;
        tx.execute("INSERT INTO relay_meta(scope_job_id,key,value) VALUES(?1,'agent_registry_observed_at',?2) ON CONFLICT(scope_job_id,key) DO UPDATE SET value=excluded.value", rusqlite::params![job_id,now]).map_err(|e| e.to_string())?;
    } else {
        tx.execute("INSERT INTO agent_snapshot(agent_id,json,updated_at) VALUES(?1,?2,?3) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at", rusqlite::params![id,json,now]).map_err(|e| format!("agent_snapshot write failed: {e}"))?;
        tx.execute("INSERT INTO relay_meta(key,value) VALUES('agent_registry_observed_at',?1) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [&now]).map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(agent)
}
fn discover(args: &[String]) -> Result<Value, String> {
    let (opts, explore) = options(args, "agent-discover")?;
    let path = validated_db(&opts)?;
    let capabilities = split_list(opts.get("--capabilities"), ',');
    let availability = enum_list(opts.get("--availability"), "--availability")?;
    let (db, job_id, _, scoped) = open_registry(&path, &opts)?;
    let mut candidates = Vec::new();
    for agent in list_agents(&db, &job_id, scoped)? {
        if !capabilities.iter().all(|cap| {
            agent["capabilities"]
                .as_array()
                .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(cap)))
        }) {
            continue;
        }
        if opts.get("--runtime").is_some_and(|runtime| {
            !runtime.is_empty() && agent["runtime"]["adapter"].as_str() != Some(runtime)
        }) {
            continue;
        }
        if !availability.is_empty()
            && !availability
                .iter()
                .any(|value| agent["availability"].as_str() == Some(value))
        {
            continue;
        }
        if opts.get("--trust-domain").is_some_and(|domain| {
            !domain.is_empty()
                && !agent["routing"]["trustDomains"]
                    .as_array()
                    .is_some_and(|values| values.iter().any(|value| value.as_str() == Some(domain)))
        }) {
            continue;
        }
        let evaluated = if let Some(kind) = opts.get("--task-kind").filter(|kind| !kind.is_empty())
        {
            agent["evidence"]["evaluations"]
                .as_array()
                .is_some_and(|items| items.iter().any(|item| item["taskKind"] == kind.as_str()))
        } else {
            agent["evidence"]["evaluations"]
                .as_array()
                .is_some_and(|items| !items.is_empty())
        };
        let evidence_reason = if evaluated {
            "observed evidence available"
        } else {
            "no observed evidence yet"
        };
        let reasons = json!([
            if capabilities.is_empty() {
                "capabilities matched".to_owned()
            } else {
                format!("capabilities: {}", capabilities.join(", "))
            },
            evidence_reason
        ]);
        candidates.push(json!({"agent":agent,"reasons":reasons,"evidence":agent["evidence"],"exploratory":!evaluated}));
    }
    candidates.sort_by(|left, right| {
        if explore && left["exploratory"] != right["exploratory"] {
            return left["exploratory"]
                .as_bool()
                .cmp(&right["exploratory"].as_bool())
                .reverse();
        }
        let l_avail = left["agent"]["availability"].as_str().unwrap_or("");
        let r_avail = right["agent"]["availability"].as_str().unwrap_or("");
        let availability_order = (r_avail == "available").cmp(&(l_avail == "available"));
        if availability_order != std::cmp::Ordering::Equal {
            return availability_order;
        }
        let reliability = |candidate: &Value| {
            let outcomes = &candidate["agent"]["evidence"]["outcomes"];
            let s = outcomes["succeeded"].as_f64().unwrap_or(0.0);
            let total = s
                + outcomes["failed"].as_f64().unwrap_or(0.0)
                + outcomes["timedOut"].as_f64().unwrap_or(0.0);
            if total == 0.0 {
                0.0
            } else {
                s / total
            }
        };
        reliability(right).total_cmp(&reliability(left))
    });
    Ok(json!(candidates))
}
pub fn dispatch(args: &[String]) -> Result<(), String> {
    let command = args
        .first()
        .map(String::as_str)
        .ok_or("missing Agent registry command")?;
    let result = match command {
        "agent-register" => register(&args[1..])?,
        "agent-discover" => discover(&args[1..])?,
        _ => return Err("unsupported native Agent registry command".into()),
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&result).map_err(|e| e.to_string())?
    );
    Ok(())
}
