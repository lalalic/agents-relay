// A direct ORIGINAL Node vs native Rust public Job-creation fixture. All
// mutations are restricted to caller-owned temporary Git/SQLite directories;
// no provider, live Store, branch, PR or remote side effect can be invoked.
use agents_relay_rust2::{
    cli_job_create::ensure_managed_github_job,
    relay_store::SQLiteRelayStore,
    relay_store_discovery::{discover_local_relay_store_snapshots,relay_unified_store_path},
};
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf}};
pub fn invoke(request:&Value)->Result<Option<String>,String>{
    if request["op"]!="cliJobCreatePersist"{return Ok(None);}
    let fixture=Path::new(request["fixtureRoot"].as_str().ok_or("Fixture root missing")?);
    let fixture=fs::canonicalize(fixture).map_err(|e|e.to_string())?;
    let temp=fs::canonicalize(std::env::temp_dir()).map_err(|e|e.to_string())?;
    if !fixture.starts_with(&temp)
       ||!fixture.file_name().and_then(|s|s.to_str()).is_some_and(|s|s.starts_with("rust2-")) {
        return Err("Job-creation parity fixture must be under caller-owned temp".into());
    }
    let repository=request["repository"].as_str().ok_or("Repository missing")?;
    if repository.is_empty()||repository.contains('/')||repository.contains(".."){
        return Err("Unsafe local fixture repository".into());
    }
    let project=fixture.join(repository);
    let project=fs::canonicalize(project).map_err(|e|e.to_string())?;
    if !project.starts_with(&fixture)||!project.join(".git").is_dir(){
        return Err("Job-creation parity requires contained independent Git root".into());
    }
    let directory=fixture.join("stores");
    fs::create_dir_all(&directory).map_err(|e|e.to_string())?;
    let graph=PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../workflow");
    let options=&request["options"];
    let db=relay_unified_store_path(&directory);
    let known=discover_local_relay_store_snapshots(&directory)?
        .into_iter().flat_map(|snap|snap.jobs).collect::<Vec<_>>();
    // The public Node function allocates the Job ID itself before opening
    // its scoped SQLite Store; Rust must do exactly the same. Each callback
    // opens an actual scoped connection only once the ID is known.
    let db_for_read=db.clone();
    let db_for_write=db.clone();
    let outcome=ensure_managed_github_job(
        &graph,&directory,repository,&project,options,&known,
        move |id|{
            SQLiteRelayStore::open_without_claim_reset(&db_for_read,Some(id))?
                .load_job(id)
        },
        move |job|{
            let id=job.get("id").and_then(Value::as_str)
                .ok_or("New Job has no immutable ID")?;
            SQLiteRelayStore::open_without_claim_reset(&db_for_write,Some(id))?
                .create_job_if_absent(job)
        });
    let serialized=match outcome {
        Ok(value)=>json!({"ok":true,"value":value}),
        Err(error)=>json!({"ok":false,"error":error})
    };
    Ok(Some(json!(serialized).to_string()))
}
