//! Atomic Job + Coordinator creation in the *existing* Relay V2 SQLite store.
//! Graph decides activation/completion; this is only the persistence effect.
use super::ids::{allocate_entity_id_in_tx, EntityKind};
use super::RelayAuthority;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub struct NativeJobSpec<'a> {
    pub repository: &'a str,
    pub title: &'a str,
    pub project_root: &'a str,
    pub input: &'a str,
    pub graph: &'a str,
    pub output_path: &'a str,
    pub request_key: &'a str,
    pub at: &'a str,
}
pub struct NativeCreatedJob {
    pub job_id: String,
    pub coordinator_task_id: String,
    pub created: bool,
}
impl RelayAuthority {
    pub fn create_native_dag_job(
        &mut self,
        spec: NativeJobSpec<'_>,
    ) -> Result<NativeCreatedJob, String> {
        if spec.repository.is_empty()
            || spec.repository.len() > 100
            || !spec
                .repository
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            return Err("invalid repository identity".into());
        }
        if spec.title.trim().is_empty()
            || spec.title.len() > 200
            || spec.input.is_empty()
            || spec.input.len() > 1_048_576
            || spec.graph.len() > 131_072
            || spec.request_key.is_empty()
            || spec.request_key.len() > 256
        {
            return Err("native Job input/title/idempotency key invalid".into());
        }
        chrono::DateTime::parse_from_rfc3339(spec.at).map_err(|_| "invalid Job timestamp")?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    spec.repository,
                    spec.title,
                    spec.project_root,
                    spec.input,
                    spec.graph,
                    spec.output_path
                ]))
                .map_err(|e| e.to_string())?
            )
        );
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let job_id = allocate_entity_id_in_tx(
            &tx,
            spec.repository,
            EntityKind::Job,
            Some(spec.request_key),
            &HashSet::new(),
        )?;
        if let Some(saved) = tx
            .query_row(
                "SELECT json FROM job_snapshot WHERE job_id=?1",
                [&job_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|e| e.to_string())?
        {
            let current: Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
            if current["nativeIntakeHash"] != fingerprint {
                return Err("native Job idempotency-key collision (different request)".into());
            }
            let task_id = current["tasks"]
                .as_array()
                .and_then(|a| a.first())
                .and_then(|t| t["id"].as_str())
                .ok_or("existing Job lost Coordinator")?
                .to_string();
            tx.commit().map_err(|e| e.to_string())?;
            return Ok(NativeCreatedJob {
                job_id,
                coordinator_task_id: task_id,
                created: false,
            });
        }
        // Only new Jobs require a free output; an idempotent create may return
        // after the Coordinator has already produced its result.
        if std::path::Path::new(spec.output_path).exists() {
            return Err("new Coordinator output already exists".into());
        }
        let task_id = allocate_entity_id_in_tx(
            &tx,
            spec.repository,
            EntityKind::Task,
            None,
            &HashSet::new(),
        )?;
        let task = json!({
            "id":task_id,"jobId":job_id,"title":"Coordinator","kind":"work",
            "agentGraph":spec.graph,"input":spec.input,
            "output":{"kind":"file","path":spec.output_path},
            "state":"QUEUED","attempt":0,"maxAttempts":3,"dependencies":[],
            "adapter":"codex","timeoutMs":600000,
            "leaseOwner":null,"leaseExpiresAt":null,"executionId":null,
            "result":null,"createdAt":spec.at,"updatedAt":spec.at
        });
        let job = json!({
            "id":job_id,"title":spec.title,"objective":spec.input,"repository":spec.repository,
            "projectRoot":spec.project_root,"state":"DRAFT","runtimeStatus":"DRAFT",
            "reviewEnabled":false,"autoMerge":false,"prNumber":0,
            "tasks":[task],"plans":[],"nativeIntakeHash":fingerprint,
            "createdAt":spec.at,"updatedAt":spec.at
        });
        tx.execute(
            "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?1,?2,?3)",
            params![
                job_id,
                serde_json::to_string(&job).map_err(|e| e.to_string())?,
                spec.at
            ],
        )
        .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(NativeCreatedJob {
            job_id,
            coordinator_task_id: task_id,
            created: true,
        })
    }
}
