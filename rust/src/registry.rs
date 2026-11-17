// Port of src/registry.ts: filter and rank registered agent candidates from observed evidence.
use serde_json::{json, Value};

fn contains_all(values: &[Value], required: &[Value]) -> bool {
    required.iter().all(|value| values.contains(value))
}
fn matches(agent: &Value, query: &Value) -> bool {
    if let Some(required) = query["capabilities"].as_array() {
        if !contains_all(
            agent["capabilities"].as_array().unwrap_or(&Vec::new()),
            required,
        ) {
            return false;
        }
    }
    if let Some(runtime) = query["runtime"].as_str() {
        if agent["runtime"]["adapter"] != runtime {
            return false;
        }
    }
    if let Some(availability) = query["availability"].as_array() {
        if !availability.contains(&agent["availability"]) {
            return false;
        }
    }
    if let Some(domain) = query["trustDomain"].as_str() {
        if !agent["routing"]["trustDomains"]
            .as_array()
            .is_some_and(|values| values.iter().any(|v| v == domain))
        {
            return false;
        }
    }
    if let Some(labels) = query["labels"].as_object() {
        for (key, value) in labels {
            if agent["routing"]["labels"].get(key) != Some(value) {
                return false;
            }
        }
    }
    true
}
fn reliability(agent: &Value) -> f64 {
    let outcomes = &agent["evidence"]["outcomes"];
    let succeeded = outcomes["succeeded"].as_f64().unwrap_or(0.0);
    let total = succeeded
        + outcomes["failed"].as_f64().unwrap_or(0.0)
        + outcomes["timedOut"].as_f64().unwrap_or(0.0);
    if total == 0.0 {
        0.0
    } else {
        succeeded / total
    }
}
pub fn discover_agents(agents: &[Value], query: &Value) -> Vec<Value> {
    let mut candidates:Vec<(usize,Value,bool)>=agents.iter().enumerate().filter(|(_,agent)|matches(agent,query)).map(|(index,agent)|{
  let evaluations=agent["evidence"]["evaluations"].as_array().cloned().unwrap_or_default();let task_kind=query["taskKind"].as_str().filter(|s|!s.is_empty());let evaluated=if let Some(kind)=task_kind{evaluations.iter().any(|item|item["taskKind"]==kind)}else{!evaluations.is_empty()};
  let reasons=vec![query["capabilities"].as_array().filter(|a|!a.is_empty()).map(|a|format!("capabilities: {}",a.iter().map(|v|v.as_str().unwrap_or("")).collect::<Vec<_>>().join(", "))).unwrap_or_else(||"capabilities matched".into()),if evaluated{"observed evidence available".into()}else{"no observed evidence yet".into()}];
  (index,json!({"agent":agent,"reasons":reasons,"evidence":agent["evidence"],"exploratory":!evaluated}),!evaluated)
 }).collect();
    candidates.sort_by(|a, b| {
        if query["explore"] == true && a.2 != b.2 {
            return if a.2 {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Greater
            };
        }
        let aa = &a.1["agent"]["availability"];
        let ba = &b.1["agent"]["availability"];
        if aa != ba {
            let av = aa == "available";
            let bv = ba == "available";
            if av != bv {
                return if av {
                    std::cmp::Ordering::Less
                } else {
                    std::cmp::Ordering::Greater
                };
            }
        }
        reliability(&b.1["agent"])
            .partial_cmp(&reliability(&a.1["agent"]))
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    candidates.into_iter().map(|(_, value, _)| value).collect()
}
