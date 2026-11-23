//! One-way PR identity removal from an older authoritative SQLite snapshot.
//! No production files or runtime processes are accessed by this test.
use rusqlite::{Connection,params};

#[test]
fn upgrade_preserves_jobs_and_referenced_records_without_pr_binding(){
    let db=Connection::open_in_memory().unwrap();
    db.execute_batch(r#"
        PRAGMA foreign_keys=ON;
        CREATE TABLE source_registry (job_id TEXT PRIMARY KEY, source_file TEXT NOT NULL UNIQUE,
            repository TEXT NOT NULL, pr_number INTEGER NOT NULL);
        CREATE INDEX source_registry_repo_pr ON source_registry(repository,pr_number);
        CREATE TABLE job_snapshot(job_id TEXT PRIMARY KEY,json TEXT NOT NULL,updated_at TEXT NOT NULL);
        CREATE TABLE migration_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE agent_snapshot(scope_job_id TEXT REFERENCES source_registry(job_id),agent_id TEXT);
        INSERT INTO migration_metadata VALUES('schema','single-sqlite-staging-v1');
        INSERT INTO source_registry VALUES('720','unified:720','neox',24);
        INSERT INTO source_registry VALUES('721','unified:721','neox',0);
        INSERT INTO agent_snapshot VALUES('720','agent-a');
        INSERT INTO job_snapshot VALUES('720', '{"id":"720","prNumber":24,"externalPrNumber":99,"state":"ACTIVE","tasks":[{"id":"t1","state":"RUNNING"}]}','before');
        INSERT INTO job_snapshot VALUES('721', '{"id":"721","state":"COMPLETED","tasks":[]}', 'before');
    "#).unwrap();
    db.execute_batch(include_str!("../sql/upgrade_local_job_registry_v2.sql")).unwrap();
    let mut columns=db.prepare("PRAGMA table_info(source_registry)").unwrap();
    let names=columns.query_map([],|row|row.get::<_,String>(1)).unwrap()
        .collect::<Result<Vec<_>,_>>().unwrap();
    assert_eq!(names,["job_id","source_file","repository"]);
    let schema:String=db.query_row("SELECT value FROM migration_metadata WHERE key='schema'",[],|r|r.get(0)).unwrap();
    assert_eq!(schema,"local-git-id-v2");
    let payload:String=db.query_row("SELECT json FROM job_snapshot WHERE job_id=?",params!["720"],|r|r.get(0)).unwrap();
    let job:serde_json::Value=serde_json::from_str(&payload).unwrap();
    assert_eq!(job["id"],"720");
    assert_eq!(job["tasks"][0]["state"],"RUNNING");
    assert!(job.get("prNumber").is_none());
    assert!(job.get("externalPrNumber").is_none());
    assert_eq!(db.query_row("SELECT count(*) FROM job_snapshot",[],|r|r.get::<_,i64>(0)).unwrap(),2);
    assert_eq!(db.query_row("SELECT count(*) FROM agent_snapshot WHERE scope_job_id='720'",[],|r|r.get::<_,i64>(0)).unwrap(),1);
    assert_eq!(db.query_row("PRAGMA integrity_check",[],|r|r.get::<_,String>(0)).unwrap(),"ok");
    assert!(db.prepare("PRAGMA foreign_key_check").unwrap().query([]).unwrap().next().unwrap().is_none());
}
