// Node provenance: src/relay-store-discovery.ts. Read-only, SQLite-authoritative
// Job inventory and immutable scope lookup; never opens a writable connection.
use crate::json_wire_parse::parse_js_json;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, PartialEq)]
pub struct LocalRelayStoreSnapshot {
    pub path: PathBuf,
    pub jobs: Vec<Value>,
    pub facts: Option<Value>,
    pub publications: Map<String, Value>,
}

pub fn relay_unified_store_path(directory: &Path) -> PathBuf {
    directory.parent().unwrap_or(Path::new("")).join("relay.sqlite")
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| error.to_string())
}

// Every hydrated row uses one joined query, with identity validation and
// publication/facts from the same SQLite read snapshot.
const HYDRATE:&str="SELECT j.job_id,j.json,f.state,f.head_ref,f.head_sha,f.observed_at,p.json
    FROM job_snapshot j LEFT JOIN pull_request_facts f ON f.scope_job_id=j.job_id AND f.id=1
    LEFT JOIN publication_state p ON p.job_id=j.job_id";
fn hydrate(db:&Connection,path:&Path,condition:&str,args:impl rusqlite::Params)
    ->Result<Vec<LocalRelayStoreSnapshot>,String>{
    let mut stmt=db.prepare(&format!("{HYDRATE} {condition} ORDER BY CAST(j.job_id AS INTEGER),j.job_id"))
        .map_err(|e|e.to_string())?;
    let mut rows=stmt.query(args).map_err(|e|e.to_string())?;
    let mut result=Vec::new();
    while let Some(row)=rows.next().map_err(|e|e.to_string())?{
        let read=||->Result<_,rusqlite::Error>{Ok((row.get::<_,String>(0)?,row.get::<_,String>(1)?,
            row.get::<_,Option<String>>(2)?,row.get::<_,Option<String>>(3)?,row.get::<_,Option<String>>(4)?,
            row.get::<_,Option<String>>(5)?,row.get::<_,Option<String>>(6)?))};
        let (id,raw,state,head_ref,head_sha,observed_at,publication)=read().map_err(|e|e.to_string())?;
        let job=parse_js_json(&raw)?;
        if job.get("id").and_then(Value::as_str)!=Some(id.as_str()){
            return Err("Immutable SQLite Job ID differs from row scope".into());
        }
        let facts=state.map(|state|serde_json::json!({"state":state,
            "head":head_ref.zip(head_sha).map(|(reference,sha)|serde_json::json!({"ref":reference,"sha":sha})),
            "observedAt":observed_at}));
        let mut publications=Map::new();
        if let Some(raw)=publication{publications.insert(id,parse_js_json(&raw)?);}
        result.push(LocalRelayStoreSnapshot{path:path.to_owned(),jobs:vec![job],facts,publications});
    }
    Ok(result)
}
/// Exact immutable scope read, no whole-store discovery.
pub fn discover_unified_job_by_id(directory:&Path,id:&str)
    ->Result<Option<LocalRelayStoreSnapshot>,String>{
    let path=relay_unified_store_path(directory);
    if !path.is_file(){return Ok(None);}
    let db=open_read_only(&path)?;
    Ok(hydrate(&db,&path,"WHERE j.job_id=?",params![id])?.pop())
}

// Filter with the existing repository binding. No writable connection or
// schema migration is needed by Dashboard or scheduler observation.
const REPO_FILTER:&str="(?1='[]' OR json_extract(j.json,'$.repository') IN (SELECT value FROM json_each(?1)))";
fn repositories_json(repositories:&[String])->String{serde_json::json!(repositories).to_string()}
fn open_inventory(directory:&Path)->Result<Option<(PathBuf,Connection)>,String>{
    let path=relay_unified_store_path(directory);
    if !path.exists(){
        // Preserve legacy-store error rather than silently showing no Jobs.
        discover_local_relay_store_snapshots(directory)?;
        return Ok(None);
    }
    let db=open_read_only(&path)?;Ok(Some((path,db)))
}
/// Use the same Rust filtering, locale ordering and total calculation on
/// small metadata rows, then hydrate only the selected 20 IDs. The explicit
/// full-inventory API continues to return full snapshots.
pub fn dashboard_search(directory:&Path,repositories:&[String],query:&str)
    ->Result<Value,String>{
    let Some((path,db))=open_inventory(directory)? else{
        return Ok(crate::dashboard_data::search_dashboard_jobs(&[],query));
    };
    db.execute_batch("BEGIN").map_err(|e|e.to_string())?;
    let mut stmt=db.prepare(&format!("SELECT j.job_id,json_object('id',json_extract(j.json,'$.id'),
        'repository',json_extract(j.json,'$.repository'),'state',json_extract(j.json,'$.state'),
        'title',json_extract(j.json,'$.title'),'updatedAt',json_extract(j.json,'$.updatedAt'),
        'createdAt',json_extract(j.json,'$.createdAt'),'draft',json('false')) FROM job_snapshot j WHERE {REPO_FILTER}"))
        .map_err(|e|e.to_string())?;
    let rows=stmt.query_map([repositories_json(repositories)],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))
        .map_err(|e|e.to_string())?;
    let mut metadata=Vec::new();
    for row in rows{
        let (id,raw)=row.map_err(|e|e.to_string())?;let item=parse_js_json(&raw)?;
        if item["id"].as_str()!=Some(id.as_str()){return Err("Immutable SQLite Job ID differs from row scope".into());}
        metadata.push(item);
    }
    drop(stmt);
    let mut result=crate::dashboard_data::search_dashboard_jobs(&metadata,query);
    let ids=result["jobs"].as_array().unwrap().iter().filter_map(|j|j["id"].as_str()).collect::<Vec<_>>();
    let selected=hydrate(&db,&path,"WHERE j.job_id IN (SELECT value FROM json_each(?))",[serde_json::json!(ids).to_string()])?;
    let mut by_id=std::collections::HashMap::new();
    for snap in selected{let job=&snap.jobs[0];by_id.insert(job["id"].as_str().unwrap().to_owned(),crate::relayd::managed_view(&snap,job));}
    let jobs=ids.iter().map(|id|by_id.remove(*id).ok_or("Selected Job disappeared from read snapshot"))
        .collect::<Result<Vec<_>,_>>()?;
    result["jobs"]=serde_json::json!(jobs);
    db.execute_batch("COMMIT").map_err(|e|e.to_string())?;
    Ok(result)
}
/// Derived query indexes only: no new state model or writable Dashboard.
pub fn ensure_observation_indexes(directory:&Path)->Result<(),String>{
    let path=relay_unified_store_path(directory);if !path.is_file(){return Ok(());}
    let db=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_WRITE).map_err(|e|e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5)).map_err(|e|e.to_string())?;
    db.execute_batch("CREATE INDEX IF NOT EXISTS relay_job_state ON job_snapshot(json_extract(json,'$.state'));
        CREATE INDEX IF NOT EXISTS relay_job_remote_pending ON job_snapshot(json_extract(json,'$.remoteDelivery.status'))
        WHERE json_extract(json,'$.state')='COMPLETED';").map_err(|e|e.to_string())?;
    let exists:i64=db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='workflow_event_outbox'",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    if exists!=0{crate::workflow::durable_publication::DurableWorkflowPublication::new(&db)?;}
    Ok(())
}
pub fn dashboard_job_count(directory:&Path,repositories:&[String])->Result<usize,String>{
    let Some((_path,db))=open_inventory(directory)? else{return Ok(0);};
    db.query_row(&format!("SELECT count(*) FROM job_snapshot j WHERE {REPO_FILTER}"),
        [repositories_json(repositories)],|r|r.get(0)).map_err(|e|e.to_string())
}
pub fn discover_active_jobs(directory:&Path,repositories:&[String])->Result<Vec<LocalRelayStoreSnapshot>,String>{
    let Some((path,db))=open_inventory(directory)? else{return Ok(vec![]);};
    hydrate(&db,&path,&format!("WHERE {REPO_FILTER} AND json_extract(j.json,'$.state')='ACTIVE'"),[repositories_json(repositories)])
}
pub fn discover_remote_delivery_jobs(directory:&Path,repositories:&[String])->Result<Vec<LocalRelayStoreSnapshot>,String>{
    let Some((path,db))=open_inventory(directory)? else{return Ok(vec![]);};
    hydrate(&db,&path,&format!("WHERE {REPO_FILTER} AND json_extract(j.json,'$.state')='COMPLETED'
        AND json_extract(j.json,'$.remoteDelivery.status') IN ('pending','failed','processing')"),[repositories_json(repositories)])
}
/// Cheap revision inventory, not Job hydration. Include publication time so
/// independent publication receipts also invalidate the observational view.
pub fn dashboard_revisions(directory:&Path,repositories:&[String])->Result<Vec<(String,String)>,String>{
    let Some((_path,db))=open_inventory(directory)? else{return Ok(vec![]);};
    let mut stmt=db.prepare(&format!("SELECT j.job_id,json_array(j.updated_at,json_extract(j.json,'$.updatedAt'),
        f.observed_at,json_extract(p.json,'$.updatedAt')) FROM job_snapshot j
        LEFT JOIN pull_request_facts f ON f.scope_job_id=j.job_id AND f.id=1
        LEFT JOIN publication_state p ON p.job_id=j.job_id WHERE {REPO_FILTER}"))
        .map_err(|e|e.to_string())?;
    let rows=stmt.query_map([repositories_json(repositories)],|r|Ok((r.get(0)?,r.get(1)?)))
        .map_err(|e|e.to_string())?;
    rows.collect::<Result<Vec<_>,_>>().map_err(|e|e.to_string())
}

/// Resolve a local Job only from its immutable Job ID and repository.
pub fn resolve_unified_job_scope(
    directory:&Path,repository:&str,job_id:&str,
)->Result<String,String>{
    if job_id.is_empty() {return Err("Immutable Job ID is required".into());}
    let path=relay_unified_store_path(directory);
    if !path.exists() {return Ok(job_id.into());}
    let db=open_read_only(&path)?;
    let bound:Option<String>=db.query_row(
        "SELECT repository FROM source_registry WHERE job_id=?",params![job_id],
        |row|row.get(0)).optional().map_err(|e|e.to_string())?;
    if bound.as_deref().is_some_and(|name|name!=repository){
        return Err(format!("Job {job_id} belongs to another local repository"));
    }
    Ok(job_id.into())
}

/// Inventory reads must not reset leases, projection claims or outbox state.
pub fn discover_local_relay_store_snapshots(
    directory: &Path,
) -> Result<Vec<LocalRelayStoreSnapshot>, String> {
    let path = relay_unified_store_path(directory);
    if !path.exists() {
        let legacy_exists = match std::fs::read_dir(directory) {
            Ok(entries) => entries.filter_map(Result::ok).any(|entry|
                entry.path().extension().is_some_and(|extension| extension == "db")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(error) => return Err(error.to_string()),
        };
        if legacy_exists {
            return Err(format!("Unified Relay SQLite database missing at {}; legacy Job databases exist in {}",
                path.display(), directory.display()));
        }
        return Ok(Vec::new());
    }
    let db = open_read_only(&path)?;
    hydrate(&db,&path,"",[])
}

#[cfg(test)]
mod projected_inventory_tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn compact_inventory_matches_full_projection_and_indexes_candidates(){
        let root=std::env::temp_dir().join(format!("relay-projected-{}-{}",std::process::id(),chrono::Utc::now().timestamp_nanos_opt().unwrap()));
        let stores=root.join("stores");std::fs::create_dir_all(&stores).unwrap();
        let db=Connection::open(root.join("relay.sqlite")).unwrap();
        crate::unified_relay_schema::migrate_unified_relay_schema(&db).unwrap();
        let payload="historical output".repeat(4096);
        for n in 1..=120{
            let id=n.to_string();let repo=if n%2==0{"fixture"}else{"other"};
            let state=if n<4{"ACTIVE"}else if n%7==0{"DRAFT"}else if n%9==0{"CANCELLED"}else{"COMPLETED"};
            let mut job=json!({"id":id,"repository":repo,"title":format!("Étage {n}"),"state":state,
                "updatedAt":format!("2026-11-{:02}T10:00:00Z",n%27+1),"createdAt":"2026-11-01T10:00:00Z",
                "tasks":[{"id":"1","state":"SUCCEEDED","result":payload}],"plans":[]});
            if n==8{job["remoteDelivery"]=json!({"status":"pending","mergedCommitSha":"abc"});job["localMerge"]=json!({"status":"succeeded","mergedCommitSha":"abc"});}
            db.execute("INSERT INTO source_registry(job_id,source_file,repository) VALUES(?,?,?)",params![id,format!("fixture-{n}"),repo]).unwrap();
            db.execute("INSERT INTO job_snapshot(job_id,json,updated_at) VALUES(?,?,?)",params![id,job.to_string(),job["updatedAt"].as_str().unwrap()]).unwrap();
        }
        db.execute("INSERT INTO pull_request_facts(scope_job_id,id,state,observed_at) VALUES('8',1,'MERGED','2026-11-27T00:00:00Z')",[]).unwrap();
        db.execute("INSERT INTO publication_state(job_id,json) VALUES('8',?)",[json!({"latest":{"version":"v1"},"updatedAt":"2026-11-27T00:00:00Z"}).to_string()]).unwrap();
        ensure_observation_indexes(&stores).unwrap();
        let all=discover_local_relay_store_snapshots(&stores).unwrap();
        for allowed in [vec![],vec!["fixture".to_owned()]]{
            let full=all.iter().filter(|s|allowed.is_empty()||allowed.iter().any(|r|s.jobs[0]["repository"]==r.as_str()))
                .map(|s|crate::relayd::managed_view(s,&s.jobs[0])).collect::<Vec<_>>();
            assert_eq!(dashboard_job_count(&stores,&allowed).unwrap(),full.len());
            for query in ["","repo=fixture","status=CANCELLED","status=ACTIVE","q=%C3%89TAGE+8","q=12&repo=other","status=DRAFT"]{
                assert_eq!(dashboard_search(&stores,&allowed,query).unwrap(),crate::dashboard_data::search_dashboard_jobs(&full,query),"{query}");
            }
            assert_eq!(discover_active_jobs(&stores,&allowed).unwrap().len(),full.iter().filter(|j|j["state"]=="ACTIVE").count());
            assert_eq!(discover_remote_delivery_jobs(&stores,&allowed).unwrap().len(),1);
        }
        let exact=discover_unified_job_by_id(&stores,"8").unwrap().unwrap();
        assert_eq!(exact.facts.unwrap()["state"],"MERGED");assert_eq!(exact.publications["8"]["latest"]["version"],"v1");
        // Open a fresh reader so its prepared schema includes the indexes
        // created by the independent startup connection.
        let reader=open_read_only(&root.join("relay.sqlite")).unwrap();
        let plan:String=reader.query_row("EXPLAIN QUERY PLAN SELECT json FROM job_snapshot WHERE json_extract(json,'$.state')='ACTIVE'",[],|r|r.get(3)).unwrap();
        assert!(plan.contains("relay_job_state"),"{plan}");
        let before=dashboard_revisions(&stores,&[]).unwrap().into_iter().collect::<std::collections::HashMap<_,_>>();
        db.execute("UPDATE job_snapshot SET updated_at='2026-11-28T00:00:00Z' WHERE job_id='8'",[]).unwrap();
        let after=dashboard_revisions(&stores,&[]).unwrap().into_iter().collect::<std::collections::HashMap<_,_>>();
        assert_ne!(before["8"],after["8"]);assert_eq!(before["9"],after["9"]);
        drop(reader);drop(db);std::fs::remove_dir_all(root).unwrap();
    }
}
