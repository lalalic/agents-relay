// Direct Rust native regression for Node src/local-merge-lock.ts atomic lease cleanup, panic safety and stale-recovery fences.
use agents_relay_rust2::local_merge_lock::{lock_directory, with_local_merge_lock};
use std::{
    fs,
    panic::{catch_unwind, AssertUnwindSafe},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
fn temp() -> std::path::PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    std::path::PathBuf::from("/tmp").join(format!("r2-lock-{}-{stamp}", std::process::id()))
}

#[test]
fn crash_like_panic_releases_only_the_owner_lock() {
    let path = temp();
    fs::create_dir_all(&path).unwrap();
    let target = "refs/heads/main";
    let result = catch_unwind(AssertUnwindSafe(|| {
        let _: Result<(), String> = with_local_merge_lock(
            &path,
            target,
            || -> Result<(), String> {
                assert!(lock_directory(&path, target).join("owner.json").is_file());
                panic!("deliberate callback panic")
            },
            Duration::from_secs(1),
        );
    }));
    assert!(result.is_err());
    assert!(!lock_directory(&path, target).exists());
    let result = with_local_merge_lock(&path, target, || Ok(42u64), Duration::from_secs(1));
    assert_eq!(result.unwrap(), 42);
    assert!(!lock_directory(&path, target).exists());
    fs::remove_dir_all(path).unwrap();
}

#[test]
fn rewritten_owner_fences_cleanup_and_different_ref_does_not_contend() {
    let root = temp();
    fs::create_dir_all(&root).unwrap();
    let first = "refs/heads/main";
    let other = "refs/heads/feature";
    let result = with_local_merge_lock(
        &root,
        first,
        || {
            let first_path = lock_directory(&root, first);
            assert!(first_path.is_dir());
            let nested =
                with_local_merge_lock(&root, other, || Ok(3), Duration::from_millis(200)).unwrap();
            assert_eq!(nested, 3);
            assert!(!lock_directory(&root, other).exists());
            fs::write(
                first_path.join("owner.json"),
                r#"{"pid":1,"host":"changed"}"#,
            )
            .unwrap();
            Ok(7)
        },
        Duration::from_millis(200),
    );
    assert_eq!(result.unwrap(), 7);
    assert!(
        lock_directory(&root, first).exists(),
        "unknown successor must be preserved"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn lock_hash_uses_stable_sha256_target_ref() {
    let root = std::path::Path::new("/tmp");
    let lock = lock_directory(root, "refs/heads/main");
    let name = lock.file_name().unwrap().to_str().unwrap();
    assert!(name.starts_with("agents-relay-merge-"));
    assert!(name.ends_with(".lockdir"));
    assert_eq!(
        name.len(),
        "agents-relay-merge-".len() + 24 + ".lockdir".len()
    );
}
