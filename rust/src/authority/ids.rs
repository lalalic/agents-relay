//! Globally monotonic Job and Task IDs; matches src/job-task-id-sequence.ts.
use super::RelayAuthority;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::Value;
use std::collections::HashSet;

const SEQUENCE_SQL: &str = r#"
CREATE TABLE IF NOT EXISTS sequences (
    repository TEXT NOT NULL,kind TEXT NOT NULL,value INTEGER NOT NULL,
    PRIMARY KEY(repository,kind)
);
CREATE TABLE IF NOT EXISTS idempotency (
    repository TEXT NOT NULL,kind TEXT NOT NULL,request_key TEXT NOT NULL,
    entity_id TEXT NOT NULL,PRIMARY KEY(repository,kind,request_key)
);"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntityKind {
    Job,
    Task,
}
impl EntityKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Job => "job",
            Self::Task => "task",
        }
    }
}
impl RelayAuthority {
    /// The sequence scope is global (`*`) across repositories, not one per
    /// caller. Callers supply the same idempotency identity as the Node CLI.
    pub fn allocate_entity_id(
        &mut self,
        repository: &str,
        kind: EntityKind,
        request_key: Option<&str>,
        occupied: &HashSet<String>,
    ) -> Result<String, String> {
        if repository.is_empty() {
            return Err("Task ID allocation requires a repository context".into());
        }
        if request_key.is_some_and(|key| key.is_empty() || key.len() > 512) {
            return Err("Invalid idempotency key".into());
        }
        let key = request_key.map(|key| {
            if kind == EntityKind::Task {
                key.to_owned()
            } else {
                format!("{repository}:{key}")
            }
        });
        self.connection
            .execute_batch(SEQUENCE_SQL)
            .map_err(|e| e.to_string())?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        if let Some(scoped_key) = &key {
            let stored:Option<String>=tx.query_row(
                "SELECT entity_id FROM idempotency WHERE repository='*' AND kind=?1 AND request_key=?2",
                params![kind.as_str(),scoped_key],|row|row.get(0)
            ).optional().map_err(|e|e.to_string())?;
            if let Some(stored) = stored {
                tx.commit().map_err(|e| e.to_string())?;
                return Ok(stored);
            }
        }
        let prior: Option<i64> = tx
            .query_row(
                "SELECT value FROM sequences WHERE repository='*' AND kind=?1",
                [kind.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        let mut maximum = prior.unwrap_or(0);
        let mut query = tx
            .prepare("SELECT json FROM job_snapshot")
            .map_err(|e| e.to_string())?;
        for row in query
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
        {
            let json = row.map_err(|e| e.to_string())?;
            let Ok(value) = serde_json::from_str::<Value>(&json) else {
                continue;
            };
            let ids: Vec<Option<&str>> = match kind {
                EntityKind::Job => vec![value.get("id").and_then(Value::as_str)],
                EntityKind::Task => value
                    .get("tasks")
                    .and_then(Value::as_array)
                    .map(|tasks| {
                        tasks
                            .iter()
                            .map(|task| task.get("id").and_then(Value::as_str))
                            .collect()
                    })
                    .unwrap_or_default(),
            };
            for id in ids.into_iter().flatten() {
                if id.starts_with('0')
                    || id.starts_with('-')
                    || !id.bytes().all(|b| b.is_ascii_digit())
                {
                    continue;
                }
                // JS reserves safe Number integer IDs; abort instead of
                // creating a divergent ID beyond its precise numeric range.
                if let Ok(parsed) = id.parse::<i64>() {
                    maximum = maximum.max(parsed);
                }
            }
        }
        drop(query);
        const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
        if maximum >= MAX_SAFE_INTEGER {
            return Err("Job/Task ID sequence exceeded JS safe integer".into());
        }
        let mut next = maximum + 1;
        while occupied.contains(&next.to_string()) {
            next = next.checked_add(1).ok_or("ID overflow")?;
            if next > MAX_SAFE_INTEGER {
                return Err("ID sequence exhausted".into());
            }
        }
        tx.execute("INSERT INTO sequences(repository,kind,value) VALUES('*',?1,?2) ON CONFLICT(repository,kind) DO UPDATE SET value=excluded.value",
            params![kind.as_str(),next]).map_err(|e|e.to_string())?;
        if let Some(scoped_key) = key {
            tx.execute("INSERT INTO idempotency(repository,kind,request_key,entity_id) VALUES('*',?1,?2,?3)",
                params![kind.as_str(),scoped_key,next.to_string()]).map_err(|e|e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(next.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::authority::tests::setup;
    #[test]
    fn ids_are_global_across_repos_and_idempotent() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        // Existing job 91 and task 101 provide non-sequential history.
        assert_eq!(
            store
                .allocate_entity_id("repo-a", EntityKind::Job, Some("import-1"), &HashSet::new())
                .unwrap(),
            "92"
        );
        assert_eq!(
            store
                .allocate_entity_id("repo-a", EntityKind::Job, Some("import-1"), &HashSet::new())
                .unwrap(),
            "92"
        );
        assert_eq!(
            store
                .allocate_entity_id("repo-b", EntityKind::Job, Some("import-1"), &HashSet::new())
                .unwrap(),
            "93"
        );
        assert_eq!(
            store
                .allocate_entity_id(
                    "repo-a",
                    EntityKind::Task,
                    Some("task-generation"),
                    &HashSet::new()
                )
                .unwrap(),
            "102"
        );
        assert_eq!(
            store
                .allocate_entity_id(
                    "repo-b",
                    EntityKind::Task,
                    Some("task-generation"),
                    &HashSet::new()
                )
                .unwrap(),
            "102"
        );
        assert_eq!(
            store
                .allocate_entity_id(
                    "repo-a",
                    EntityKind::Task,
                    None,
                    &HashSet::from(["103".into()])
                )
                .unwrap(),
            "104"
        );
    }
    #[test]
    fn rejects_invalid_keys_and_uses_sequence_after_existing_ids() {
        let (_dir, path) = setup();
        let mut store = RelayAuthority::open_existing(&path).unwrap();
        assert!(store
            .allocate_entity_id("", EntityKind::Job, None, &HashSet::new())
            .is_err());
        assert!(store
            .allocate_entity_id("repo", EntityKind::Job, Some(""), &HashSet::new())
            .is_err());
        assert_eq!(
            store
                .allocate_entity_id("repo", EntityKind::Task, None, &HashSet::new())
                .unwrap(),
            "102"
        );
    }
}
