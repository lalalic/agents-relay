// CLI review host adapter contract. Host/daemon calls are injected test ports;
// no Neo tool, Relay daemon, real user review or live account is contacted.
use agents_relay_rust2::cli_review::{
    run_interactive_review_command,run_review_command,
};
use serde_json::{json,Value};
use std::{cell::RefCell,fs,path::PathBuf};
fn strings(args:&[&str])->Vec<String>{args.iter().map(|s|s.to_string()).collect()}
#[test]
fn request_writes_private_handoff_calls_approved_host_port_and_cleans_up(){
    let seen=RefCell::new(None::<PathBuf>);
    let args=strings(&["request","--path","/tmp/fixture-review-source",
        "--id","51","--task-id","72","--execution-id","generation-1"]);
    let result=run_interactive_review_command(&args,|path|{
        assert!(path.is_absolute());
        #[cfg(unix)]{
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(path).unwrap().permissions().mode() & 0o777,0o600);
            assert_eq!(fs::metadata(path.parent().unwrap()).unwrap()
                .permissions().mode() & 0o777,0o700);
        }
        let handoff:Value=serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(handoff,json!({"path":"/tmp/fixture-review-source",
            "relay":{"jobId":"51","taskId":"72","executionId":"generation-1"}}));
        *seen.borrow_mut()=Some(path.to_owned());
        Ok(r#"{"result":{"id":"review-fixture"}}"#.into())
    },|_,body|{assert_eq!(body["command"],"review.interactive.check");Ok(json!({"enabled":true}))})
    .unwrap();
    assert_eq!(result["result"]["id"],"review-fixture");
    assert!(!seen.borrow().as_ref().unwrap().exists());
}
#[test]
fn rejected_review_tool_receipt_cannot_claim_human_approval(){
    let file=RefCell::new(None::<PathBuf>);
    let args=strings(&["--path","/tmp/fixture","--id","51",
        "--task-id","72","--execution-id","gen"]);
    let error=run_interactive_review_command(&args,|path|{
        *file.borrow_mut()=Some(path.to_owned());
        Ok(r#"{"result":{"isError":true,"humanApproved":true}}"#.into())
    },|_,body|{assert_eq!(body["command"],"review.interactive.check");Ok(json!({"enabled":true}))})
    .unwrap_err();
    assert!(error.starts_with("Neo review.preview rejected:"),"{error}");
    assert!(!file.borrow().as_ref().unwrap().exists());
}
#[test]
fn review_control_actions_preserve_fenced_ids_and_reason(){
    for action in ["begin","wait","fail","abort"]{
        let mut args=strings(&[action,"--id","51","--task-id","72",
            "--execution-id","gen"]);
        if action=="fail"{args.extend(strings(&["--reason","tool unavailable"]));}
        let receipt=run_interactive_review_command(&args,|_|{
            panic!("non-request must not run review.preview");
        },|flags,body|{
            assert_eq!(flags[0],"--id");
            assert_eq!(body["command"],format!("review.interactive.{action}"));
            assert_eq!(body["jobId"],"51");
            assert_eq!(body["taskId"],"72");
            assert_eq!(body["executionId"],"gen");
            if action=="fail"{assert_eq!(body["reason"],"tool unavailable");}
            Ok(json!({"accepted":true,"action":action}))
        }).unwrap();
        assert_eq!(receipt["action"],action);
    }
}
#[test]
fn invalid_review_input_must_not_reach_host_or_graph(){
    for args in [strings(&[]),strings(&["request"]),
        strings(&["--path","relative","--id","1","--task-id","2","--execution-id","3"]),
        strings(&["fail","--id","1","--task-id","2","--execution-id","3"]),
    ]{
        assert!(run_interactive_review_command(&args,|_|panic!("bad host request"),
            |_,_|->Result<Value,String>{panic!("bad daemon request")}).is_err());
    }
}
#[test]
fn review_dispatch_routes_job_and_run_without_fabricating_delivery(){
    let args=strings(&["--repo","fixture","--id","51","--thread-id","thread-51"]);
    let job=run_review_command("job",&args,|_|panic!("no preview"),|flags,request|{
        assert_eq!(flags,&args);
        assert_eq!(request["command"],"review.request");
        assert_eq!(request["jobId"],"51");
        assert_eq!(request["threadId"],"thread-51");
        Ok(json!({"id":"51","prNumber":22,"reviewerThreadId":"thread-51"}))
    },|_|panic!("no outcome run")).unwrap();
    assert_eq!(job["status"],"requested");
    assert_eq!(job["pr"],22);
    assert_eq!(job["reviewerThreadId"],"thread-51");
    let run=run_review_command("run",&strings(&["--id","51"]),
        |_|panic!("no preview"),|_,_|->Result<Value,String>{panic!("no control")},
        |flags|{assert_eq!(flags[0],"--id");Ok(json!({"completed":false}))}).unwrap();
    assert_eq!(run["completed"],false);
    assert!(run_review_command("other",&args,|_|panic!(),
        |_,_|->Result<Value,String>{panic!()},|_|panic!()).is_err());
}

#[test]
fn disabled_review_never_calls_preview_host(){
    let args=strings(&["--path","/tmp/fixture","--id","51","--task-id","72","--execution-id","gen"]);
    let error=run_interactive_review_command(&args,|_|panic!("disabled review reached host"),|_,body|{
        assert_eq!(body["command"],"review.interactive.check");
        Ok(json!({"enabled":false}))
    }).unwrap_err();
    assert!(error.contains("INTERACTIVE_REVIEW_DISABLED"));
}
