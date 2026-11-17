// Node provenance: src/local-job-path.ts; resolves Relay's store directory from environment or home.
use std::path::Path;

pub fn relay_store_directory(env_value: Option<&str>, home: Option<&str>) -> String {
    if let Some(value) = env_value.filter(|value| !value.is_empty()) {
        return value.to_owned();
    }
    Path::new(home.unwrap_or("."))
        .join(".agents-relay")
        .join("stores")
        .to_string_lossy()
        .into_owned()
}
