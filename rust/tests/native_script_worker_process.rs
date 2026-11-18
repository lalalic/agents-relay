//! Genuine trusted JS Shortcut module invoked as an owned process group from
//! Rust, not a Node daemon. All fixtures live under caller-owned temp roots.
use agents_relay_rust2::native_script_worker::invoke_trusted_script;
use serde_json::json;
use std::{env,fs,path::{Path,PathBuf},sync::{Arc,atomic::{AtomicBool,Ordering}},thread,time::{Duration,SystemTime,UNIX_EPOCH}};
fn node()->PathBuf {
    let path=env::var("AGENTS_RELAY_SCRIPT_NODE")
        .expect("Set AGENTS_RELAY_SCRIPT_NODE to an absolute test-owned Node interpreter");
    let path=PathBuf::from(path);
    assert!(path.is_absolute()&&path.is_file());path
}
fn fixture(script:&str)->(PathBuf,PathBuf){
    let root=env::temp_dir().join(format!("native-script-worker-{}-{}",std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos()));
    let dir=root.join("agents/.shortcut");fs::create_dir_all(&dir).unwrap();
    let file=dir.join("fixture.agent.mjs");fs::write(&file,script).unwrap();
    (root,file)
}
#[test]
fn executes_trusted_js_shortcut_and_receives_single_json_output(){
    let (root,script)=fixture(r#"export async function run({input,runCommand}) {
        console.log('do not pollute stdout');
        return {status:'COMPLETED',output:{message:input.message,execution:input.executionId},artifacts:{}};
    }"#);
    let cancelled=AtomicBool::new(false);
    let value=invoke_trusted_script(&node(),&script,
        &json!({"message":"hello", "executionId":"run-2"}),&cancelled,6000).unwrap();
    assert_eq!(value["output"],json!({"message":"hello","execution":"run-2"}));
    assert_eq!(value["status"],"COMPLETED");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn reports_untrusted_module_failures_and_rejects_nonabsolute_paths(){
    let (root,script)=fixture("export const notRun = () => 'bad';\n");
    let cancelled=AtomicBool::new(false);
    let err=invoke_trusted_script(&node(),&script,&json!({}),&cancelled,6000).unwrap_err();
    assert!(err.contains("Agent Shortcut must export run(context)"),"{err}");
    assert!(invoke_trusted_script(Path::new("node"),&script,&json!({}),&cancelled,6000)
        .unwrap_err().contains("absolute interpreter"));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn script_timeout_terminates_owned_process_group_before_delayed_output(){
    let (root,script)=fixture(r#"import {writeFile} from 'node:fs/promises';
        export async function run({input}) {
            await new Promise(resolve => setTimeout(resolve,1500));
            await writeFile(input.late, 'should-not-exist');
            return {status:'COMPLETED',output:{},artifacts:{}};
        }"#);
    let late=root.join("late-output.txt");
    let cancelled=AtomicBool::new(false);
    let err=invoke_trusted_script(&node(),&script,&json!({"late":late}),&cancelled,85).unwrap_err();
    assert!(err.contains("timed out"),"{err}");
    thread::sleep(Duration::from_millis(260));
    assert!(!late.exists(),"Owned subprocess kept executing after timeout");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn script_cancellation_has_no_delayed_effect(){
    let (root,script)=fixture(r#"import {writeFile} from 'node:fs/promises';
        export async function run({input}) {
            await new Promise(resolve => setTimeout(resolve,1200));
            await writeFile(input.late, 'should-not-exist');
            return {status:'COMPLETED',output:{},artifacts:{}};
        }"#);
    let late=root.join("cancelled-output.txt");
    let cancelled=Arc::new(AtomicBool::new(false));
    let marker=Arc::clone(&cancelled);
    thread::spawn(move||{thread::sleep(Duration::from_millis(50));marker.store(true,Ordering::Release);});
    let err=invoke_trusted_script(&node(),&script,&json!({"late":late}),&cancelled,4500).unwrap_err();
    assert!(err.contains("cancelled"),"{err}");
    thread::sleep(Duration::from_millis(260));
    assert!(!late.exists(),"Owned subprocess kept executing after cancellation");
    fs::remove_dir_all(root).unwrap();
}
