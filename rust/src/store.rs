//! Read-only adapter to Relay V2's authoritative SQLite snapshot table.
//! No migrations, PR actions, mutations, or lifecycle decisions.
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct JobSnapshot {
    #[serde(rename = "jobId")]
    pub job_id: String,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
    pub job: Value,
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
}
