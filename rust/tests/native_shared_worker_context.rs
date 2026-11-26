//! Regression for real Vlog-style parent Agent inheritance with different Codex
//! model profiles. All discovery paths and the SQLite store are test-owned.
use agents_relay_rust2::{
    execution_context::resolve_agent_contract,
    native_codex_execution::native_codex_managed_prompt,
    reconciler_context::{resolve_worker_context, WorkerContextRoots},
    relay_store::SQLiteRelayStore,
};
use serde_json::json;
use std::{
    fs,
    time::{SystemTime, UNIX_EPOCH},
};
#[test]
fn codex_profiles_resolve_same_inherited_contract_and_checkout() {
    let root = std::env::temp_dir().join(format!(
        "relay-context-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let workspace = root.join("workspace");
    let global = root.join("global");
    let parent = workspace.join("parent");
    let project = parent.join("vlog");
    let checkout = workspace.join("checkout");
    for p in [&global, &parent, &project, &checkout] {
        fs::create_dir_all(p.join("agents")).unwrap();
    }
    fs::write(
        global.join("agents/global-only.agent.md"),
        "---\nname: global-only\n---\n# GLOBAL TEST CONTRACT\n",
    )
    .unwrap();
    for name in ["editor", "publisher"] {
        fs::write(
            parent.join(format!("agents/{name}.agent.md")),
            format!("---\nname: {name}\n---\n# PARENT {name} CONTRACT\n"),
        )
        .unwrap();
        fs::write(
            project.join(format!("agents/{name}.agent.md")),
            format!("---\nname: {name}\nextends: {name}\n---\n# PROJECT {name} CONTRACT\n"),
        )
        .unwrap();
    }
    let roots = WorkerContextRoots {
        workspace: workspace.clone(),
        global: global.clone(),
        codex_home: global.join(".codex"),
    };
    let db = root.join("relay.sqlite");
    let mut job = json!({"id":"91","repository":"vlog","projectRoot":project,
        "state":"ACTIVE","createdAt":"2026-11-24T00:00:00Z","updatedAt":"2026-11-24T00:00:00Z",
        "tasks":[{"id":"92","jobId":"91","kind":"work","agentName":"editor","adapter":"codex",
            "state":"QUEUED","executionId":"exec-1","attempt":1,"maxAttempts":3,
            "input":"Write private fixture output","gitDeliveryRequired":true,
            "output":{"kind":"file","path":project.join("result.json")}}]});
    let store = SQLiteRelayStore::open(&db, Some("91")).unwrap();
    store.save_job(&job).unwrap();
    drop(store);
    let codex = json!([{"name":"codex","id":"codex","capabilities":["model"]}]);
    let context = |adapter: &serde_json::Value| {
        resolve_worker_context(
            &job,
            &job["tasks"][0],
            &roots,
            &[],
            adapter.as_array().unwrap(),
        )
        .unwrap()
    };
    let a = context(&codex);
    let b = context(&codex);
    assert!(
        a.get("instructions").is_none(),
        "Directory Context is exclusively selected by effective Agent metadata"
    );
    assert!(b.get("instructions").is_none());
    assert_eq!(a["project"], b["project"]);
    for name in ["editor", "publisher", "global-only"] {
        let left = resolve_agent_contract(&a, name).unwrap();
        let right = resolve_agent_contract(&b, name).unwrap();
        assert_eq!(left["hash"], right["hash"]);
        assert_eq!(left["sources"], right["sources"]);
    }
    // The old pool-derived fixture root is not an ancestor of the actual
    // project. It must fail to find the same-name inherited definitions.
    let wrong = WorkerContextRoots::isolated(&global);
    assert!(resolve_worker_context(
        &job,
        &job["tasks"][0],
        &wrong,
        &[],
        codex.as_array().unwrap()
    )
    .unwrap_err()
    .contains("Missing base for agent"));
    let cl = native_codex_managed_prompt(&db, &job, &job["tasks"][0], &checkout, &roots).unwrap();
    job["tasks"][0]["routing"] = json!({"provider":"neo-local","profile":"neo","model":"neo"});
    let bl = native_codex_managed_prompt(&db, &job, &job["tasks"][0], &checkout, &roots).unwrap();
    assert_eq!(cl.system, bl.system);
    assert_eq!(cl.references.len(), bl.references.len());
    assert!(cl.system.contains("PARENT editor CONTRACT"));
    assert!(cl.system.contains("PROJECT editor CONTRACT"));
    for prompt in [&cl.user, &bl.user] {
        assert!(prompt.contains("job/91/task/92/execution/exec-1"));
        assert!(prompt.contains(&format!(
            "Execution checkout (required): {}",
            checkout.display()
        )));
        assert!(!prompt.contains("PROJECT editor CONTRACT"));
        assert!(!prompt.contains("PARENT editor CONTRACT"));
    }
    fs::remove_dir_all(root).unwrap();
}
