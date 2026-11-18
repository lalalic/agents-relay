use agents_relay_rust2::relayd_control::{create_workspace_control, WorkspaceControlBackend};
use serde_json::Value;
use std::path::Path;
struct NoEffects;
impl WorkspaceControlBackend for NoEffects {
    fn graph_directory(&self) -> &Path {
        Path::new("/tmp")
    }
    fn store_directory(&self) -> &Path {
        Path::new("/tmp")
    }
    fn repositories(&self) -> Vec<String> {
        Vec::new()
    }
    fn repository_path(&self, _: &str) -> Option<String> {
        None
    }
    fn known_jobs(&mut self) -> Result<Vec<Value>, String> {
        panic!("unexpected known_jobs")
    }
    fn load_job(&mut self, _: &str) -> Result<Value, String> {
        panic!("unexpected load_job")
    }
    fn save_job(&mut self, _: &Value) -> Result<Value, String> {
        panic!("unexpected save_job")
    }
    fn create_job_if_absent(&mut self, _: &Value) -> Result<Value, String> {
        panic!("unexpected create_job_if_absent")
    }
    fn mutate_job(
        &mut self,
        _: &str,
        _: &dyn Fn(&mut Value) -> Result<(), String>,
    ) -> Result<Value, String> {
        panic!("unexpected mutate_job")
    }
    fn append_task(&mut self, _: &str, _: &Value) -> Result<Value, String> {
        panic!("unexpected append_task")
    }
    fn save_agent(&mut self, _: &str, _: &Value) -> Result<(), String> {
        panic!("unexpected save_agent")
    }
    fn list_agents(&mut self, _: &str) -> Result<Vec<Value>, String> {
        panic!("unexpected list_agents")
    }
    fn wake(&mut self, _: &str, _: &str) -> Result<(), String> {
        panic!("unexpected wake")
    }
    fn refresh_inventory(&mut self) -> Result<(), String> {
        panic!("unexpected refresh_inventory")
    }
    fn publish(&mut self, _: &Value) -> Result<(), String> {
        panic!("unexpected publish")
    }
    fn manual_plan(&mut self, _: &str, _: Option<&str>, _: bool) -> Result<Value, String> {
        panic!("unexpected manual_plan")
    }
    fn review_targeted(&mut self, _: &str, _: &Value) -> Result<Value, String> {
        panic!("unexpected review_targeted")
    }
    fn blocker_ensure(&mut self, _: &Value) -> Result<Value, String> {
        panic!("unexpected blocker_ensure")
    }
    fn blocker_resolve(&mut self, _: &str, _: &str) -> Result<Value, String> {
        panic!("unexpected blocker_resolve")
    }
    fn local_head(&mut self, _: &Value) -> Result<String, String> {
        panic!("unexpected local_head")
    }
    fn fail_interactive(&mut self, _: &str, _: &str, _: &str, _: &str) -> Result<Value, String> {
        panic!("unexpected fail_interactive")
    }
}
/// Fixture backend refuses every external effect. Invalid requests must
/// fail before any store/daemon operation; real paths use workspace_control.
pub(super) fn invoke(body: &Value) -> Result<Value, String> {
    let mut backend = NoEffects;
    let mut control = create_workspace_control(&mut backend);
    control(body)
}
