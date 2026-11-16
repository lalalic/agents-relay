//! Atomic Job + Coordinator creation in the *existing* Relay V2 SQLite store.
//! Graph decides activation/completion; this is only the persistence effect.
use super::ids::{allocate_entity_id_in_tx, EntityKind};
use super::RelayAuthority;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// Same immutable local repository binding as src/unified-job-registry.ts.
/// Legacy stores include source_registry; isolated Rust fixtures may not.
/// Called inside the same IMMEDIATE transaction as Job and global ID creation.
fn register_unified_job(
    tx: &rusqlite::Transaction<'_>,
    job_id: &str,
    repository: &str,
    project_root: &str,
) -> Result<(), String> {
    let unified: i64 = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_registry')",
        [], |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if unified == 0 {
        return Ok(());
    }
    let mut stmt = tx
        .prepare(
            "SELECT job_id,json FROM job_snapshot WHERE job_id<>?1 \
         AND json_extract(json,'$.repository')=?2",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(params![job_id, repository], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| e.to_string())?;
    for row in rows {
        let (sibling_id, encoded) = row.map_err(|e| e.to_string())?;
        let sibling: Value = serde_json::from_str(&encoded).map_err(|e| e.to_string())?;
        if sibling["projectRoot"].as_str() != Some(project_root) {
            return Err(format!("Local repository identity collision: {repository} belongs to a different projectRoot (Job {sibling_id})"));
        }
    }
    drop(stmt);
    tx.execute(
        "INSERT INTO source_registry(job_id,source_file,repository,pr_number) \
         VALUES (?1,?2,?3,0) ON CONFLICT(job_id) DO NOTHING",
        params![job_id, format!("unified:{job_id}"), repository],
    )
    .map_err(|e| e.to_string())?;
    let binding = tx
        .query_row(
            "SELECT repository,pr_number FROM source_registry WHERE job_id=?1",
            [job_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .map_err(|e| e.to_string())?;
    if binding.0 != repository || binding.1 != 0 {
        return Err("canonical source_registry identity/PR binding mismatch".into());
    }
    Ok(())
}

pub struct NativeObjectiveJobSpec<'a> {
    pub repository: &'a str,
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub objective: &'a str,
    pub project_root: &'a str,
    pub project_path: Option<&'a str>,
    pub priority: &'a str,
    pub review_enabled: bool,
    pub auto_merge: bool,
    pub idempotency_key: Option<&'a str>,
    pub tag: Option<&'a Value>,
    pub github_repo: Option<&'a str>,
    pub creator_thread_id: Option<&'a str>,
    pub reviewer_thread_id: Option<&'a str>,
    pub implementation_thread_id: Option<&'a str>,
    pub continuation: Option<&'a Value>,
    pub no_github: bool,
    pub at: &'a str,
}

pub struct NativeJobSpec<'a> {
    pub repository: &'a str,
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub priority: &'a str,
    pub project_root: &'a str,
    pub project_path: Option<&'a str>,
    pub input: &'a str,
    pub graph: &'a str,
    pub output_path: &'a str,
    pub request_key: &'a str,
    pub workspace_root: Option<&'a str>,
    pub shared_root: Option<&'a str>,
    pub github_repo: Option<&'a str>,
    pub tag: Option<&'a Value>,
    pub creator_thread_id: Option<&'a str>,
    pub reviewer_thread_id: Option<&'a str>,
    pub implementation_thread_id: Option<&'a str>,
    pub continuation: Option<&'a Value>,
    pub no_github: bool,
    pub review_enabled: bool,
    pub auto_merge: bool,
    pub at: &'a str,
}
pub struct NativeCreatedJob {
    pub job_id: String,
    pub coordinator_task_id: String,
    pub created: bool,
}
impl RelayAuthority {
    pub fn create_native_objective_job(
        &mut self,
        spec: NativeObjectiveJobSpec<'_>,
    ) -> Result<Value, String> {
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
            || spec.objective.trim().is_empty()
            || spec.objective.len() > 1_048_576
        {
            return Err("Job title/objective must be nonempty and within size limits".into());
        }
        if !matches!(spec.priority, "P0" | "P1" | "P2" | "P3") {
            return Err("--priority must be P0, P1, P2, or P3".into());
        }
        chrono::DateTime::parse_from_rfc3339(spec.at).map_err(|_| "invalid Job timestamp")?;
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&json!([
                    spec.repository,
                    spec.title,
                    spec.objective,
                    spec.project_root,
                    spec.project_path,
                    spec.priority,
                    spec.review_enabled,
                    spec.auto_merge,
                    spec.tag,
                    spec.github_repo,
                    spec.creator_thread_id,
                    spec.reviewer_thread_id,
                    spec.implementation_thread_id,
                    spec.continuation,
                    spec.no_github
                ]))
                .map_err(|e| e.to_string())?
            )
        );
        let job_id = if let Some(id) = spec.id {
            if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit()) || id == "0" {
                return Err("--id must be a positive decimal Job ID".into());
            }
            id.to_owned()
        } else {
            allocate_entity_id_in_tx(
                &tx,
                spec.repository,
                EntityKind::Job,
                spec.idempotency_key,
                &HashSet::new(),
            )?
        };
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM job_snapshot WHERE job_id=?1)",
                [&job_id],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if exists {
            if let Some(key) = spec.idempotency_key {
                let saved: String = tx
                    .query_row(
                        "SELECT json FROM job_snapshot WHERE job_id=?1",
                        [&job_id],
                        |r| r.get(0),
                    )
                    .map_err(|e| e.to_string())?;
                let existing: Value = serde_json::from_str(&saved).map_err(|e| e.to_string())?;
                if existing["nativeIntakeHash"] == fingerprint {
                    tx.commit().map_err(|e| e.to_string())?;
                    return Ok(existing);
                }
                let _ = key;
            }
            return Err("Job ID already exists".into());
        }
        let mut job = json!({"id":job_id,"title":spec.title,"objective":spec.objective,"repository":spec.repository,
            "projectRoot":spec.project_root,"projectPath":spec.project_path,"priority":spec.priority,
            "state":"DRAFT","runtimeStatus":"DRAFT","prNumber":0,"reviewEnabled":spec.review_enabled,
            "autoMerge":spec.auto_merge,"tasks":[],"plans":[],"nativeIntakeHash":fingerprint,"createdAt":spec.at,"updatedAt":spec.at});
        for (key, value) in [
            ("tag", spec.tag.cloned()),
            ("githubRepo", spec.github_repo.map(|v| json!(v))),
            ("creatorThreadId", spec.creator_thread_id.map(|v| json!(v))),
            (
                "reviewerThreadId",
                spec.reviewer_thread_id.map(|v| json!(v)),
            ),
            (
                "implementationThreadId",
                spec.implementation_thread_id.map(|v| json!(v)),
            ),
            ("continuation", spec.continuation.cloned()),
        ] {
            if let Some(value) = value {
                job[key] = value;
            }
        }
        job["graphStartContext"] = json!({"noGitHub":spec.no_github});
        register_unified_job(&tx, &job_id, spec.repository, spec.project_root)?;
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
        Ok(job)
    }
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
            || !matches!(spec.priority, "P0" | "P1" | "P2" | "P3")
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
                    spec.priority,
                    spec.project_root,
                    spec.project_path,
                    spec.input,
                    spec.graph,
                    spec.output_path,
                    spec.workspace_root,
                    spec.shared_root,
                    spec.github_repo,
                    spec.tag,
                    spec.creator_thread_id,
                    spec.reviewer_thread_id,
                    spec.implementation_thread_id,
                    spec.continuation,
                    spec.no_github,
                    spec.review_enabled,
                    spec.auto_merge
                ]))
                .map_err(|e| e.to_string())?
            )
        );
        let tx = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let job_id = if let Some(id) = spec.id {
            if id.is_empty() || id == "0" || !id.bytes().all(|b| b.is_ascii_digit()) {
                return Err("--id must be a positive decimal Job ID".into());
            }
            id.to_owned()
        } else {
            allocate_entity_id_in_tx(
                &tx,
                spec.repository,
                EntityKind::Job,
                Some(spec.request_key),
                &HashSet::new(),
            )?
        };
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
            "id":job_id,"title":spec.title,"objective":spec.input,"repository":spec.repository,"priority":spec.priority,
            "projectRoot":spec.project_root,"state":"DRAFT","runtimeStatus":"DRAFT",
            // Match Node Job creation: autoMerge defaults enabled unless the
            // caller explicitly opts out. The Job Graph still gates completion.
            "reviewEnabled":spec.review_enabled,"autoMerge":spec.auto_merge,"prNumber":0,
            "tasks":[task],"plans":[],"nativeIntakeHash":fingerprint,
            "projectPath":spec.project_path,
            "graphStartContext":{"projectPath":spec.project_root,"workspaceRoot":spec.workspace_root,"sharedRoot":spec.shared_root,"noGitHub":spec.no_github},
            "githubRepo":spec.github_repo,
            "tag":spec.tag,"creatorThreadId":spec.creator_thread_id,"reviewerThreadId":spec.reviewer_thread_id,
            "implementationThreadId":spec.implementation_thread_id,"continuation":spec.continuation,
            "createdAt":spec.at,"updatedAt":spec.at
        });
        register_unified_job(&tx, &job_id, spec.repository, spec.project_root)?;
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
