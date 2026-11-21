// Node provenance: src/relay-store.ts. SQLite is the only durable Job,
// Task, Graph and Projection authority. This file is the Store facade over
// independently ported SQLite transactional primitives. Never use it against
// a production DB before Phase2 differential verification is complete.
use crate::{
    host_invocation_store::{
        has_host_invocation_decision,record_host_invocation_decision,
        record_host_invocation_event,HOST_INVOCATION_TABLES_SQL,
    },
    job_pr_number_migration::migrate_legacy_job_pr_numbers,
    legacy_blocked_task_migration::migrate_legacy_blocked_tasks,
    local_merge_lock::iso8601_now,
    projection_outbox::{logical_operation_key,ProjectionOutbox,SCHEMA_VERSION},
    publication_store::{
        list_publication_events_from_database,load_publication_from_database,
        record_publication_in_database,
    },
    relay_create::create_job_if_absent,
    relay_job_merge::merge_inbound_job_snapshot,
    relay_job_snapshot_reads::{
        current_job_metadata,load_relay_job,list_relay_jobs,normalize_relay_job,
    },
    relay_workflow_operations::SQLiteWorkflowOperations,
    unified_job_registry::{create_unified_job_if_absent,ensure_unified_job_registry},
    unified_pr_facts::save_unified_pull_request_facts,
    unified_relay_schema::migrate_unified_relay_schema,
};
use rusqlite::{params,Connection,OptionalExtension};
use serde_json::{json,Value};
use std::{collections::HashSet,fs,path::{Path,PathBuf}};

fn field<'a>(v:&'a Value,key:&str)->&'a str{
    v.get(key).and_then(Value::as_str).unwrap_or("")
}
fn sql(e:impl std::fmt::Display)->String{e.to_string()}
const BASE_SCHEMA:&str=r#"
CREATE TABLE IF NOT EXISTS relay_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS job_snapshot (
  job_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pull_request_facts (
  id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL
  CHECK(state IN ('OPEN','MERGED','CLOSED')),
  head_ref TEXT,head_sha TEXT,observed_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS publication_state
 (job_id TEXT PRIMARY KEY,json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS publication_delivery (
  job_id TEXT NOT NULL,delivery_id TEXT NOT NULL,type TEXT NOT NULL,
  json TEXT NOT NULL,observed_at TEXT NOT NULL,
  PRIMARY KEY(job_id,delivery_id));
CREATE TABLE IF NOT EXISTS agent_snapshot (
  agent_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS event_receipt (
  event_id TEXT PRIMARY KEY,stream TEXT,sequence INTEGER,received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS execution_process (
  job_id TEXT NOT NULL,task_id TEXT NOT NULL,execution_id TEXT NOT NULL,
  lease_owner TEXT NOT NULL,host TEXT NOT NULL,pid INTEGER NOT NULL,
  pgid INTEGER NOT NULL,start_token TEXT NOT NULL,observed_at TEXT NOT NULL,
  ended_at TEXT,PRIMARY KEY(job_id,task_id,execution_id));"#;
fn initialize_legacy(db:&Connection)->Result<(),String>{
    db.execute_batch(BASE_SCHEMA).map_err(sql)?;
    db.execute_batch(HOST_INVOCATION_TABLES_SQL).map_err(sql)?;
    db.execute_batch(&crate::projection_outbox::create_table_sql("projection_outbox"))
        .map_err(sql)?;
    db.execute_batch(crate::projection_outbox::create_receipt_table_sql())
        .map_err(sql)?;
    db.execute_batch(crate::projection_outbox::create_index_sql()).map_err(sql)?;
    migrate_legacy_job_pr_numbers(db)?;
    let version=db.query_row(
        "SELECT value FROM relay_meta WHERE key='schema_version'",
        [],|r|r.get::<_,String>(0)).optional().map_err(sql)?
        .and_then(|v|v.parse::<i64>().ok()).unwrap_or(0);
    if version>SCHEMA_VERSION{
        return Err(format!("Relay store schema {version} is newer than supported {SCHEMA_VERSION}"));
    }
    if version<SCHEMA_VERSION{
        crate::projection_outbox::upgrade(db,version)?;
    }
    db.execute(
        "INSERT INTO relay_meta(key,value) VALUES('schema_version',?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [SCHEMA_VERSION.to_string()]).map_err(sql)?;
    Ok(())
}
fn scope_guard(scope:Option<&str>,job_id:&str)->Result<(),String>{
    if let Some(bound)=scope {
        if bound!=job_id{return Err(format!(
            "Wrong scoped Job ID {job_id}; expected {bound}"));}
    }
    Ok(())
}
fn write_snapshot(
    db:&Connection,scope:Option<&str>,job:&Value,at:&str,
)->Result<(),String>{
    let id=field(job,"id");
    scope_guard(scope,id)?;
    let existing=db.query_row(
        "SELECT json FROM job_snapshot WHERE job_id=?",
        [id],|row|row.get::<_,String>(0)).optional().map_err(sql)?;
    if let Some(existing)=existing{
        let parsed:Value=serde_json::from_str(&existing).map_err(sql)?;
        if parsed.get("projectRoot")!=job.get("projectRoot"){
            return Err(format!("Job {id} projectRoot is immutable"));
        }
    }
    if let Some(scope)=scope {
        ensure_unified_job_registry(db,job,scope)?;
    }
    db.execute(
        "INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)
         ON CONFLICT(job_id) DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at",
        params![id,current_job_metadata(job).to_string(),at]).map_err(sql)?;
    Ok(())
}
pub struct SQLiteRelayStore {
    pub db:Connection,
    pub path:PathBuf,
    pub scope_job_id:Option<String>,
}
impl SQLiteRelayStore {
    pub fn open(path:&Path,scope_job_id:Option<&str>)->Result<Self,String>{
        Self::open_with_claim_reset(path,scope_job_id,true)
    }
    /// Live daemon requests share long-lived scoped SQLite connections.
    /// Resetting all processing outbox claims on every HTTP lookup would
    /// violate other jobs' in-flight leases. Recovery resets are explicit
    /// at daemon ownership acquisition; ordinary active opens skip them.
    pub fn open_without_claim_reset(path:&Path,scope_job_id:Option<&str>)
        ->Result<Self,String>{
        Self::open_with_claim_reset(path,scope_job_id,false)
    }
    fn open_with_claim_reset(path:&Path,scope_job_id:Option<&str>,reset:bool)
        ->Result<Self,String>{
        if path!=Path::new(":memory:"){
            if let Some(parent)=path.parent(){
                fs::create_dir_all(parent).map_err(sql)?;
            }
        }
        let db=Connection::open(path).map_err(sql)?;
        db.execute_batch(
            "PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;
             PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON;"
        ).map_err(sql)?;
        if let Some(scope)=scope_job_id{
            let exists=db.query_row(
                "SELECT 1 FROM sqlite_master WHERE type='table'
                   AND name='migration_metadata'",
                [],|row|row.get::<_,i64>(0)).optional().map_err(sql)?;
            if exists.is_none(){
                migrate_unified_relay_schema(&db)?;
            }else{
                let schema=db.query_row(
                    "SELECT value FROM migration_metadata WHERE key='schema'",
                    [],|row|row.get::<_,String>(0)).optional().map_err(sql)?;
                if schema.as_deref()!=Some("single-sqlite-staging-v1"){
                    return Err("Unified Relay schema is missing or unsupported".into());
                }
            }
            if scope.is_empty(){return Err("Scoped Job ID is empty".into());}
        }else{
            initialize_legacy(&db)?;
        }
        migrate_legacy_blocked_tasks(&db)?;
        if reset {
            ProjectionOutbox::new(&db,scope_job_id)
                .reset_processing(&iso8601_now())?;
        }
        Ok(Self{db,path:path.into(),
            scope_job_id:scope_job_id.map(str::to_owned)})
    }
    /// Node SQLiteRelayStore.close: explicitly release the exact owned SQLite
    /// connection rather than close an external/borrowed process-wide store.
    pub fn close(self)->Result<(),String>{
        self.db.close().map_err(|(_,error)|error.to_string())
    }
    fn scope(&self,job_id:&str)->Result<(),String>{
        scope_guard(self.scope_job_id.as_deref(),job_id)
    }
    pub fn load_job(&self,job_id:&str)->Result<Option<Value>,String>{
        self.scope(job_id)?;
        load_relay_job(&self.db,job_id)
    }
    pub fn list_jobs(&self)->Result<Vec<Value>,String>{
        list_relay_jobs(&self.db,self.scope_job_id.as_deref())
    }
    pub fn save_job(&self,job:&Value)->Result<(),String>{
        self.scope(field(job,"id"))?;
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=write_snapshot(&self.db,self.scope_job_id.as_deref(),
            job,&iso8601_now());
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    /// Commit a blocker Job and its dependent Task as one SQLite transaction.
    /// Both snapshots are optimistic-version fenced; concurrent worker writes
    /// or an idempotency-key collision abort *both* changes. This is callable
    /// only from the scoped dependent-Job owner, never an unscoped provider.
    pub fn commit_blocker_recovery_pair(
        &self,dependent_before:&Value,dependent_after:&Value,
        blocker_before:Option<&Value>,blocker_after:&Value,
    )->Result<(),String>{
        let dependent_id=field(dependent_before,"id");
        let blocker_id=field(blocker_after,"id");
        if dependent_id.is_empty() || blocker_id.is_empty() || dependent_id==blocker_id
            ||self.scope_job_id.as_deref()!=Some(dependent_id)
            ||dependent_after.get("id")!=dependent_before.get("id")
            ||blocker_after.get("repository")==dependent_before.get("repository"){
            return Err("Invalid cross-Job blocker recovery binding".into());
        }
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=(||->Result<(),String>{
            let current_dependent=load_relay_job(&self.db,dependent_id)?
                .ok_or("Dependent Job missing during blocker commit")?;
            if &current_dependent!=dependent_before{
                return Err("Concurrent dependent Job mutation; retry blocker recovery".into());
            }
            let current_blocker=load_relay_job(&self.db,blocker_id)?;
            if current_blocker.as_ref()!=blocker_before{
                return Err("Concurrent blocker Job mutation; retry blocker recovery".into());
            }
            // New blockers must use the same immutable local-repository root
            // as all existing Jobs of their repository. Do not fork identity.
            let mut statement=self.db.prepare(
                "SELECT json FROM job_snapshot WHERE job_id<>? AND json_extract(json,'$.repository')=?"
            ).map_err(sql)?;
            let candidates=statement.query_map(params![blocker_id,field(blocker_after,"repository")],
                |row|row.get::<_,String>(0)).map_err(sql)?
                .collect::<Result<Vec<_>,_>>().map_err(sql)?;
            drop(statement);
            for raw in candidates{
                let prior:Value=serde_json::from_str(&raw).map_err(sql)?;
                if prior.get("projectRoot")!=blocker_after.get("projectRoot"){
                    return Err("Blocker repository projectRoot conflicts with durable binding".into());
                }
            }
            let stamp=iso8601_now();
            ensure_unified_job_registry(&self.db,blocker_after,blocker_id)?;
            write_snapshot(&self.db,Some(dependent_id),dependent_after,&stamp)?;
            write_snapshot(&self.db,None,blocker_after,&stamp)?;
            Ok(())
        })();
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    fn workflow_operation<'a,F,R>(&'a self,work:F)->Result<R,String>
    where F:FnOnce(&mut SQLiteWorkflowOperations<'a,
        Box<dyn FnMut(&Value,&str)->Result<(),String>+'a>,
        Box<dyn FnMut(&Value,&str)->Result<(),String>+'a>>)->Result<R,String>{
        let scope=self.scope_job_id.as_deref();
        let db=&self.db;
        let write:Box<dyn FnMut(&Value,&str)->Result<(),String>+'_>=
            Box::new(move |job,at|write_snapshot(db,scope,job,at));
        let enqueue:Box<dyn FnMut(&Value,&str)->Result<(),String>+'_>=
            Box::new(move |request,at|ProjectionOutbox::new(db,scope)
                .enqueue(request,at).map(|_|()));
        let mut operations=SQLiteWorkflowOperations{
            db,write,enqueue:Some(enqueue),
        };
        work(&mut operations)
    }
    /// Targeted final-review revisions are one atomic Graph+SQLite change;
    /// callers cannot directly mutate child IDs, reviewer comments or Task
    /// state. The repository-wide SQLite sequence is authoritative.
    pub fn submit_review_revision(&self,store_directory:&Path,graph:&Path,
        job_id:&str,input:&Value)->Result<Value,String>{
        self.scope(job_id)?;
        self.workflow_operation(|ops|
            crate::review_revision_model::submit_targeted_revision_request(
                ops,store_directory,graph,job_id,input))
    }
    pub fn mutate_job<F>(&self,job_id:&str,mutate:F)->Result<Value,String>
    where F:FnOnce(Value)->Result<Value,String>{
        self.scope(job_id)?;
        self.workflow_operation(|op|op.mutate_job(job_id,mutate))
    }
    pub fn commit_workflow_mutation_and_events<F>(
        &self,job_id:&str,mutate:F,events:&[Value],
    )->Result<Value,String>
    where F:FnOnce(Value)->Result<Value,String>{
        self.scope(job_id)?;
        self.workflow_operation(|op|
            op.commit_workflow_mutation_and_events(job_id,mutate,events))
    }
    pub fn commit_workflow_mutation_with_events<F>(
        &self,job_id:&str,mutate:F,
    )->Result<Value,String>
    where F:FnOnce(Value)->Result<(Value,Vec<Value>),String>{
        self.scope(job_id)?;
        self.workflow_operation(|op|
            op.commit_workflow_mutation_with_events(job_id,mutate))
    }
    pub fn reserve_workflow_launch(&self,identity:&Value)
        ->Result<bool,String>{
        self.scope(field(identity,"jobId"))?;
        let directory=std::env::var("AGENTS_RELAY_WORKFLOW_DIR")
            .map(PathBuf::from).unwrap_or_else(|_|PathBuf::from("workflow"));
        self.workflow_operation(|op|op.reserve_workflow_launch(&directory,identity))
    }
    pub fn verify_workflow_launch(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<String,String>{
        self.scope(job_id)?;
        self.workflow_operation(|op|op.verify_workflow_launch(job_id,task_id,execution_id))
    }
    pub async fn drain_workflow_events<Publish,Fut>(
        &self,publish:Publish
    )->Result<usize,String>
    where Publish:FnMut(Value)->Fut,Fut:std::future::Future<Output=Result<(),String>>{
        let db=&self.db;
        let scope=self.scope_job_id.as_deref();
        let write:Box<dyn FnMut(&Value,&str)->Result<(),String>+'_>=
            Box::new(move |job,at|write_snapshot(db,scope,job,at));
        let enqueue:Box<dyn FnMut(&Value,&str)->Result<(),String>+'_>=
            Box::new(move |request,at|ProjectionOutbox::new(db,scope)
                .enqueue(request,at).map(|_|()));
        let operations=SQLiteWorkflowOperations{db,write,enqueue:Some(enqueue)};
        operations.drain_workflow_events_async(publish).await
    }
    pub fn create_job_if_absent(&mut self,job:&Value)->Result<Value,String>{
        self.scope(field(job,"id"))?;
        if let Some(scope)=self.scope_job_id.clone(){
            let scope=scope.clone();
            create_unified_job_if_absent(&mut self.db,job,|tx,at|{
                write_snapshot(tx,Some(&scope),job,at)
            })
        }else{
            create_job_if_absent(&mut self.db,job)
        }
    }
    pub fn ingest_job_snapshot(&self,job:&Value)->Result<Value,String>{
        self.scope(field(job,"id"))?;
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=(||{
            let local=load_relay_job(&self.db,field(job,"id"))?;
            let merged=if let Some(local)=local{
                merge_inbound_job_snapshot(&local,job)
            }else{job.clone()};
            write_snapshot(&self.db,self.scope_job_id.as_deref(),
                &merged,&iso8601_now())?;
            Ok(merged)
        })();
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    pub fn save_job_with_projection(
        &self,job:&Value,request:&Value,
    )->Result<(),String>{
        self.scope(field(job,"id"))?;
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=(||{
            let now=iso8601_now();
            write_snapshot(&self.db,self.scope_job_id.as_deref(),job,&now)?;
            ProjectionOutbox::new(&self.db,self.scope_job_id.as_deref())
                .enqueue(request,&now)?;
            Ok(())
        })();
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    /// Atomic Node saveAgentWithProjection parity: Agent and retryable
    /// outbox row are one SQLite transaction, never two independent writes.
    pub fn save_agent_with_projection(
        &self,agent:&Value,request:&Value,
    )->Result<(),String>{
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=(||{
            let now=iso8601_now();
            self.upsert_agent_in_transaction(agent,&now)?;
            ProjectionOutbox::new(&self.db,self.scope_job_id.as_deref())
                .enqueue(request,&now)?;
            Ok(())
        })();
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    fn agent_observed(&self)->Result<bool,String>{
        let scope=self.scope_job_id.as_deref();
        let found:Option<String>=if let Some(scope)=scope{
            self.db.query_row(
                "SELECT value FROM relay_meta WHERE scope_job_id=?
                  AND key='agent_registry_observed_at'",
                [scope],|row|row.get(0)).optional().map_err(sql)?
        }else{
            self.db.query_row(
                "SELECT value FROM relay_meta WHERE key='agent_registry_observed_at'",
                [],|row|row.get(0)).optional().map_err(sql)?
        };
        Ok(found.is_some())
    }
    pub fn load_agents(&self)->Result<Option<Vec<Value>>,String>{
        if !self.agent_observed()?{return Ok(None);}
        let scoped=self.scope_job_id.as_deref();
        let query=if scoped.is_some(){
            "SELECT json FROM agent_snapshot WHERE scope_job_id=? ORDER BY agent_id"
        }else{"SELECT json FROM agent_snapshot ORDER BY agent_id"};
        let mut statement=self.db.prepare(query).map_err(sql)?;
        let raws=if let Some(scope)=scoped{
            statement.query_map([scope],|r|r.get::<_,String>(0))
                .map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?
        }else{
            statement.query_map([],|r|r.get::<_,String>(0))
                .map_err(sql)?.collect::<Result<Vec<_>,_>>().map_err(sql)?
        };
        raws.into_iter().map(|raw|serde_json::from_str(&raw).map_err(sql))
            .collect::<Result<Vec<_>,_>>().map(Some)
    }
    /// A zero-row Agent registry is still a confirmed observation.
    /// Node saveAgents([]) writes agent_registry_observed_at even after
    /// deleting the last row. Without this flag, empty and never-fetched
    /// registries are conflated and Planner may mis-detect provider health.
    fn mark_agent_registry_observed_in_transaction(&self,now:&str)
        ->Result<(),String>{
        if let Some(scope)=self.scope_job_id.as_deref(){
            self.db.execute(
                "INSERT INTO relay_meta(scope_job_id,key,value)
                 VALUES(?,'agent_registry_observed_at',?)
                 ON CONFLICT(scope_job_id,key) DO UPDATE SET value=excluded.value",
                params![scope,now]).map_err(sql)?;
        }else{
            self.db.execute(
                "INSERT INTO relay_meta(key,value)
                 VALUES('agent_registry_observed_at',?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![now]).map_err(sql)?;
        }
        Ok(())
    }
    fn upsert_agent_in_transaction(&self,agent:&Value,now:&str)
        ->Result<(),String>{
        let id=field(agent,"id");
        if let Some(scope)=self.scope_job_id.as_deref(){
            self.db.execute(
                "INSERT INTO agent_snapshot(scope_job_id,agent_id,json,updated_at)
                 VALUES(?,?,?,?) ON CONFLICT(scope_job_id,agent_id)
                 DO UPDATE SET json=excluded.json,updated_at=excluded.updated_at",
                params![scope,id,agent.to_string(),now]).map_err(sql)?;
            self.db.execute(
                "INSERT INTO relay_meta(scope_job_id,key,value)
                 VALUES(?,'agent_registry_observed_at',?)
                 ON CONFLICT(scope_job_id,key) DO UPDATE SET value=excluded.value",
                params![scope,now]).map_err(sql)?;
        }else{
            self.db.execute(
                "INSERT INTO agent_snapshot(agent_id,json,updated_at)
                 VALUES(?,?,?) ON CONFLICT(agent_id) DO UPDATE SET
                   json=excluded.json,updated_at=excluded.updated_at",
                params![id,agent.to_string(),now]).map_err(sql)?;
            self.db.execute(
                "INSERT INTO relay_meta(key,value)
                 VALUES('agent_registry_observed_at',?)
                 ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![now]).map_err(sql)?;
        }
        Ok(())
    }
    pub fn upsert_agent(&self,agent:&Value)->Result<(),String>{
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=self.upsert_agent_in_transaction(agent,&iso8601_now());
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    pub fn save_agents(&self,agents:&[Value])->Result<(),String>{
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=(||{
            if let Some(scope)=self.scope_job_id.as_deref(){
                self.db.execute("DELETE FROM agent_snapshot WHERE scope_job_id=?",[scope])
                    .map_err(sql)?;
            }else{
                self.db.execute("DELETE FROM agent_snapshot",[]).map_err(sql)?;
            }
            let now=iso8601_now();
            // Node saveAgents uses a plain INSERT for each replacement row,
            // NOT upsertAgent. Duplicate IDs in a *single* registry snapshot
            // must abort the entire transaction, preserving old observations.
            for agent in agents{
                if let Some(scope)=self.scope_job_id.as_deref(){
                    self.db.execute(
                        "INSERT INTO agent_snapshot(
                         scope_job_id,agent_id,json,updated_at) VALUES(?,?,?,?)",
                        params![scope,field(agent,"id"),agent.to_string(),now])
                        .map_err(sql)?;
                }else{
                    self.db.execute(
                        "INSERT INTO agent_snapshot(agent_id,json,updated_at)
                         VALUES(?,?,?)",
                        params![field(agent,"id"),agent.to_string(),now])
                        .map_err(sql)?;
                }
            }
            self.mark_agent_registry_observed_in_transaction(&now)?;
            Ok(())
        })();
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    pub fn mark_event_processed(
        &self,event_id:&str,stream:Option<&str>,sequence:Option<i64>,
    )->Result<bool,String>{
        let now=iso8601_now();
        let count=if let Some(scope)=self.scope_job_id.as_deref(){
            self.db.execute(
                "INSERT OR IGNORE INTO event_receipt(
                 scope_job_id,event_id,stream,sequence,received_at)VALUES(?,?,?,?,?)",
                params![scope,event_id,stream,sequence,now]).map_err(sql)?
        }else{
            self.db.execute(
                "INSERT OR IGNORE INTO event_receipt(
                 event_id,stream,sequence,received_at)VALUES(?,?,?,?)",
                params![event_id,stream,sequence,now]).map_err(sql)?
        };
        Ok(count==1)
    }
    pub fn record_execution_process(&self,record:&Value)->Result<(),String>{
        let id=(field(record,"jobId"),field(record,"taskId"),field(record,"executionId"));
        let existing=self.load_execution_process(id.0,id.1,id.2)?;
        if let Some(existing)=existing{
            for key in ["pid","pgid","host","startToken"]{
                if existing.get(key)!=record.get(key){
                    return Err(format!("Conflicting process identity for {}/{}/{}",
                        id.0,id.1,id.2));
                }
            }
            return Ok(());
        }
        self.db.execute(
            "INSERT OR IGNORE INTO execution_process(
             job_id,task_id,execution_id,lease_owner,host,pid,pgid,start_token,
             observed_at,ended_at)VALUES(?,?,?,?,?,?,?,?,?,?)",
            params![id.0,id.1,id.2,
                record.get("leaseOwner").and_then(Value::as_str),
                record.get("host").and_then(Value::as_str),
                record.get("pid").and_then(Value::as_i64),
                record.get("pgid").and_then(Value::as_i64),
                record.get("startToken").and_then(Value::as_str),
                record.get("observedAt").and_then(Value::as_str),
                record.get("endedAt").and_then(Value::as_str)]
        ).map_err(sql)?;
        Ok(())
    }
    pub fn load_execution_process(
        &self,job_id:&str,task_id:&str,execution_id:&str,
    )->Result<Option<Value>,String>{
        self.db.query_row(
            "SELECT lease_owner,host,pid,pgid,start_token,observed_at,ended_at
             FROM execution_process WHERE job_id=? AND task_id=? AND execution_id=?",
            params![job_id,task_id,execution_id],|row|{
                Ok(json!({
                    "jobId":job_id,"taskId":task_id,"executionId":execution_id,
                    "leaseOwner":row.get::<_,String>(0)?,
                    "host":row.get::<_,String>(1)?,
                    "pid":row.get::<_,i64>(2)?,"pgid":row.get::<_,i64>(3)?,
                    "startToken":row.get::<_,String>(4)?,
                    "observedAt":row.get::<_,String>(5)?,
                    "endedAt":row.get::<_,Option<String>>(6)?
                }))
            }
        ).optional().map_err(sql)
    }
    pub fn finish_execution_process(
        &self,job_id:&str,task_id:&str,execution_id:&str,at:Option<&str>,
    )->Result<(),String>{
        self.db.execute(
            "UPDATE execution_process SET ended_at=COALESCE(ended_at,?)
              WHERE job_id=? AND task_id=? AND execution_id=?",
            params![at.map(str::to_owned).unwrap_or_else(iso8601_now),
                job_id,task_id,execution_id]).map_err(sql)?;
        Ok(())
    }
    pub fn load_publication(&self,job_id:&str)->Result<Option<Value>,String>{
        load_publication_from_database(&self.db,job_id)
    }
    pub fn list_publication_events(&self,job_id:&str)->Result<Vec<Value>,String>{
        list_publication_events_from_database(&self.db,job_id)
    }
    pub fn record_publication(
        &mut self,job_id:&str,delivery_id:&str,publication:Option<&Value>,
        failure:Option<&Value>,at:Option<&str>,
    )->Result<bool,String>{
        self.scope(job_id)?;
        record_publication_in_database(&mut self.db,job_id,delivery_id,
            publication,failure,at)
    }
    pub fn record_host_invocation_event(
        &self,delivery:&Value,outcome:&str,fingerprint:&str,
    )->Result<(),String>{
        record_host_invocation_event(&self.db,delivery,outcome,fingerprint)
    }
    pub fn has_host_invocation_decision(
        &self,job_id:&str,task_id:&str,invocation_id:&str,
        fingerprint:Option<&str>,
    )->Result<bool,String>{
        has_host_invocation_decision(&self.db,job_id,task_id,invocation_id,
            fingerprint)
    }
    pub fn record_host_invocation_decision(
        &mut self,delivery:&Value,fingerprint:&str,
    )->Result<Value,String>{
        record_host_invocation_decision(&mut self.db,delivery,fingerprint,
            |tx,job,at|write_snapshot(tx,self.scope_job_id.as_deref(),job,at))
            .map(|receipt|receipt.value())
    }
    pub fn load_pull_request_facts(&self)->Result<Option<Value>,String>{
        let scope=self.scope_job_id.as_deref();
        let query_sql=if scope.is_some(){
            "SELECT state,head_ref,head_sha,observed_at FROM pull_request_facts
             WHERE scope_job_id=? AND id=1"
        }else{
            "SELECT state,head_ref,head_sha,observed_at
             FROM pull_request_facts WHERE id=1"
        };
        let mut stmt=self.db.prepare(query_sql).map_err(sql)?;
        let row=|row:&rusqlite::Row<'_>|{
            // Node only exposes a confirmed HEAD if BOTH ref and SHA
            // are truthy. Empty or partial rows mean absence of evidence,
            // never a synthetic object containing null fields.
            let reference=row.get::<_,Option<String>>(1)?;
            let sha=row.get::<_,Option<String>>(2)?;
            let head=match (reference.as_deref(),sha.as_deref()){
                (Some(reference),Some(sha)) if !reference.is_empty()&&!sha.is_empty()
                    =>json!({"ref":reference,"sha":sha}),
                _=>Value::Null,
            };
            Ok(json!({
                "state":row.get::<_,String>(0)?,
                "head":head,
                "observedAt":row.get::<_,String>(3)?
            }))
        };
        if let Some(scope)=scope{
            stmt.query_row([scope],row).optional().map_err(sql)
        }else{stmt.query_row([],row).optional().map_err(sql)}
    }
    pub fn save_pull_request_facts(&self,facts:&Value)->Result<(),String>{
        let state=field(facts,"state");
        if state=="UNKNOWN"{return Ok(());}
        if let Some(scope)=self.scope_job_id.as_deref(){
            return save_unified_pull_request_facts(&self.db,scope,facts);
        }
        self.db.execute(
            "INSERT INTO pull_request_facts(id,state,head_ref,head_sha,observed_at)
              VALUES(1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
              state=excluded.state,head_ref=excluded.head_ref,
              head_sha=excluded.head_sha,observed_at=excluded.observed_at
              WHERE excluded.observed_at>=pull_request_facts.observed_at AND (
                pull_request_facts.state='OPEN'
                OR(pull_request_facts.state='CLOSED' AND excluded.state IN ('CLOSED','MERGED'))
                OR(pull_request_facts.state='MERGED' AND excluded.state='MERGED'))",
            params![state,facts.pointer("/head/ref").and_then(Value::as_str),
                facts.pointer("/head/sha").and_then(Value::as_str),
                field(facts,"observedAt")]).map_err(sql)?;
        Ok(())
    }
    fn outbox(&self)->ProjectionOutbox<'_>{
        ProjectionOutbox::new(&self.db,self.scope_job_id.as_deref())
    }
    pub fn enqueue_projection(&self,request:&Value)->Result<(),String>{
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=self.outbox().enqueue(request,&iso8601_now()).map(|_|());
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    pub fn enqueue_external_action_once(&self,request:&Value)->Result<bool,String>{
        let operation=field(request,"operation");
        if !matches!(operation,"merge_pull_request"|"close_pull_request"|
            "update_pr_body"|"create_pull_request"){
            return Err("Lifecycle projection is forbidden in external-only outbox".into());
        }
        let key=logical_operation_key(field(request,"idempotencyKey"));
        self.db.execute_batch("BEGIN IMMEDIATE").map_err(sql)?;
        let result=(||{
            let scoped=self.scope_job_id.as_deref();
            let existing:Option<i64>=if let Some(scope)=scoped{
                self.db.query_row(
                    "SELECT id FROM projection_outbox WHERE scope_job_id=? AND operation_key=? LIMIT 1",
                    params![scope,key],|r|r.get(0)).optional().map_err(sql)?
            }else{
                self.db.query_row(
                    "SELECT id FROM projection_outbox WHERE operation_key=? LIMIT 1",
                    [&key],|r|r.get(0)).optional().map_err(sql)?
            };
            if existing.is_some(){return Ok(false);}
            let receipt:Option<String>=if let Some(scope)=scoped{
                self.db.query_row(
                    "SELECT operation_key FROM projection_receipt WHERE scope_job_id=? AND operation_key=?",
                    params![scope,key],|r|r.get(0)).optional().map_err(sql)?
            }else{
                self.db.query_row(
                    "SELECT operation_key FROM projection_receipt WHERE operation_key=?",
                    [&key],|r|r.get(0)).optional().map_err(sql)?
            };
            if receipt.is_some(){return Ok(false);}
            self.outbox().enqueue(request,&iso8601_now())?;
            Ok(true)
        })();
        self.db.execute_batch(if result.is_ok(){"COMMIT"}else{"ROLLBACK"})
            .map_err(sql)?;
        result
    }
    pub fn claim_due_projections(&self,limit:f64,now:&str)
        ->Result<Vec<Value>,String>{self.outbox().claim_due(limit,now)}
    pub fn complete_projection(&self,id:i64)->Result<(),String>{
        self.outbox().complete(id)
    }
    pub fn complete_projection_with_receipt(
        &self,id:i64,key:&str,status:&str,attempts:i64,detail:&Value,
    )->Result<(),String>{
        self.outbox().complete_with_receipt(id,key,status,attempts,detail,&iso8601_now())
    }
    pub fn retry_projection(&self,id:i64,error:&str,next_at:&str)
        ->Result<(),String>{self.outbox().retry(id,error,next_at)}
    pub fn retry_projection_with_receipt(
        &self,id:i64,key:&str,error:&str,next_at:&str,attempts:i64,detail:&Value,
    )->Result<(),String>{
        self.outbox().retry_with_receipt(id,key,error,next_at,attempts,detail,
            &iso8601_now())
    }
    pub fn dead_letter_projection(&self,id:i64,error:&str)
        ->Result<(),String>{self.outbox().dead_letter(id,error)}
    pub fn list_projection_conflicts(&self)->Result<Vec<Value>,String>{
        self.outbox().list_conflicts()
    }
    pub fn record_projection_conflict(&self,id:i64,diagnostic:&Value)
        ->Result<(),String>{self.outbox().record_conflict(id,diagnostic)}
    pub fn resolve_projection_conflict(&self,id:i64,resolution:&Value)
        ->Result<bool,String>{self.outbox().resolve_conflict(id,resolution)}
    pub fn conflict_projection_count(&self)->Result<i64,String>{
        self.outbox().conflict_count()
    }
    pub fn pending_projection_count(&self)->Result<i64,String>{
        self.outbox().pending_count()
    }
    pub fn terminal_projection_count(&self)->Result<i64,String>{
        self.outbox().terminal_count()
    }
    pub fn record_projection_receipt(
        &self,key:&str,status:&str,attempts:i64,detail:&Value,
    )->Result<(),String>{
        self.outbox().record_receipt(key,status,attempts,detail,&iso8601_now())
    }
}
pub fn relay_store_directory()->PathBuf{
    crate::local_job_path::relay_store_directory(
        std::env::var("AGENTS_RELAY_STORE_DIR").ok().as_deref(),
        std::env::var("HOME").ok().as_deref()).into()
}
pub fn relay_unified_store_path()->PathBuf{
    crate::relay_store_discovery::relay_unified_store_path(&relay_store_directory())
}
