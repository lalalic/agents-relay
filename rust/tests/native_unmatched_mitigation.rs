// Real Rust public API coverage for the Node ContinuationAdapter facade and
// InMemoryStore no-op GitHub projection methods. No Codex CLI or remote call.
use agents_relay_rust2::{
    continuation::{
        CodexThreadContinuation, CommandContinuation, WebhookContinuation,
        Continuation, ContinuationAdapters,
    },
    store::InMemoryStore,
};

#[test]
fn public_continuation_adapters_delegate_exact_owned_process_and_http_contract() {
    let mut effects = Vec::<(String,Vec<String>,String)>::new();
    let mut run = |cmd:&str,args:&[&str],purpose:&str| {
        effects.push((cmd.into(),args.iter().map(|s|s.to_string()).collect(),purpose.into()));
        Ok(0)
    };
    let mut post = |_target:&str,_body:&str| -> Result<u16,String>{
        panic!("webhook not selected")
    };
    let codex=CodexThreadContinuation::new("/bin/codex-fixture");
    let command=CommandContinuation::new();
    assert_eq!(codex.kind(),"codex-thread");
    assert_eq!(command.kind(),"command");
    {
        let mut ports=ContinuationAdapters{run_owned:&mut run,post:&mut post};
        codex.r#continue("hello",Continuation::CodexThread{target:"thread-1"},&mut ports).unwrap();
        command.r#continue("world",Continuation::Command{target:"/bin/fixture"},&mut ports).unwrap();
        assert_eq!(codex.r#continue("x",Continuation::Command{target:"/bin/echo"},&mut ports).unwrap_err(),
            "Continuation is not a Codex thread");
    }
    assert_eq!(effects,vec![
        ("/bin/codex-fixture".into(),vec!["exec".into(),"resume".into(),"--dangerously-bypass-approvals-and-sandbox".into(),"thread-1".into(),"hello".into()],"continuation.codex".into()),
        ("/bin/fixture".into(),vec!["world".into()],"continuation.command".into()),
    ]);
}

#[test]
fn public_webhook_continuation_preserves_status_and_json_body(){
    let mut seen=Vec::new();
    let mut run=|_:&str,_:&[&str],_:&str| -> Result<i32,String>{panic!("not a subprocess")};
    let mut post=|target:&str,body:&str|{
        seen.push((target.to_owned(),body.to_owned()));
        Ok(503)
    };
    let webhook=WebhookContinuation::new();
    let mut ports=ContinuationAdapters{run_owned:&mut run,post:&mut post};
    assert_eq!(webhook.kind(),"webhook");
    assert_eq!(webhook.r#continue("中文",Continuation::Webhook{target:"https://local.invalid/hook"},&mut ports)
        .unwrap_err(),"Continuation webhook returned 503");
    assert_eq!(seen,vec![("https://local.invalid/hook".into(),r#"{"input":"中文"}"#.into())]);
}

#[test]
fn in_memory_store_github_projection_methods_are_lifecycle_neutral(){
    let mut store=InMemoryStore::new(None);
    assert_eq!(store.comments().len(),0);
    store.close_pull_request();
    store.update_pull_request_body("must not mutate fixture");
    assert_eq!(store.comments().len(),0);
}
