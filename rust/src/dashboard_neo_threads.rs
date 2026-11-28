//! Best-effort, read-only projection from Neo Gateway sessions to Dashboard
//! thread links. Only exact Codex thread identities leave this module.
use serde_json::Value;
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use url::Url;

const MAX_SESSION_FILES: usize = 512;
const MAX_SESSION_BYTES: u64 = 16 * 1024 * 1024;
const MAX_SESSION_FILE_BYTES: u64 = 1024 * 1024;
const MAX_WANTED_THREADS: usize = 2048;

fn valid_codex_id(id: &str) -> bool {
    id.len() == 36
        && id.char_indices().all(|(i, c)| {
            if [8, 13, 18, 23].contains(&i) {
                c == '-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
}

fn safe_chatgpt_url(raw: &str) -> Option<String> {
    let url = Url::parse(raw).ok()?;
    let id = url.path().strip_prefix("/c/")?;
    if url.scheme() != "https"
        || url.host_str() != Some("chatgpt.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
        || !(8..=160).contains(&id.len())
    {
        return None;
    }
    Some(format!("https://chatgpt.com/c/{id}"))
}

/// A testable/configurable directory override; ordinary installs resolve the
/// documented Gateway location from the server process HOME.
pub fn sessions_directory() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("AGENTS_RELAY_NEO_MODEL_GATEWAY_SESSION_DIR") {
        let path = PathBuf::from(path);
        return path.is_absolute().then_some(path);
    }
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/share/neo/model-gateway/sessions"))
}

fn read_mappings(directory: &Path, wanted: &HashSet<String>) -> Option<HashMap<String, String>> {
    if wanted.is_empty() {
        return Some(HashMap::new());
    }
    let metadata = fs::symlink_metadata(directory).ok()?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return None;
    }
    let directory = fs::canonicalize(directory).ok()?;
    let mut entries = fs::read_dir(&directory)
        .ok()?
        .collect::<Result<Vec<_>, _>>()
        .ok()?;
    entries.sort_by_key(|entry| entry.file_name());
    let mut mappings = HashMap::<String, Option<String>>::new();
    let mut duplicates = HashSet::new();
    let mut total_bytes = 0u64;
    let mut count = 0usize;
    for entry in entries {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("sess_") || !name.ends_with(".json") {
            continue;
        }
        count += 1;
        if count > MAX_SESSION_FILES {
            return None;
        }
        let kind = entry.file_type().ok()?;
        if !kind.is_file() || kind.is_symlink() {
            return None;
        }
        let size = entry.metadata().ok()?.len();
        total_bytes = total_bytes.checked_add(size)?;
        if size > MAX_SESSION_FILE_BYTES || total_bytes > MAX_SESSION_BYTES {
            return None;
        }
        let bytes = fs::read(entry.path()).ok()?;
        let session: Value = serde_json::from_slice(&bytes).ok()?;
        let Some(codex_id) = session.get("codexThreadId").and_then(Value::as_str) else {
            continue;
        };
        if !wanted.contains(codex_id) {
            continue;
        }
        let chatgpt_url = session
            .get("threadUrl")
            .and_then(Value::as_str)
            .and_then(safe_chatgpt_url);
        let thread_id = session.get("threadId").and_then(Value::as_str);
        let mapping = chatgpt_url.filter(|url| url.rsplit('/').next() == thread_id);
        if mappings.insert(codex_id.to_owned(), mapping).is_some() {
            duplicates.insert(codex_id.to_owned());
        }
    }
    for id in duplicates {
        mappings.remove(&id);
    }
    Some(
        mappings
            .into_iter()
            .filter_map(|(id, url)| url.map(|url| (id, url)))
            .collect(),
    )
}

fn project_task(task: &mut Value, mappings: &HashMap<String, String>) {
    let mut project = |entry: &mut Value, route: &Value, id: &str| {
        if route.get("profile").and_then(Value::as_str) == Some("neo") {
            entry["chatgptThreadUrl"] = mappings
                .get(id)
                .map_or(Value::Null, |url| Value::String(url.clone()));
        } else if let Some(object) = entry.as_object_mut() {
            object.remove("chatgptThreadUrl");
        }
    };
    if let Some(id) = task
        .get("threadId")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        let route = task.get("threadRoute").cloned().unwrap_or(Value::Null);
        project(task, &route, &id);
    }
    if let Some(history) = task.get_mut("threadHistory").and_then(Value::as_array_mut) {
        for entry in history {
            let id = entry
                .get("threadId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_owned();
            let route = entry.get("route").cloned().unwrap_or(Value::Null);
            project(entry, &route, &id);
        }
    }
}

/// Attach only validated exact-match URLs; lookup errors fail closed and never
/// affect Dashboard availability.
pub fn project_jobs(jobs: &mut [Value], directory: Option<&Path>) {
    let mut wanted = HashSet::new();
    for job in jobs.iter() {
        if let Some(tasks) = job.get("tasks").and_then(Value::as_array) {
            for task in tasks {
                if let Some(id) = task.get("threadId").and_then(Value::as_str) {
                    if task.pointer("/threadRoute/profile").and_then(Value::as_str) == Some("neo")
                        && valid_codex_id(id)
                    {
                        wanted.insert(id.to_owned());
                    }
                }
                if let Some(history) = task.get("threadHistory").and_then(Value::as_array) {
                    for item in history {
                        if let Some(id) = item.get("threadId").and_then(Value::as_str) {
                            if item.pointer("/route/profile").and_then(Value::as_str) == Some("neo")
                                && valid_codex_id(id)
                            {
                                wanted.insert(id.to_owned());
                            }
                        }
                    }
                }
            }
        }
    }
    if wanted.len() > MAX_WANTED_THREADS {
        wanted.clear();
    }
    let mappings = directory
        .and_then(|dir| read_mappings(dir, &wanted))
        .unwrap_or_default();
    for job in jobs {
        if let Some(tasks) = job.get_mut("tasks").and_then(Value::as_array_mut) {
            for task in tasks {
                project_task(task, &mappings);
            }
        }
    }
}

pub fn project_thread_links(value: &mut Value, directory: Option<&Path>) {
    if let Some(jobs) = value.get_mut("jobs").and_then(Value::as_array_mut) {
        project_jobs(jobs, directory);
    } else if let Some(jobs) = value.as_array_mut() {
        project_jobs(jobs, directory);
    } else {
        project_jobs(std::slice::from_mut(value), directory);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "relay-neo-thread-map-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn add(&self, name: &str, value: &str) {
            fs::write(self.0.join(name), value).unwrap();
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    const CODEX: &str = "38f84f9e-410d-4e36-96e0-a420594a102f";
    const CHATGPT: &str = "chatgptThread_12345678";
    fn session(owner: &str, id: &str, url: &str) -> String {
        json!({"codexThreadId":owner,"threadId":id,"threadUrl":url}).to_string()
    }
    fn task() -> Value {
        json!({"id":"1","adapter":"codex","threadId":CODEX,
        "threadRoute":{"provider":"neo-local","model":"neo","profile":"neo"},
        "threadHistory":[{"threadId":"38f84f9e-410d-4e36-96e0-a420594a102e",
            "route":{"provider":"neo-local","model":"neo","profile":"neo"}}]})
    }

    #[test]
    fn exact_owner_and_validated_url_are_projected_for_current_and_historical_threads() {
        let f = Fixture::new();
        let historical = "38f84f9e-410d-4e36-96e0-a420594a102e";
        f.add(
            "sess_current.json",
            &session(CODEX, CHATGPT, &format!("https://chatgpt.com/c/{CHATGPT}")),
        );
        f.add(
            "sess_history.json",
            &session(
                historical,
                "chatgptThread_abcdefgh",
                "https://chatgpt.com/c/chatgptThread_abcdefgh",
            ),
        );
        let mut value = json!({"tasks":[task()]});
        project_thread_links(&mut value, Some(&f.0));
        assert_eq!(
            value["tasks"][0]["chatgptThreadUrl"],
            format!("https://chatgpt.com/c/{CHATGPT}")
        );
        assert_eq!(
            value["tasks"][0]["threadHistory"][0]["chatgptThreadUrl"],
            "https://chatgpt.com/c/chatgptThread_abcdefgh"
        );
    }

    #[test]
    fn wrong_owner_missing_malformed_and_duplicate_mappings_fail_closed() {
        for contents in [
            session(
                "38f84f9e-410d-4e36-96e0-a420594a102e",
                CHATGPT,
                &format!("https://chatgpt.com/c/{CHATGPT}"),
            ),
            session(
                CODEX,
                CHATGPT,
                "https://attacker.example/c/chatgptThread_12345678",
            ),
            "not json".into(),
        ] {
            let f = Fixture::new();
            f.add("sess_bad.json", &contents);
            let mut value = json!({"tasks":[task()]});
            project_thread_links(&mut value, Some(&f.0));
            assert!(value["tasks"][0]
                .get("chatgptThreadUrl")
                .is_none_or(Value::is_null));
        }
        let f = Fixture::new();
        f.add(
            "sess_a.json",
            &session(CODEX, CHATGPT, &format!("https://chatgpt.com/c/{CHATGPT}")),
        );
        f.add(
            "sess_b.json",
            &session(CODEX, CHATGPT, &format!("https://chatgpt.com/c/{CHATGPT}")),
        );
        let mut value = json!({"tasks":[task()]});
        project_thread_links(&mut value, Some(&f.0));
        assert!(value["tasks"][0]
            .get("chatgptThreadUrl")
            .is_none_or(Value::is_null));
    }

    #[test]
    fn missing_directory_is_nonfatal_and_non_neo_links_are_not_projected() {
        let mut value = json!({"tasks":[task()]});
        project_thread_links(&mut value, Some(Path::new("/path/that/does/not/exist")));
        assert!(value["tasks"][0]
            .get("chatgptThreadUrl")
            .is_none_or(Value::is_null));
        let mut non_neo = task();
        non_neo["threadRoute"]["profile"] = json!("");
        non_neo["chatgptThreadUrl"] = json!("https://chatgpt.com/c/forged123");
        let mut value = json!({"tasks":[non_neo]});
        project_thread_links(&mut value, None);
        assert!(value["tasks"][0].get("chatgptThreadUrl").is_none());
    }

    #[test]
    fn mixed_historical_routes_only_project_neo_entries() {
        let f = Fixture::new();
        let historical = "38f84f9e-410d-4e36-96e0-a420594a102e";
        f.add(
            "sess_history.json",
            &session(
                historical,
                "chatgptThread_history123",
                "https://chatgpt.com/c/chatgptThread_history123",
            ),
        );
        let mut value = json!({"tasks":[task()]});
        value["tasks"][0]["threadHistory"][0]["route"]["profile"] = json!("");
        project_thread_links(&mut value, Some(&f.0));
        assert!(value["tasks"][0]["threadHistory"][0]
            .get("chatgptThreadUrl")
            .is_none());
    }
}
