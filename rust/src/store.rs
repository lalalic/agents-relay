//! Read-only adapter to Relay V2's authoritative SQLite snapshot table.
//! No migrations, PR actions, mutations, or lifecycle decisions.
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::Path;
use std::time::{Duration, SystemTime};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobSnapshot {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub job: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskEventPage {
    pub job_id: String,
    pub task_id: String,
    pub order: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub more_possible: Option<bool>,
    pub events: Vec<Value>,
}

pub struct RelayReader {
    connection: Connection,
}
impl RelayReader {
    /// Opening a missing path must never create a new Relay SQLite authority.
    pub fn open(path: &Path) -> Result<Self, String> {
        if !path.is_file() {
            return Err(format!(
                "Relay SQLite path does not exist: {}",
                path.display()
            ));
        }
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("read-only SQLite open failed: {e}"))?;
        connection
            .execute_batch("PRAGMA query_only = ON; PRAGMA busy_timeout = 2000;")
            .map_err(|e| e.to_string())?;
        let found: i64 = connection
            .query_row(
                "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='job_snapshot'",
                [],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        if found != 1 {
            return Err("not a Relay V2 database: missing job_snapshot".to_string());
        }
        Ok(Self { connection })
    }

    pub fn list_jobs(&self, limit: u32, offset: u32) -> Result<Vec<JobSnapshot>, String> {
        if limit == 0 || limit > 1000 {
            return Err("limit must be between 1 and 1000".into());
        }
        let mut query = self
            .connection
            .prepare(
                "SELECT job_id, json, updated_at FROM job_snapshot
                 ORDER BY updated_at DESC, job_id DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([i64::from(limit), i64::from(offset)], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        rows.map(|item| {
            let (id, json, updated_at) = item.map_err(|e| e.to_string())?;
            let job: Value =
                serde_json::from_str(&json).map_err(|e| format!("bad job {id}: {e}"))?;
            Ok(JobSnapshot {
                job_id: id,
                updated_at,
                job,
            })
        })
        .collect()
    }

    /// Read process ledger without opening a writable Store or inventing
    /// any fallback PID. The native probe checks exact host/PGID/startToken.
    pub fn get_process(
        &self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
    ) -> Result<Option<crate::authority::ExecutionProcessRecord>, String> {
        let table:i64=self.connection.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_process')",
            [],|r|r.get(0),
        ).map_err(|e|e.to_string())?;
        if table == 0 {
            return Ok(None);
        }
        self.connection.query_row(
            "SELECT job_id,task_id,execution_id,lease_owner,host,pid,pgid,start_token,observed_at,ended_at FROM execution_process WHERE job_id=?1 AND task_id=?2 AND execution_id=?3",
            rusqlite::params![job_id,task_id,execution_id],|r| {
                Ok(crate::authority::ExecutionProcessRecord{
                    job_id:r.get(0)?,task_id:r.get(1)?,execution_id:r.get(2)?,
                    lease_owner:r.get(3)?,host:r.get(4)?,pid:r.get(5)?,pgid:r.get(6)?,
                    start_token:r.get(7)?,observed_at:r.get(8)?,ended_at:r.get(9)?,
                })
            },
        ).optional().map_err(|e|e.to_string())
    }

    pub fn get_job(&self, job_id: &str) -> Result<Option<JobSnapshot>, String> {
        if job_id.is_empty() || job_id.len() > 256 {
            return Err("invalid job id".into());
        }
        let mut query = self
            .connection
            .prepare("SELECT json, updated_at FROM job_snapshot WHERE job_id = ?1")
            .map_err(|e| e.to_string())?;
        let item = query
            .query_row([job_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .optional()
            .map_err(|e| e.to_string())?;
        item.map(|(json, updated_at)| {
            let job = serde_json::from_str(&json).map_err(|e| e.to_string())?;
            Ok(JobSnapshot {
                job_id: job_id.into(),
                updated_at,
                job,
            })
        })
        .transpose()
    }

    /// Read the ordered Task snapshots embedded in the authoritative Job.
    pub fn list_tasks(&self, job_id: &str) -> Result<Option<Vec<Value>>, String> {
        let Some(snapshot) = self.get_job(job_id)? else {
            return Ok(None);
        };
        let tasks = snapshot.job["tasks"]
            .as_array()
            .ok_or_else(|| format!("Job {job_id} has no task list"))?;
        Ok(Some(tasks.clone()))
    }

    /// Read one Task snapshot without deriving lifecycle state or mutating it.
    pub fn get_task(&self, job_id: &str, task_id: &str) -> Result<Option<Value>, String> {
        if task_id.is_empty() || task_id.len() > 256 {
            return Err("invalid task id".into());
        }
        let Some(tasks) = self.list_tasks(job_id)? else {
            return Ok(None);
        };
        Ok(tasks
            .into_iter()
            .find(|task| task["id"].as_str() == Some(task_id)))
    }

    /// Read Task-scoped event payloads already retained by Relay's native
    /// workflow inbox/outbox. This does not query the Events Bus service or
    /// create a parallel event-history store.
    pub fn task_events(
        &self,
        job_id: &str,
        task_id: &str,
        limit: usize,
        order: &str,
        after: i64,
    ) -> Result<TaskEventPage, String> {
        if !(1..=60).contains(&limit) {
            return Err("task events --limit must be an integer from 1 to 60".into());
        }
        if order != "asc" && order != "desc" {
            return Err("task events --order must be asc or desc".into());
        }
        if after < 0 {
            return Err("task events --after must be a non-negative integer cursor".into());
        }
        if after > 9_007_199_254_740_991 {
            return Err("task events --after must be a safe integer cursor".into());
        }
        if order != "asc" && after != 0 {
            return Err("task events --after requires --order asc".into());
        }

        let job = self
            .get_job(job_id)?
            .ok_or_else(|| format!("Job {job_id} not found"))?;
        let tasks = job.job["tasks"]
            .as_array()
            .ok_or_else(|| format!("Job {job_id} has no task list"))?;
        if !tasks
            .iter()
            .any(|task| task["id"].as_str() == Some(task_id))
        {
            return Err(format!("Task {task_id} not found in Job {job_id}"));
        }

        let mut sources = Vec::new();
        for (table, time_column) in [
            ("workflow_event_inbox", "consumed_at"),
            ("workflow_event_outbox", "created_at"),
        ] {
            let exists: i64 = self
                .connection
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [table],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            if exists == 0 {
                continue;
            }
            sources.push(format!(
                "SELECT {time_column} AS recorded_at,event_id,payload_json FROM {table} \
                 WHERE COALESCE(json_extract(payload_json,'$.job_id'),json_extract(payload_json,'$.jobId'))=?1 \
                 AND COALESCE(json_extract(payload_json,'$.task_id'),json_extract(payload_json,'$.taskId'))=?2"
            ));
        }
        let mut events = Vec::new();
        if !sources.is_empty() {
            let direction = if order == "asc" { "ASC" } else { "DESC" };
            let sql = format!(
                "SELECT recorded_at,event_id,payload_json FROM ({}) \
                 ORDER BY recorded_at {direction},event_id {direction} LIMIT ?3 OFFSET ?4",
                sources.join(" UNION ALL ")
            );
            let mut query = self
                .connection
                .prepare(&sql)
                .map_err(|error| error.to_string())?;
            let rows = query
                .query_map(
                    rusqlite::params![job_id, task_id, limit as i64, after],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, String>(2)?,
                        ))
                    },
                )
                .map_err(|error| error.to_string())?;
            for row in rows {
                let (recorded_at, event_id, encoded) = row.map_err(|error| error.to_string())?;
                let payload: Value = serde_json::from_str(&encoded).map_err(|error| {
                    format!("invalid stored workflow event {event_id}: {error}")
                })?;
                let kind = payload["type"].as_str().unwrap_or("unknown");
                let status = payload["status"].as_str().unwrap_or_else(|| {
                    if kind.ends_with(".completed") || kind.ends_with(".approved") {
                        "succeeded"
                    } else if kind.ends_with(".failed") {
                        "failed"
                    } else {
                        "running"
                    }
                });
                let mut normalized = json!({
                    "version": payload["version"].as_u64().unwrap_or(1),
                    "event_id": payload["event_id"].as_str().unwrap_or(&event_id),
                    "job_id": job_id,
                    "task_id": task_id,
                    "parent_task_id": payload["parent_task_id"].as_str().or(payload["parentTaskId"].as_str()),
                    "type": kind,
                    "status": status,
                    "timestamp": payload["timestamp"].as_str().unwrap_or(&recorded_at),
                    "visibility": payload["visibility"].as_str().unwrap_or("orchestrator"),
                    "level": payload["level"].as_str().unwrap_or("info"),
                    "message": payload["message"].as_str().unwrap_or(kind),
                });
                for field in ["source", "data"] {
                    if !payload[field].is_null() {
                        normalized[field] = payload[field].clone();
                    }
                }
                events.push(normalized);
            }
        }
        let more_possible = events.len() == limit;
        let next_cursor = if order == "asc" {
            Some(after + events.len() as i64)
        } else {
            None
        };
        Ok(TaskEventPage {
            job_id: job_id.to_string(),
            task_id: task_id.to_string(),
            order: if order == "asc" {
                "oldest-first"
            } else {
                "newest-first"
            }
            .to_string(),
            next_cursor,
            more_possible: if order == "asc" {
                Some(more_possible)
            } else {
                None
            },
            events,
        })
    }

    /// Return only the timestamp committed for the exact active Worker
    /// execution. An event receipt or transport acknowledgement is not enough.
    pub fn worker_activity_at(
        &self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
    ) -> Result<Option<SystemTime>, String> {
        let Some(snapshot) = self.get_job(job_id)? else {
            return Ok(None);
        };
        let Some(task) = snapshot.job["tasks"]
            .as_array()
            .and_then(|tasks| tasks.iter().find(|task| task["id"] == task_id))
        else {
            return Ok(None);
        };
        if task["state"] != "RUNNING" || task["executionId"] != execution_id {
            return Ok(None);
        }
        let Some(activity) = task["lastWorkerActivityAt"].as_str() else {
            return Ok(None);
        };
        let activity = chrono::DateTime::parse_from_rfc3339(activity)
            .map_err(|_| "invalid durable Worker activity timestamp")?;
        let seconds = activity.timestamp();
        if seconds < 0 {
            return Err("Worker activity timestamp predates Unix epoch".into());
        }
        Ok(Some(
            SystemTime::UNIX_EPOCH
                + Duration::new(seconds as u64, activity.timestamp_subsec_nanos()),
        ))
    }
}
use rusqlite::OptionalExtension;

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn read_only_listing_and_absent_database() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("relay.sqlite");
        assert!(RelayReader::open(&path).is_err());
        assert!(!path.exists());
        {
            let db = Connection::open(&path).unwrap();
            db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);").unwrap();
            for (id, stamp) in [
                ("11", "2026-11-10T00:00:00Z"),
                ("12", "2026-11-12T00:00:00Z"),
            ] {
                db.execute(
                    "INSERT INTO job_snapshot VALUES (?1,?2,?3)",
                    rusqlite::params![
                        id,
                        format!("{{\"id\":\"{id}\",\"state\":\"ACTIVE\"}}"),
                        stamp
                    ],
                )
                .unwrap();
            }
        }
        let original = fs::read(&path).unwrap();
        let store = RelayReader::open(&path).unwrap();
        assert_eq!(store.list_jobs(1, 0).unwrap()[0].job_id, "12");
        assert_eq!(store.list_jobs(1, 1).unwrap()[0].job_id, "11");
        assert_eq!(store.get_job("11").unwrap().unwrap().job["state"], "ACTIVE");
        assert!(store.get_job("bad' OR 1=1 --").unwrap().is_none());
        assert!(store.list_jobs(1001, 0).is_err());
        assert_eq!(fs::read(&path).unwrap(), original);
    }
    #[test]
    fn wal_reader_observes_commits_and_refuses_write_queries() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("relay-wal.sqlite");
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode = WAL; CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);").unwrap();
        writer
            .execute(
                "INSERT INTO job_snapshot VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    "201",
                    r#"{"id":"201","state":"ACTIVE"}"#,
                    "2026-11-13T19:00:00Z"
                ],
            )
            .unwrap();
        let reader = RelayReader::open(&path).unwrap();
        assert_eq!(reader.list_jobs(10, 0).unwrap().len(), 1);
        assert!(reader
            .connection
            .execute(
                "UPDATE job_snapshot SET json = ?1 WHERE job_id = ?2",
                rusqlite::params![r#"{"id":"201","state":"FAILED"}"#, "201"]
            )
            .is_err());
        writer
            .execute(
                "INSERT INTO job_snapshot VALUES (?1, ?2, ?3)",
                rusqlite::params![
                    "202",
                    r#"{"id":"202","state":"ACTIVE"}"#,
                    "2026-11-13T20:00:00Z"
                ],
            )
            .unwrap();
        assert_eq!(reader.list_jobs(10, 0).unwrap().len(), 2);
        assert_eq!(
            reader.get_job("201").unwrap().unwrap().job["state"],
            "ACTIVE"
        );
    }

    #[test]
    fn worker_activity_reader_is_execution_fenced_and_restart_durable() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("activity.sqlite");
        let db = Connection::open(&path).unwrap();
        db.execute_batch("CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);").unwrap();
        let job = serde_json::json!({"id":"91","tasks":[{"id":"101","state":"RUNNING","executionId":"exec-1","lastWorkerActivityAt":"2026-11-13T20:00:04.123456789Z"}]});
        db.execute(
            "INSERT INTO job_snapshot VALUES ('91',?1,'2026-11-13T20:00:04.123456789Z')",
            [job.to_string()],
        )
        .unwrap();
        drop(db);

        let reader = RelayReader::open(&path).unwrap();
        let activity = reader
            .worker_activity_at("91", "101", "exec-1")
            .unwrap()
            .unwrap();
        assert_eq!(
            activity.duration_since(SystemTime::UNIX_EPOCH).unwrap(),
            Duration::new(1_794_600_004, 123_456_789)
        );
        assert!(reader
            .worker_activity_at("91", "101", "stale-exec")
            .unwrap()
            .is_none());
        assert!(reader
            .worker_activity_at("91", "missing", "exec-1")
            .unwrap()
            .is_none());
        let db = Connection::open(&path).unwrap();
        let finished = serde_json::json!({"id":"91","tasks":[{"id":"101","state":"SUCCEEDED","executionId":"exec-1","lastWorkerActivityAt":"2026-11-13T20:00:04.123456789Z"}]});
        db.execute(
            "UPDATE job_snapshot SET json=?1 WHERE job_id='91'",
            [finished.to_string()],
        )
        .unwrap();
        drop(db);
        assert!(reader
            .worker_activity_at("91", "101", "exec-1")
            .unwrap()
            .is_none());
    }
}
