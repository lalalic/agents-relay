//! SQLite process identity records only; signal/probe policy belongs to a
//! native process adapter and must revalidate host/PGID/startToken before kill.
use super::RelayAuthority;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProcessRecord {
    pub job_id: String,
    pub task_id: String,
    pub execution_id: String,
    pub lease_owner: String,
    pub host: String,
    pub pid: i64,
    pub pgid: i64,
    pub start_token: String,
    pub observed_at: String,
    pub ended_at: Option<String>,
}
const PROCESS_TABLE: &str = r#"
CREATE TABLE IF NOT EXISTS execution_process (
job_id TEXT NOT NULL,task_id TEXT NOT NULL,execution_id TEXT NOT NULL,
lease_owner TEXT NOT NULL,host TEXT NOT NULL,pid INTEGER NOT NULL,pgid INTEGER NOT NULL,
start_token TEXT NOT NULL,observed_at TEXT NOT NULL,ended_at TEXT,
PRIMARY KEY(job_id,task_id,execution_id));"#;
impl RelayAuthority {
    pub fn record_process(&mut self, record: &ExecutionProcessRecord) -> Result<bool, String> {
        if record.job_id.is_empty()
            || record.task_id.is_empty()
            || record.execution_id.is_empty()
            || record.lease_owner.is_empty()
            || record.host.is_empty()
            || record.start_token.is_empty()
            || record.pid < 2
            || record.pgid != record.pid
            || record.ended_at.is_some()
        {
            return Err("invalid execution process identity".into());
        }
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute_batch(PROCESS_TABLE).map_err(|e| e.to_string())?;
        let previous =
            self::query_record(&tx, &record.job_id, &record.task_id, &record.execution_id)?;
        if let Some(old) = previous {
            if old != *record {
                return Err("execution process identity collision".into());
            }
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(false);
        }
        tx.execute("INSERT INTO execution_process(job_id,task_id,execution_id,lease_owner,host,pid,pgid,start_token,observed_at,ended_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL)",
            params![record.job_id,record.task_id,record.execution_id,record.lease_owner,record.host,
                record.pid,record.pgid,record.start_token,record.observed_at]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(true)
    }
    pub fn process_record(
        &self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
    ) -> Result<Option<ExecutionProcessRecord>, String> {
        let exists:bool=self.connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_process')",[],|row|row.get(0)).map_err(|e|e.to_string())?;
        if !exists {
            return Ok(None);
        }
        query_record(&self.connection, job_id, task_id, execution_id)
    }
    pub fn finish_process(
        &mut self,
        job_id: &str,
        task_id: &str,
        execution_id: &str,
        at: &str,
    ) -> Result<bool, String> {
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let n=tx.execute("UPDATE execution_process SET ended_at=?1 WHERE job_id=?2 AND task_id=?3 AND execution_id=?4 AND ended_at IS NULL",
            params![at,job_id,task_id,execution_id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(n == 1)
    }
}
fn query_record(
    conn: &rusqlite::Connection,
    job_id: &str,
    task_id: &str,
    execution_id: &str,
) -> Result<Option<ExecutionProcessRecord>, String> {
    conn.query_row("SELECT job_id,task_id,execution_id,lease_owner,host,pid,pgid,start_token,observed_at,ended_at FROM execution_process WHERE job_id=?1 AND task_id=?2 AND execution_id=?3",
        params![job_id,task_id,execution_id],|row|Ok(ExecutionProcessRecord{
            job_id:row.get(0)?,task_id:row.get(1)?,execution_id:row.get(2)?,lease_owner:row.get(3)?,host:row.get(4)?,pid:row.get(5)?,pgid:row.get(6)?,start_token:row.get(7)?,observed_at:row.get(8)?,ended_at:row.get(9)?,
        })).optional().map_err(|e|e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    #[test]
    fn exact_pid_generation_cannot_be_overwritten() {
        let (_dir, path) = setup();
        let mut db = RelayAuthority::open_existing(&path).unwrap();
        let record = ExecutionProcessRecord {
            job_id: "91".into(),
            task_id: "101".into(),
            execution_id: "ex1".into(),
            lease_owner: "owner1".into(),
            host: "hostname".into(),
            pid: 8412,
            pgid: 8412,
            start_token: "Mon Nov 13 20:00:00 2026".into(),
            observed_at: "2026-11-13T20:00:00Z".into(),
            ended_at: None,
        };
        assert!(db.record_process(&record).unwrap());
        assert!(!db.record_process(&record).unwrap());
        let mut reused = record.clone();
        reused.start_token = "reused PID".into();
        assert!(db
            .record_process(&reused)
            .unwrap_err()
            .contains("collision"));
        assert_eq!(
            db.process_record("91", "101", "ex1").unwrap(),
            Some(record.clone())
        );
        assert!(db
            .finish_process("91", "101", "ex1", "2026-11-13T20:00:01Z")
            .unwrap());
        assert!(!db
            .finish_process("91", "101", "ex1", "2026-11-13T20:00:02Z")
            .unwrap());
        assert!(db
            .process_record("91", "101", "ex1")
            .unwrap()
            .unwrap()
            .ended_at
            .is_some());
    }
}
