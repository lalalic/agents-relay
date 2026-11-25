//! Seeds a disposable canonical SQLite schema, then runs real Chrome against
//! the native daemon. Explicit opt-in: install dashboard/tests/e2e deps first.
use agents_relay_rust2::relay_store::SQLiteRelayStore;
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

struct Fixture(PathBuf);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn git(root: &Path, args: &[&str]) {
    let result = Command::new("git")
        .current_dir(root)
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
}
#[test]
#[ignore = "requires installed Chrome and npm ci in dashboard/tests/e2e"]
fn real_chrome_dashboard_regressions() {
    let repo = Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap();
    let root = Fixture(std::env::temp_dir().join(format!(
            "relay-browser-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        )));
    fs::create_dir_all(root.0.join("stores")).unwrap();
    fs::create_dir_all(root.0.join("forbidden/stores")).unwrap();
    fs::create_dir_all(root.0.join("home")).unwrap();
    for name in ["fixture", "other"] {
        let project = root.0.join(name);
        fs::create_dir_all(&project).unwrap();
        git(&project, &["init", "-q", "-b", "main"]);
        git(
            &project,
            &[
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.invalid",
                "commit",
                "--allow-empty",
                "-qm",
                "fixture",
            ],
        );
    }
    let fixture_root = root.0.join("fixture");
    let sha_at_head = || {
        String::from_utf8(
            Command::new("git")
                .current_dir(&fixture_root)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap()
                .stdout,
        )
        .unwrap()
        .trim()
        .to_owned()
    };
    let base_sha = sha_at_head();
    git(
        &fixture_root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "merged work",
        ],
    );
    let fixture_sha = sha_at_head();
    git(
        &fixture_root,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--allow-empty",
            "-qm",
            "later release",
        ],
    );
    let later_sha = sha_at_head();
    let at = "2026-11-25T10:00:00.000Z";
    for (id, name, title, state, task_state) in [
        ("91", "fixture", "Published completed job", "COMPLETED", ""),
        ("92", "fixture", "Running job", "ACTIVE", "RUNNING"),
        ("93", "other", "Queued job", "ACTIVE", "QUEUED"),
        ("94", "fixture", "Retry fixture", "ACTIVE", "FAILED"),
        ("95", "other", "Cancelled job", "CANCELLED", ""),
        ("96", "other", "Draft fixture", "DRAFT", ""),
        ("97", "fixture", "Second published job", "COMPLETED", ""),
    ] {
        let mut job = json!({"id":id,"repository":name,"projectRoot":root.0.join(name),
            "title":title,"state":state,"prNumber":0,"createdAt":at,"updatedAt":at,
            "reviewEnabled":false,"autoMerge":false,"tasks":[],"plans":[]});
        if matches!(id, "91" | "97") {
            job["localMerge"] =
                json!({"status":"succeeded","mergedCommitSha":fixture_sha,"updatedAt":at});
        }
        if state == "ACTIVE" {
            // Keep the scheduler from launching any fixture task. Control
            // endpoints still exercise canonical graph/SQLite actions.
            job["pause"] = json!({"generation":1,"requestedAt":at});
            let task_id = format!("{}1", id);
            job["tasks"] = json!([{"id":task_id,"jobId":id,"title":format!("{title} task"),
                "kind":"work","adapter":"script","state":task_state,"attempt":1,
                "maxAttempts":1,"dependencies":[],"createdAt":at,"updatedAt":at}]);
            if task_state == "RUNNING" {
                job["tasks"][0]["startedAt"] = json!(at);
            }
        }
        let store = SQLiteRelayStore::open(&root.0.join("relay.sqlite"), Some(id)).unwrap();
        store.save_job(&job).unwrap();
        store.close().unwrap();
    }
    let node = std::env::var_os("AGENTS_RELAY_SCRIPT_NODE").unwrap_or_else(|| "node".into());
    let status = Command::new(node)
        .current_dir(repo.join("dashboard/tests/e2e"))
        .args(["--test", "dashboard.test.mjs"])
        .env("RELAY_UI_FIXTURE", &root.0)
        .env("RELAY_UI_REPO", repo)
        .env("RELAY_UI_MERGED_SHA", &fixture_sha)
        .env("RELAY_UI_BASE_SHA", &base_sha)
        .env("RELAY_UI_LATER_SHA", &later_sha)
        .env("RELAY_UI_DAEMON", env!("CARGO_BIN_EXE_agents-relayd-rust"))
        .env("AGENTS_RELAY_STORE_DIR", root.0.join("forbidden/stores"))
        .status()
        .unwrap();
    assert!(status.success(), "real Chrome Dashboard suite failed");
}
