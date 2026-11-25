use agents_relay_rust2::codegraph_index::{installed_codegraph, prepare_worktree_index};
use rusqlite::{Connection, OpenFlags};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "relay-codegraph-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn git(root: &Path, args: &[&str]) -> String {
    let result = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap().trim().into()
}
fn symbols(root: &Path) -> Vec<String> {
    let conn = Connection::open_with_flags(
        root.join(".codegraph/codegraph.db"),
        OpenFlags::SQLITE_OPEN_READ_WRITE,
    )
    .unwrap();
    let mut query = conn
        .prepare("SELECT name FROM nodes WHERE kind='function' ORDER BY name")
        .unwrap();
    query
        .query_map([], |r| r.get(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn existing_index_never_launches_cli_and_invalid_index_is_preserved() {
    let f = Fixture::new();
    let work = f.0.join("work");
    fs::create_dir_all(work.join(".codegraph")).unwrap();
    let db = work.join(".codegraph/codegraph.db");
    fs::write(&db, "existing index").unwrap();
    prepare_worktree_index(Path::new("/nonexistent/codegraph"), &f.0, &work).unwrap();
    assert_eq!(fs::read_to_string(&db).unwrap(), "existing index");
    fs::remove_file(&db).unwrap();
    std::os::unix::fs::symlink(f.0.join("outside.db"), &db).unwrap();
    assert!(prepare_worktree_index(Path::new("/nonexistent/codegraph"), &f.0, &work).is_err());
    assert!(fs::symlink_metadata(&db).unwrap().file_type().is_symlink());
}

#[test]
#[ignore = "requires an installed CodeGraph CLI"]
fn real_codegraph_snapshot_sync_and_worktree_cleanup() {
    let cli = installed_codegraph().expect("CodeGraph executable must be installed");
    let f = Fixture::new();
    let main = f.0.join("main");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q", "-b", "main"]);
    git(&main, &["config", "user.name", "CodeGraph Test"]);
    git(&main, &["config", "user.email", "test@example.invalid"]);
    fs::write(main.join("code.js"), "export function mainOnly() {}\n").unwrap();
    git(&main, &["add", "code.js"]);
    git(&main, &["commit", "-qm", "base"]);
    let first = f.0.join("first");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "first",
            first.to_str().unwrap(),
        ],
    );
    fs::write(first.join("code.js"), "export function firstOnly() {}\n").unwrap();
    git(&first, &["commit", "-qam", "first branch"]);
    let log = f.0.join("commands");
    let wrapper = f.0.join("codegraph");
    // The wrapper records commands and delegates to the real CLI.
    fs::write(
        &wrapper,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$1\" >> '{}'\nexec '{}' \"$@\"\n",
            log.display(),
            cli.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&wrapper, fs::Permissions::from_mode(0o700)).unwrap();
    prepare_worktree_index(&wrapper, &main, &first).unwrap();
    assert_eq!(symbols(&main), vec!["mainOnly"]);
    assert_eq!(symbols(&first), vec!["firstOnly"]);
    assert_eq!(fs::read_to_string(&log).unwrap(), "init\nsync\n");
    assert!(git(&main, &["status", "--porcelain"]).is_empty());
    assert!(git(&first, &["status", "--porcelain"]).is_empty());

    // Existing worktree indexes are never synchronized by Relay.
    prepare_worktree_index(&wrapper, &main, &first).unwrap();
    assert_eq!(fs::read_to_string(&log).unwrap(), "init\nsync\n");
    git(&main, &["merge", "--ff-only", "first"]);
    let second = f.0.join("second");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "second",
            second.to_str().unwrap(),
        ],
    );
    fs::write(second.join("code.js"), "export function secondOnly() {}\n").unwrap();
    git(&second, &["commit", "-qam", "second branch"]);
    prepare_worktree_index(&wrapper, &main, &second).unwrap();
    assert_eq!(symbols(&main), vec!["firstOnly"]);
    assert_eq!(symbols(&second), vec!["secondOnly"]);
    assert_eq!(symbols(&first), vec!["firstOnly"]);
    assert_eq!(
        fs::read_to_string(&log).unwrap(),
        "init\nsync\nsync\nsync\n"
    );
    for path in [&first, &second] {
        git(&main, &["worktree", "remove", path.to_str().unwrap()]);
        assert!(!path.exists());
    }
    assert!(git(&main, &["status", "--porcelain"]).is_empty());

    // Dirty main must not contribute its index or uncommitted source to seed.
    fs::write(main.join("code.js"), "export function privateEdit() {}\n").unwrap();
    let third = f.0.join("third");
    git(
        &main,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "third",
            third.to_str().unwrap(),
        ],
    );
    prepare_worktree_index(&wrapper, &main, &third).unwrap();
    assert_eq!(symbols(&third), vec!["firstOnly"]);
    assert_eq!(symbols(&main), vec!["firstOnly"]);
    assert_eq!(
        fs::read_to_string(&log).unwrap(),
        "init\nsync\nsync\nsync\ninit\n"
    );
}
