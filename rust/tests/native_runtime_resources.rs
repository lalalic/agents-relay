//! Real installed CLI resolves layered Agent contracts from its own package.
use std::{fs, path::Path, process::Command, time::{SystemTime, UNIX_EPOCH}};
fn write(p: &Path, value: &str) {
    fs::create_dir_all(p.parent().unwrap()).unwrap();
    fs::write(p, value).unwrap();
}
#[test]
fn relocated_binary_uses_its_package_not_build_root_or_cwd() {
    let tmp=std::env::temp_dir().join(format!("relay-relocation-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let package=tmp.join("installed");
    let bin=package.join("bin/agents-relay-rust");
    fs::create_dir_all(bin.parent().unwrap()).unwrap();
    fs::copy(env!("CARGO_BIN_EXE_agents-relay-rust"),&bin).unwrap();
    fs::create_dir_all(package.join("workflow")).unwrap();
    write(&package.join("skills/agents-relay/agents/planner.agent.md"),"---\nname: planner\n---\n# Installed planner\n");
    write(&package.join("skills/agents-relay/contracts/task-job-contract.md"),"# Installed contract\n");
    let workspace=tmp.join("workspace");
    let project=workspace.join("vlog");
    let global=tmp.join("global");
    fs::create_dir_all(&global).unwrap();
    write(&project.join("agents/planner.agent.md"),"---\nname: planner\nextends: planner\n---\n# Local planner\n");
    write(&project.join("agents/director.agent.md"),"---\nname: director\n---\n# Director\n");
    let run=|override_path: Option<&Path>| {
        let mut cmd=Command::new(&bin);
        cmd.current_dir(&global).env_remove("AGENTS_RELAY_RESOURCE_ROOT")
            .env("AGENTS_RELAY_STORE_DIR",tmp.join("isolated-store"))
            .args(["context","resolve","--project-path",project.to_str().unwrap(),
                "--workspace-root",workspace.to_str().unwrap(),"--global-root",global.to_str().unwrap(),
                "--role","worker","--agents","director,planner"]);
        if let Some(root)=override_path {cmd.env("AGENTS_RELAY_RESOURCE_ROOT",root);}
        cmd.output().unwrap()
    };
    let good=run(None);
    assert!(good.status.success(),"{}",String::from_utf8_lossy(&good.stderr));
    let result:serde_json::Value=serde_json::from_slice(&good.stdout).unwrap();
    assert_eq!(result["agents"].as_array().unwrap().len(),2);
    let moved=tmp.join("alternate");
    fs::rename(package.join("skills"),tmp.join("skills")).unwrap();
    let bad=run(None);
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("Relay resources not installed"));
    fs::create_dir_all(moved.join("workflow")).unwrap();
    fs::rename(tmp.join("skills"),moved.join("skills")).unwrap();
    assert!(run(Some(&moved)).status.success());
    let bad=run(Some(&tmp.join("missing")));
    assert!(!bad.status.success());
    assert!(String::from_utf8_lossy(&bad.stderr).contains("Invalid AGENTS_RELAY_RESOURCE_ROOT"));
    fs::remove_dir_all(tmp).unwrap();
}
