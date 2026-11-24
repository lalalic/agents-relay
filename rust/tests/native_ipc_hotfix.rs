// Direct Rust native regression: src/troubleshooter-qa-api.ts and src/webhelm-daemon-client.ts with isolated real IO.
use agents_relay_rust2::troubleshooter_qa_api as qa;
use serde_json::{json, Map, Value};
use std::{
    fs,
    io::Read,
    os::unix::net::UnixListener,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn temp() -> PathBuf {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::path::PathBuf::from("/tmp").join(format!("r2-{}-{now}", std::process::id()))
}

#[test]
fn qa_get_uses_node_utf8_replacement_and_hash() {
    use sha2::{Digest, Sha256};
    let root = temp();
    fs::create_dir_all(&root).unwrap();
    let file = root.join("qa.md");
    fs::write(&file, [0x66, 0x6f, 0x80]).unwrap();
    let result = qa::handle_troubleshooter_qa(
        &file,
        qa::Request {
            method: "GET".into(),
            content_type: None,
            body: vec![],
        },
    );
    assert_eq!(result.status, 200);
    let body: Value = serde_json::from_slice(&result.body).unwrap();
    assert_eq!(body["text"], "fo�");
    assert_eq!(
        body["hash"],
        format!("{:x}", Sha256::digest("fo�".as_bytes()))
    );
    fs::remove_dir_all(root).unwrap();
}
