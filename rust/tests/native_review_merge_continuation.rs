//! Real local Git + immutable Reviewer + Job Graph acceptance fixture.
//! No production SQLite, network, model provider, or external publication.
use agents_relay_rust2::{
    local_git_merge::{deliver_local_merge,local_merge_facts_bound,reviewed_checkout_merge_request},
    task_transitions::{completion_gate_satisfied,latest_head_approved_by_final_review},
    workflow::lifecycle::decide_job_lifecycle,
};
use serde_json::{json,Value};
use std::{path::{Path,PathBuf},process::Command,fs,time::{SystemTime,UNIX_EPOCH}};
fn command(repo:&Path,args:&[&str])->String{
    let out=Command::new("git").arg("-C").arg(repo).args(args).output().unwrap();
    assert!(out.status.success(),"git {args:?}: {}",String::from_utf8_lossy(&out.stderr));
    String::from_utf8(out.stdout).unwrap().trim().to_owned()
}
fn fixture()->(PathBuf,String,Value){
    let root=std::env::temp_dir().join(format!("relay-reviewed-merge-{}-{}",
        std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    fs::create_dir_all(&root).unwrap();
    command(&root,&["init","-q","-b","main"]);
    command(&root,&["config","user.email","relay-fixture@example.invalid"]);
    command(&root,&["config","user.name","Relay Fixture"]);
    fs::write(root.join("base.txt"),"base\n").unwrap();
    command(&root,&["add","base.txt"]);
    command(&root,&["commit","-q","-m","Initial main"]);
    command(&root,&["checkout","-q","-b","job/720-microphone-crash"]);
    fs::write(root.join("voice.swift"),"fixed microphone\n").unwrap();
    command(&root,&["add","voice.swift"]);
    command(&root,&["commit","-q","-m","Reviewed microphone fix"]);
    let head=command(&root,&["rev-parse","HEAD"]);
    let job=json!({"id":"720","repository":"fixture","state":"ACTIVE",
        "headSha":head,"autoMerge":true,"reviewEnabled":true,
        "plans":[{"id":"plan-1","round":1,"status":"FAILED"},
                 {"id":"plan-2","round":2,"status":"FAILED"}],
        "tasks":[
            {"id":"2241","title":"Coordinator","state":"SUCCEEDED",
                "kind":"work","agentGraph":{"nodes":[]}},
            {"id":"2242","agentName":"implementation","kind":"work",
                "output":{"kind":"file"},"state":"SUCCEEDED"},
            {"id":"2252","agentName":"troubleshooter","kind":"work",
                "state":"CANCELLED"},
            {"id":"2253","agentName":"job-acceptance-reviewer","kind":"work",
                "state":"SUCCEEDED","reviewHeadSha":head,
                "result":{"data":{"verdict":"approved","head_sha":head}}}],
        "review":{"outcome":"approved","headSha":head,"taskId":"2253"}}
    );
    (root,head,job)
}
fn graph()->PathBuf{Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap().join("workflow")}
#[test]
fn approved_new_head_overrides_failed_historical_plan_and_drives_git_merge(){
    let (repo,sha,mut job)=fixture();
    assert!(latest_head_approved_by_final_review(&job));
    assert!(completion_gate_satisfied(&job),"failed historical Plans are not current acceptance");
    let request=reviewed_checkout_merge_request(&repo,&job).unwrap().unwrap();
    assert_eq!(request["sourceRef"],"refs/heads/job/720-microphone-crash");
    assert_eq!(request["targetRef"],"refs/heads/main");
    assert_eq!(request["sourceSha"],sha);
    job["localMerge"]=request.clone();
    let now=chrono::Utc::now().timestamp_millis();
    let facts=local_merge_facts_bound(&job,Some(&sha),now);
    assert_eq!(facts["completionGateSatisfied"],true);
    assert_eq!(facts["localMergeRequired"],true);
    assert_eq!(facts["mergeAttemptReady"],true);
    let requested=decide_job_lifecycle(&graph(),&job,"local.merge.requested",&facts).unwrap();
    assert!(requested["actions"].as_array().unwrap().iter().any(|a|
        a.as_str()==Some("effect.deliverLocalMerge")),"{requested}");
    let receipt=deliver_local_merge(&repo,&json!({"sourceRef":request["sourceRef"],
        "targetRef":request["targetRef"],"sourceSha":sha,"correlationJobId":"720"})).unwrap();
    let parents=command(&repo,&["rev-list","--parents","-n","1",&receipt.merged_commit_sha]);
    assert!(parents.split(' ').last()==Some(sha.as_str()));
    assert_eq!(command(&repo,&["rev-parse","refs/heads/main"]),receipt.merged_commit_sha);
    assert_eq!(command(&repo,&["rev-parse","HEAD"]),sha,
        "source branch and worktree must not move when main is merged");
    job["localMerge"]["status"]=json!("succeeded");
    job["localMerge"]["mergedCommitSha"]=json!(receipt.merged_commit_sha);
    let facts=local_merge_facts_bound(&job,Some(&sha),now);
    let completed=decide_job_lifecycle(&graph(),&job,"local.completed",&facts).unwrap();
    assert_eq!(completed["target"],"COMPLETED","{completed}");
    fs::remove_dir_all(repo).unwrap();
}
#[test]
fn no_approval_wrong_head_or_moved_branch_cannot_stage_local_git_merge(){
    let (repo,_sha,mut job)=fixture();
    job["review"]["outcome"]=json!("changes_required");
    assert!(reviewed_checkout_merge_request(&repo,&job).unwrap().is_none());
    job["review"]["outcome"]=json!("approved");
    job["tasks"][3]["result"]["data"]["verdict"]=json!("changes-required");
    assert!(!completion_gate_satisfied(&job));
    assert!(reviewed_checkout_merge_request(&repo,&job).unwrap().is_none());
    job["tasks"][3]["result"]["data"]["verdict"]=json!("approved");
    job["review"]["headSha"]=json!("incorrect_sha");
    assert!(reviewed_checkout_merge_request(&repo,&job).unwrap().is_none());
    let exact=command(&repo,&["rev-parse","HEAD"]);
    job["review"]["headSha"]=json!(exact);
    fs::write(repo.join("new.txt"),"change after approval\n").unwrap();
    command(&repo,&["add","new.txt"]);
    command(&repo,&["commit","-q","-m","Unreviewed change"]);
    assert!(reviewed_checkout_merge_request(&repo,&job).unwrap_err().contains("changed after Final Review"));
    fs::remove_dir_all(repo).unwrap();
}
