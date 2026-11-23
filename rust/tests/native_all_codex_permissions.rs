// Permission consistency across every native Codex invocation boundary.
use agents_relay_rust2::{
    adapters::build_codex_args,
    codex_permissions::{exec_args,FULL_ACCESS_NO_APPROVALS},
    continuation::{Continuation,ContinuationAdapters,continue_with_adapters},
    outcome_review::outcome_review_codex_args,
    planner::build_planner_codex_args,
};
use serde_json::json;
use std::path::Path;

fn confirm(argv:&[String]) {
    assert_eq!(argv.first().map(String::as_str),Some("exec"));
    assert_eq!(argv.iter().filter(|a|a.as_str()==FULL_ACCESS_NO_APPROVALS).count(),1,"{argv:?}");
    assert!(!argv.iter().any(|a|matches!(a.as_str(),"--sandbox"|"workspace-write"|"read-only"|"--approve-for-me"|"--full-auto")),"{argv:?}");
}
#[test]
fn planner_and_adapter_and_reviewer_share_unrestricted_permissions(){
    confirm(&exec_args(true));
    let planner=build_planner_codex_args(Path::new("/tmp/relay"),"plan safely");
    confirm(&planner);
    assert!(planner.ends_with(&["--".into(),"plan safely".into()]));
    let adapter=build_codex_args(&json!({"profile":"neo","model":"gpt-6","cwd":"/tmp/repo"}),"implement");
    confirm(&adapter);
    assert!(adapter.iter().any(|a|a=="neo"));
    let reviewer=outcome_review_codex_args(Path::new("/tmp/relay-review"));
    confirm(&reviewer);
    assert!(reviewer.iter().any(|a|a=="--output-schema"));
    assert!(reviewer.iter().any(|a|a=="--ephemeral"));
}
#[test]
fn continuation_uses_full_permission_even_on_resume(){
    let mut invoked=0;
    let mut run=|cmd:&str,args:&[&str],invocation:&str|->Result<i32,String>{
        assert_eq!(cmd,"codex");
        assert_eq!(invocation,"continuation.codex");
        assert_eq!(args,&["exec","resume",FULL_ACCESS_NO_APPROVALS,"thread-id","continue"]);
        invoked+=1;
        Ok(0)
    };
    let mut post=|_:&str,_:&str|->Result<u16,String>{ panic!("no webhook") };
    continue_with_adapters("codex-thread","continue",Continuation::CodexThread{target:"thread-id"},None,
        &mut ContinuationAdapters{run_owned:&mut run,post:&mut post}).unwrap();
    assert_eq!(invoked,1);
}
