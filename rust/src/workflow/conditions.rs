// Port of src/workflow/conditions.ts: evaluate pure conditions and effect verification.
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::sync::Arc;

// Node ConditionSpec.check is caller-supplied, not only booleanCondition.
// Preserve that callback contract for native Graph guards and effect checks.
pub type ConditionCheck = Arc<dyn Fn(&Value) -> &'static str + Send + Sync>;
pub struct ConditionSpec {
    pub id: String,
    pub check: ConditionCheck,
}

pub struct ConditionRegistry {
    specs: Vec<Value>,
    custom_checks: HashMap<String, ConditionCheck>,
}
impl ConditionRegistry {
    pub fn new(specs: Vec<Value>) -> Result<Self, String> {
        validate_specs(&specs)?;
        Ok(Self {
            specs,
            custom_checks: HashMap::new(),
        })
    }
    pub fn new_custom(specs: Vec<ConditionSpec>) -> Result<Self, String> {
        let source = specs
            .iter()
            .map(|spec| json!({"id":spec.id}))
            .collect::<Vec<_>>();
        validate_specs(&source)?;
        let custom_checks = specs
            .into_iter()
            .map(|spec| (spec.id, spec.check))
            .collect();
        Ok(Self {
            specs: source,
            custom_checks,
        })
    }
    pub fn discover(&self) -> Vec<String> {
        discover(&self.specs)
    }
    pub fn inspect(&self, id: &str) -> Result<Value, String> {
        self.specs
            .iter()
            .find(|s| s["id"] == id)
            .cloned()
            .ok_or_else(|| format!("unknown condition: {id}"))
    }
    pub fn check(&self, id: &str, facts: &Value) -> Result<&'static str, String> {
        if let Some(custom) = self.custom_checks.get(id) {
            return Ok(custom(facts));
        }
        check(&self.specs, id, facts)
    }
    pub fn inspect_custom_check(&self, id: &str) -> Result<Option<&ConditionCheck>, String> {
        self.inspect(id)?;
        Ok(self.custom_checks.get(id))
    }
    pub fn guard(&self, id: &str, facts: &Value) -> Result<bool, String> {
        Ok(self.check(id, facts)? == "Verified")
    }
}
pub fn boolean_condition(id: &str) -> Value {
    json!({"id":id,"kind":"boolean"})
}
pub fn discover(specs: &[Value]) -> Vec<String> {
    let mut ids: Vec<String> = specs
        .iter()
        .filter_map(|s| s["id"].as_str().map(str::to_owned))
        .collect();
    ids.sort();
    ids
}
pub fn check(specs: &[Value], id: &str, facts: &Value) -> Result<&'static str, String> {
    let found = specs
        .iter()
        .find(|s| s["id"] == id)
        .ok_or_else(|| format!("unknown condition: {id}"))?;
    if found["kind"] == "boolean" {
        return Ok(match facts.get(id) {
            Some(Value::Bool(true)) => "Verified",
            Some(Value::Bool(false)) => "Failed",
            _ => "Unknown",
        });
    }
    Ok(match found["outcome"].as_str().unwrap_or("Unknown") {
        "Verified" => "Verified",
        "Failed" => "Failed",
        _ => "Unknown",
    })
}
pub fn validate_specs(specs: &[Value]) -> Result<(), String> {
    let mut m = Map::new();
    for s in specs {
        let id = s["id"].as_str().unwrap_or("");
        if m.insert(id.to_owned(), Value::Null).is_some() {
            return Err(format!("duplicate condition: {id}"));
        }
    }
    Ok(())
}
pub fn verify(
    specs: &[Value],
    action: &str,
    condition: &str,
    facts: &Value,
) -> Result<Value, String> {
    Ok(json!({"actionId":action,"conditionId":condition,"outcome":check(specs,condition,facts)?}))
}
pub fn verify_action_effect(
    registry: &ConditionRegistry,
    action: &str,
    condition: &str,
    facts: &Value,
) -> Result<Value, String> {
    Ok(
        json!({"actionId":action,"conditionId":condition,"outcome":registry.check(condition,facts)?}),
    )
}
pub fn safe_retry(outcome: &str) -> bool {
    outcome == "Failed"
}
pub fn safe_retry_allowed(outcome: &str) -> bool {
    safe_retry(outcome)
}
