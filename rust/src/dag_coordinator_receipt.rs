//! Project Run Coordinator result projector for a *durably completed* DAG.
//! This is not a Task scheduler or a completion transition: only the Graph
//! and SQLite may make a Coordinator SUCCEEDED. A missing declared file is
//! derived from the complete, immutable child receipts after that commit.
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};

fn s<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Materialize only absent Coordinator output files, using read-back-verified
/// Task results. Never overwrite a pre-existing run artifact or mark a Task
/// successful. It is safe to retry after a crash or an unrelated Job CAS.
pub fn materialize_committed_dag_receipts(
    job: &Value, trusted_project: &Path, trusted_output_root: &Path,
) -> Result<usize, String> {
    let root = fs::canonicalize(trusted_project).map_err(|e|e.to_string())?;
    // A live Job writes only inside its project; isolated fixtures may
    // explicitly declare the *caller-owned* temporary workspace root.
    // Never grant broader output scope implicitly from Task JSON.
    let output_root = fs::canonicalize(trusted_output_root).map_err(|e|e.to_string())?;
    if !root.starts_with(&output_root){
        return Err("Coordinator output trust root does not contain the project".into());
    }
    let tasks = job.get("tasks").and_then(Value::as_array)
        .ok_or("DAG receipt projector requires committed Task inventory")?;
    let mut created = 0;
    for parent in tasks {
        if s(parent, "state") != "SUCCEEDED"
            || s(parent, "agentGraph").is_empty()
            || parent.pointer("/output/kind").and_then(Value::as_str) != Some("file") {
            continue;
        }
        let path = Path::new(parent.pointer("/output/path").and_then(Value::as_str)
            .ok_or("Committed Coordinator has no declared output path")?);
        if !path.is_absolute() {
            // Older non-ProjectRunner Jobs can have relative output strings;
            // no trusted canonical destination exists. Never synthesize a
            // path by guessing cwd, and do not block other Jobs' receipts.
            continue;
        }
        let directory = fs::canonicalize(path.parent().ok_or("Coordinator output has no parent")?)
            .map_err(|e|format!("Coordinator output directory inaccessible: {e}"))?;
        if !directory.starts_with(&output_root) {
            return Err("Coordinator receipt cannot escape its trusted output root".into());
        }
        // Never replace a caller-owned file, including a dangling symlink.
        if fs::symlink_metadata(path).is_ok() {continue;}
        let result = parent.get("result").ok_or("Committed Coordinator result missing")?;
        if result.pointer("/data/dag/version").and_then(Value::as_u64) != Some(1) {
            return Err("Committed Coordinator has no v1 DAG proof".into());
        }
        let hash = format!("{:x}", Sha256::digest(s(parent,"agentGraph").as_bytes()));
        if result.pointer("/data/dag/graphHash").and_then(Value::as_str) != Some(hash.as_str()) {
            return Err("Committed Coordinator graph hash disagrees with source".into());
        }
        let claimed = result.pointer("/data/nodes").and_then(Value::as_object)
            .ok_or("Committed Coordinator does not declare child Task IDs")?;
        if claimed.is_empty() {return Err("Committed Coordinator has no child DAG results".into());}
        let graph=crate::agent_graph::parse_agent_graph(s(parent,"agentGraph"))?;
        if claimed.len()!=graph.nodes.len() ||graph.nodes.iter().any(|(node,_)|!claimed.contains_key(node)){
            return Err("Committed Coordinator receipt omits a declared DAG node".into());
        }
        let mut outputs = Map::new();
        let mut artifacts = Map::new();
        for (node_id, task_id) in claimed {
            let task_id = task_id.as_str().ok_or("DAG child ID must be a string")?;
            let child = tasks.iter().find(|child|s(child,"id")==task_id
                &&child.pointer("/dagNode/parentTaskId").and_then(Value::as_str)==Some(s(parent,"id"))
                &&child.pointer("/dagNode/nodeId").and_then(Value::as_str)==Some(node_id)
                &&child.pointer("/dagNode/graphHash").and_then(Value::as_str)==Some(hash.as_str())
                &&s(child,"state")=="SUCCEEDED")
                .ok_or_else(||format!("Coordinator DAG child {node_id} not a committed success"))?;
            let source = child.pointer("/output/path").and_then(Value::as_str)
                .ok_or("Coordinator child has no output file path")?;
            let source = Path::new(source);
            let source_dir = fs::canonicalize(source.parent().ok_or("Child output has no parent")?)
                .map_err(|e|e.to_string())?;
            if !source_dir.starts_with(&output_root){
                return Err("DAG child output path escaped trusted output root".into());
            }
            let document:Value = serde_json::from_slice(&fs::read(source)
                .map_err(|e|format!("Committed DAG child output unavailable: {e}"))?)
                .map_err(|e|format!("Committed DAG child output invalid: {e}"))?;
            if document.get("status")!=Some(&json!("COMPLETED"))
                ||!document.get("output").is_some_and(Value::is_object)
                ||!document.get("artifacts").is_some_and(|a|a.is_object()||a.is_array()){
                return Err(format!("Coordinator child {node_id} failed structured result verification"));
            }
            outputs.insert(node_id.clone(),json!({"taskId":task_id,
                "status":"SUCCEEDED","resultPath":source,
                "output":document["output"]}));
            artifacts.insert(node_id.clone(),document["artifacts"].clone());
        }
        let receipt=json!({
            "status":"COMPLETED", "schemaVersion":1,
            "jobId":job.get("id"), "coordinatorTaskId":parent.get("id"),
            "summary":"Coordinator DAG completed with committed child results",
            "output":{"dag":result["data"]["dag"],"nodes":outputs},
            "artifacts":artifacts,
            "committedAt":parent.get("updatedAt")
        });
        let bytes=serde_json::to_vec_pretty(&receipt).map_err(|e|e.to_string())?;
        // Same-directory temp + hard link is atomic/no-clobber on APFS.
        let temporary=directory.join(format!(".dag-coordinator-{}-{}.tmp",
            s(parent,"id"),crate::events::random_uuid()));
        let mut file=fs::OpenOptions::new().write(true).create_new(true)
            .open(&temporary).map_err(|e|e.to_string())?;
        let write=(||->Result<bool,String>{
            file.write_all(&bytes).map_err(|e|e.to_string())?;
            file.sync_all().map_err(|e|e.to_string())?;
            match fs::hard_link(&temporary,path){
                Ok(())=>Ok(true),
                Err(e) if e.kind()==std::io::ErrorKind::AlreadyExists=>Ok(false),
                Err(e)=>Err(format!("Coordinator receipt materialization failed: {e}"))
            }
        })();
        drop(file);
        let _=fs::remove_file(&temporary);
        if write? {created+=1;}
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime,UNIX_EPOCH};
    fn test_project() -> std::path::PathBuf {
        let path=std::env::temp_dir().join(format!("r2-dag-receipt-{}-{}",
            std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
        fs::create_dir_all(path.join("runs/test/.dag-node-results")).unwrap();
        path
    }
    fn fixture(project:&Path)->Value {
        let graph="flowchart LR\n  a[agent:stage-a] --> b[agent:stage-b]";
        let hash=format!("{:x}",Sha256::digest(graph.as_bytes()));
        let path=project.join("runs/test/.dag-node-results/2.json");
        fs::write(&path,r#"{"status":"COMPLETED","output":{"x":3},"artifacts":[]}"#).unwrap();
        let b=project.join("runs/test/.dag-node-results/3.json");
        fs::write(&b,r#"{"status":"COMPLETED","output":{"x":4},"artifacts":[]}"#).unwrap();
        json!({"id":"1","tasks":[
            {"id":"1","state":"SUCCEEDED","agentGraph":graph,"updatedAt":"2026-11-21T12:00:00Z",
                "output":{"kind":"file","path":project.join("runs/test/neo-project-run.result.json")},
                "result":{"summary":"DAG completed","data":{"dag":{"version":1,"graphHash":hash},"nodes":{"a":"2","b":"3"}}}},
            {"id":"2","state":"SUCCEEDED","dagNode":{"parentTaskId":"1","nodeId":"a","graphHash":hash},
                "output":{"kind":"file","path":path}},
            {"id":"3","state":"SUCCEEDED","dagNode":{"parentTaskId":"1","nodeId":"b","graphHash":hash},
                "output":{"kind":"file","path":b}}]})
    }
    #[test]
    fn committed_receipt_is_created_once_and_proves_child_bytes() {
        let project=test_project();let job=fixture(&project);
        assert_eq!(materialize_committed_dag_receipts(&job,&project,&project).unwrap(),1);
        let receipt:Value=serde_json::from_slice(&fs::read(project.join("runs/test/neo-project-run.result.json")).unwrap()).unwrap();
        assert_eq!(receipt["status"],"COMPLETED");
        assert_eq!(receipt["output"]["nodes"]["a"]["output"]["x"],3);
        assert_eq!(materialize_committed_dag_receipts(&job,&project,&project).unwrap(),0);
        fs::remove_dir_all(&project).unwrap();
    }
    #[test]
    fn refused_before_sqlite_dag_success_or_when_result_tampered() {
        let project=test_project();let mut job=fixture(&project);
        job["tasks"][1]["state"]=json!("FAILED");
        assert!(materialize_committed_dag_receipts(&job,&project,&project).is_err());
        assert!(!project.join("runs/test/neo-project-run.result.json").exists());
        job["tasks"][1]["state"]=json!("SUCCEEDED");
        job["tasks"][0]["result"]["data"]["dag"]["graphHash"]=json!("fake");
        assert!(materialize_committed_dag_receipts(&job,&project,&project).is_err());
        assert!(!project.join("runs/test/neo-project-run.result.json").exists());
        fs::remove_dir_all(&project).unwrap();
    }
    #[test]
    fn existing_coordinator_receipt_is_preserved_verbatim() {
        let project=test_project();let job=fixture(&project);
        let target=project.join("runs/test/neo-project-run.result.json");
        fs::write(&target,b"operator supplied authoritative receipt\n").unwrap();
        assert_eq!(materialize_committed_dag_receipts(&job,&project,&project).unwrap(),0);
        assert_eq!(fs::read(&target).unwrap(),b"operator supplied authoritative receipt\n");
        fs::remove_dir_all(project).unwrap();
    }
    #[test]
    fn isolated_workspace_direct_output_requires_explicit_test_root() {
        let sandbox=test_project();
        let project=sandbox.join("fixture");
        fs::create_dir_all(project.join("runs/test/.dag-node-results")).unwrap();
        let mut job=fixture(&project);
        let declared=sandbox.join("result-2.json");
        job["tasks"][0]["output"]["path"]=json!(declared);
        assert!(materialize_committed_dag_receipts(&job,&project,&project).is_err(),
            "live project root must reject a sibling output");
        assert!(!declared.exists());
        assert_eq!(materialize_committed_dag_receipts(&job,&project,&sandbox).unwrap(),1);
        let proof:Value=serde_json::from_slice(&fs::read(&declared).unwrap()).unwrap();
        assert_eq!(proof["status"],"COMPLETED");
        fs::remove_dir_all(sandbox).unwrap();
    }
    #[test]
    fn isolated_cli_fixture_may_store_dag_node_files_in_explicit_sandbox() {
        let sandbox=test_project();
        let project=sandbox.join("fixture");
        fs::create_dir_all(project.join("runs/test/.dag-node-results")).unwrap();
        fs::create_dir_all(sandbox.join(".dag-node-results")).unwrap();
        let mut job=fixture(&project);
        let source=job["tasks"][1]["output"]["path"].as_str().unwrap().to_string();
        let relocated=sandbox.join(".dag-node-results/2.json");
        fs::copy(source,&relocated).unwrap();
        job["tasks"][1]["output"]["path"]=json!(relocated);
        job["tasks"][0]["output"]["path"]=json!(sandbox.join("result-2.json"));
        assert!(materialize_committed_dag_receipts(&job,&project,&project).is_err(),
            "a live Project cannot read an outside DAG output");
        assert_eq!(materialize_committed_dag_receipts(&job,&project,&sandbox).unwrap(),1);
        let saved:Value=serde_json::from_slice(&fs::read(sandbox.join("result-2.json")).unwrap()).unwrap();
        assert_eq!(saved["output"]["nodes"]["a"]["output"]["x"],3);
        fs::remove_dir_all(sandbox).unwrap();
    }
    #[test]
    fn historical_relative_output_is_left_unmodified() {
        let project=test_project();let mut job=fixture(&project);
        job["tasks"][0]["output"]["path"]=json!("relative/result.json");
        assert_eq!(materialize_committed_dag_receipts(&job,&project,&project).unwrap(),0);
        assert!(!project.join("relative/result.json").exists());
        fs::remove_dir_all(project).unwrap();
    }
    #[test]
    fn path_escape_is_denied() {
        let project=test_project();let mut job=fixture(&project);
        job["tasks"][0]["output"]["path"]=json!(project.parent().unwrap().join("outside.json"));
        assert!(materialize_committed_dag_receipts(&job,&project,&project).is_err());
        fs::remove_dir_all(&project).unwrap();
    }
}
