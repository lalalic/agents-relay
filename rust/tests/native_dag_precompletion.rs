//! Real isolated verifier subprocess and file-envelope checks (no live Job).
use agents_relay_rust2::dag_precompletion::validate_dag_precompletion;
use serde_json::{json,Value};
use std::{fs,path::{Path,PathBuf}};
fn fixture()->(PathBuf,PathBuf,Value,Value){
    let project=std::env::temp_dir().join(format!("relay-dag-precomplete-{}-{}",
        std::process::id(),std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
    let run=project.join("runs/test");
    let output=run.join(".dag-node-results/2.json");
    fs::create_dir_all(output.parent().unwrap()).unwrap();
    let job=json!({"id":"1","projectRoot":project});
    let task=json!({"dagNode":{"nodeId":"editor"},"agentName":"editor",
        "output":{"kind":"file","path":output}});
    (project,output,job,task)
}
fn write_json(path:&Path,value:Value){fs::write(path,serde_json::to_vec(&value).unwrap()).unwrap();}
#[test]
fn real_project_stage_gate_runs_before_terminal_event(){
    let (project,result,job,task)=fixture();
    let script=project.join("scripts/validate-stage.mjs");
    fs::create_dir_all(script.parent().unwrap()).unwrap();
    write_json(&project.join("project.run.json"),json!({"stageValidation":{
        "script":"scripts/validate-stage.mjs","agents":{"editor":"editor"}}}));
    write_json(&result,json!({"status":"COMPLETED","output":{},"artifacts":[]}));
    fs::write(&script,"printf '%s\\n' '{\"stage\":\"editor\",\"status\":\"FAIL\",\"errors\":[\"media incomplete\"]}' ;").unwrap();
    let error=validate_dag_precompletion(&job,&task,Path::new("/bin/sh")).unwrap_err();
    assert!(error.contains("STAGE_CONTRACT_FAILED editor"),"{error}");
    fs::write(&script,"printf '%s\\n' '{\"stage\":\"editor\",\"status\":\"PASS\",\"errors\":[]}' ;").unwrap();
    validate_dag_precompletion(&job,&task,Path::new("/bin/sh")).unwrap();
    // A malicious/broken Stage script that mutates an artifact while
    // returning PASS must not make that new content a valid proof.
    let artifact=project.join("runs/test/source.mp4");
    fs::write(&artifact,b"before Stage").unwrap();
    write_json(&result,json!({"status":"COMPLETED","output":{},"artifacts":[artifact]}));
    fs::write(&script,format!("printf 'changed' > '{}' ; printf '%s\\n' '{{\"stage\":\"editor\",\"status\":\"PASS\",\"errors\":[]}}' ;",artifact.display())).unwrap();
    let error=validate_dag_precompletion(&job,&task,Path::new("/bin/sh")).unwrap_err();
    assert!(error.contains("artifact changed during pre-completion Stage validation"),"{error}");
    fs::write(&script,"printf '%s\\n' '{\"stage\":\"editor\",\"status\":\"PASS\",\"errors\":[]}' ;").unwrap();
    validate_dag_precompletion(&job,&task,Path::new("/bin/sh")).unwrap();
    fs::remove_dir_all(project).unwrap();
}
#[test]
fn result_path_escapes_and_absent_artifacts_fail_closed(){
    let (project,result,job,mut task)=fixture();
    write_json(&result,json!({"status":"COMPLETED","output":{},"artifacts":[]}));
    validate_dag_precompletion(&job,&task,Path::new("/bin/sh")).unwrap();
    write_json(&result,json!({"status":"COMPLETED","output":{},"artifacts":["missing.mp4"]}));
    assert!(validate_dag_precompletion(&job,&task,Path::new("/bin/sh"))
        .unwrap_err().contains("unavailable"));
    task["output"]["path"]=json!("/etc/hosts");
    assert!(validate_dag_precompletion(&job,&task,Path::new("/bin/sh"))
        .unwrap_err().contains("escaped"));
    fs::remove_dir_all(project).unwrap();
}
