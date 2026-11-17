// Direct port of src/review-chair.ts. Pure specialist review facts; no Job/Graph decisions.
use serde_json::{json, Map, Value};
use std::collections::HashSet;

fn obj<'a>(value: &'a Value, error: &str) -> Result<&'a Map<String, Value>, String> {
    value.as_object().ok_or_else(|| error.to_owned())
}
fn field_text(value: &Value, field: &str) -> Result<String, String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| format!("Review {field} must be a non-empty string"))
}
fn target(value: &Value) -> Result<Value, String> {
    obj(value, "Review target must be an object")?;
    Ok(
        json!({"artifact":field_text(&value["artifact"],"target.artifact")?,
        "version":field_text(&value["version"],"target.version")?}),
    )
}
fn verdict(value: &Value, error: String) -> Result<String, String> {
    match value.as_str() {
        Some("pass" | "concern" | "fail" | "blocked") => Ok(value.as_str().unwrap().into()),
        _ => Err(error),
    }
}
fn optional_text(
    dst: &mut Map<String, Value>,
    value: &Value,
    key: &str,
    label: &str,
) -> Result<(), String> {
    if value.get(key).is_some() {
        dst.insert(key.into(), json!(field_text(&value[key], label)?));
    }
    Ok(())
}
pub fn parse_review_finding(value: &Value, index: usize) -> Result<Value, String> {
    let o = obj(value, &format!("Review finding {index} must be an object"))?;
    let v = verdict(
        &value["verdict"],
        format!("Review finding {index}.verdict is invalid"),
    )?;
    let mut result = Map::new();
    optional_text(&mut result, value, "id", &format!("finding {index}.id"))?;
    result.insert(
        "reviewer".into(),
        json!(field_text(
            &value["reviewer"],
            &format!("finding {index}.reviewer")
        )?),
    );
    result.insert(
        "dimension".into(),
        json!(field_text(
            &value["dimension"],
            &format!("finding {index}.dimension")
        )?),
    );
    result.insert("verdict".into(), json!(v));
    result.insert(
        "summary".into(),
        json!(field_text(
            &value["summary"],
            &format!("finding {index}.summary")
        )?),
    );
    if let Some(sev) = o.get("severity") {
        if !sev.is_null() {
            let s = sev
                .as_str()
                .ok_or("Review finding severity must be P0, P1, P2, or P3")?;
            if !matches!(s, "P0" | "P1" | "P2" | "P3") {
                return Err("Review finding severity must be P0, P1, P2, or P3".into());
            }
            result.insert("severity".into(), json!(s));
        }
    }
    for key in ["location", "recommendation", "evidence"] {
        optional_text(&mut result, value, key, &format!("finding {index}.{key}"))?;
    }
    Ok(Value::Object(result))
}
pub fn parse_specialist_review(value: &Value) -> Result<Value, String> {
    obj(value, "Specialist review must be an object")?;
    let v = verdict(
        &value["verdict"],
        "Specialist review verdict is invalid".into(),
    )?;
    let findings = value["findings"]
        .as_array()
        .ok_or("Specialist review findings must be an array")?
        .iter()
        .enumerate()
        .map(|(i, f)| parse_review_finding(f, i))
        .collect::<Result<Vec<_>, _>>()?;
    let t = target(&value["target"])?;
    for finding in &findings {
        if finding["reviewer"] != field_text(&value["reviewer"], "reviewer")?
            || finding["dimension"] != field_text(&value["dimension"], "dimension")?
        {
            return Err(
                "Specialist review findings must preserve reviewer and dimension attribution"
                    .into(),
            );
        }
    }
    Ok(
        json!({"reviewer":field_text(&value["reviewer"],"reviewer")?,
        "dimension":field_text(&value["dimension"],"dimension")?,"target":t,"verdict":v,"findings":findings}),
    )
}
// JSON boundary validation mirrors JS Number.isInteger(max) and max >= 1.
pub fn panel_max(input: Option<&Value>) -> Result<usize, String> {
    match input {
        None => Ok(5),
        Some(v) => v
            .as_u64()
            .filter(|n| *n > 0)
            .and_then(|n| usize::try_from(n).ok())
            .ok_or_else(|| "Review panel max must be a positive integer".into()),
    }
}
pub fn select_review_panel(
    candidates: &[Value],
    dimensions: &[Value],
    max: usize,
) -> Result<Vec<Value>, String> {
    if max == 0 {
        return Err("Review panel max must be a positive integer".into());
    }
    let mut dims = dimensions.iter().enumerate().collect::<Vec<_>>();
    dims.sort_by(|(a, x), (b, y)| {
        let p = |v: &Value| v["priority"].as_f64().unwrap_or(99.0);
        p(x).total_cmp(&p(y)).then(a.cmp(b))
    });
    let mut used = HashSet::new();
    let mut result = Vec::new();
    for (_, dimension) in dims {
        let Some(name) = dimension["name"].as_str() else {
            continue;
        };
        let found = candidates.iter().find(|candidate| {
            let agent = candidate
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| candidate["agent"].as_str())
                .unwrap_or("");
            let caps = candidate
                .get("name")
                .map(|_| &candidate["capabilities"])
                .unwrap_or(&candidate["dimensions"]);
            !used.contains(agent)
                && caps.as_array().is_some_and(|d| {
                    d.iter().any(|s| {
                        s.as_str()
                            .is_some_and(|s| s.to_lowercase() == name.to_lowercase())
                    })
                })
        });
        if let Some(c) = found {
            let agent = c
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| c["agent"].as_str())
                .unwrap_or("");
            let reason = format!(
                "Visible agent capability matches the {name} review dimension{}.",
                c["description"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(": {s}"))
                    .unwrap_or_default()
            );
            result.push(json!({"agent":agent,"dimension":name,"reason":reason}));
            used.insert(agent.to_string());
            if result.len() >= max {
                break;
            }
        }
    }
    Ok(result)
}
pub fn specialist_review_task_metadata(t: &Value, member: &Value, round: u64) -> Value {
    json!({"role":"specialist","target":t,"dimension":member["dimension"],"selectionReason":member["reason"],"round":round})
}
pub fn create_specialist_review_tasks(
    tasks: &[Value],
    t: &Value,
    panel: &[Value],
    round: u64,
) -> Vec<Value> {
    let existing = tasks
        .iter()
        .filter(|task| task["review"]["role"] == "specialist")
        .map(|task| {
            format!(
                "{}@{}:{}:{}",
                task["review"]["target"]["artifact"]
                    .as_str()
                    .unwrap_or("undefined"),
                task["review"]["target"]["version"]
                    .as_str()
                    .unwrap_or("undefined"),
                task["review"]["dimension"].as_str().unwrap_or("undefined"),
                task["agentName"].as_str().unwrap_or("")
            )
        })
        .collect::<HashSet<_>>();
    panel
        .iter()
        .filter(|m| {
            !existing.contains(&format!(
                "{}@{}:{}:{}",
                t["artifact"].as_str().unwrap_or(""),
                t["version"].as_str().unwrap_or(""),
                m["dimension"].as_str().unwrap_or(""),
                m["agent"].as_str().unwrap_or("")
            ))
        })
        .map(|m| specialist_review_task_metadata(t, m, round))
        .collect()
}
pub fn create_review_chair_execution_plan(
    agents: &[Value],
    t: &Value,
    max: usize,
) -> Result<Value, String> {
    let mut seen = HashSet::new();
    let mut dims = Vec::new();
    for agent in agents {
        for value in agent["capabilities"].as_array().into_iter().flatten() {
            if let Some(name) = value.as_str() {
                if name != "model" && seen.insert(name.to_string()) {
                    dims.push(json!({"name":name}));
                }
            }
        }
    }
    let panel = select_review_panel(agents, &dims, max)?;
    Ok(
        json!({"target":t,"specialistTasks":create_specialist_review_tasks(&[],t,&panel,1),"panel":panel}),
    )
}
fn key(f: &Value) -> String {
    let location = f["location"].as_str().unwrap_or("");
    let summary = f["summary"]
        .as_str()
        .unwrap_or("")
        .to_lowercase()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    format!("{location}|{summary}")
}
fn priority(f: &Value) -> String {
    f["severity"]
        .as_str()
        .unwrap_or(match f["verdict"].as_str().unwrap_or("") {
            "blocked" => "P0",
            "fail" => "P1",
            _ => "P2",
        })
        .into()
}
pub fn synthesize_review(t: &Value, panel: &[Value], reviews: &[Value]) -> Result<Value, String> {
    for review in reviews {
        if review["target"]["artifact"] != t["artifact"]
            || review["target"]["version"] != t["version"]
        {
            return Err(format!(
                "Specialist review {} targets {}@{}, expected {}@{}",
                review["reviewer"].as_str().unwrap_or("undefined"),
                review["target"]["artifact"].as_str().unwrap_or("undefined"),
                review["target"]["version"].as_str().unwrap_or("undefined"),
                t["artifact"].as_str().unwrap_or("undefined"),
                t["version"].as_str().unwrap_or("undefined")
            ));
        }
    }
    let mut groups: Vec<Vec<Value>> = Vec::new();
    let mut keys = Vec::new();
    for r in reviews {
        for f in r["findings"].as_array().into_iter().flatten() {
            let k = key(f);
            if let Some(index) = keys.iter().position(|v| v == &k) {
                groups[index].push(f.clone());
            } else {
                keys.push(k);
                groups.push(vec![f.clone()]);
            }
        }
    }
    let mut findings = Vec::new();
    let mut conflicts = Vec::new();
    let mut used = HashSet::new();
    for (index, group) in groups.iter().enumerate() {
        let id0 = group[0]["id"].as_str().unwrap_or("").to_string();
        let preferred = if id0.is_empty() {
            format!("finding-{}", index + 1)
        } else {
            id0
        };
        let mut id = preferred.clone();
        let mut suffix = 2;
        while used.contains(&id) {
            id = format!("{preferred}-{suffix}");
            suffix += 1;
        }
        used.insert(id.clone());
        let mut merged = group[0].as_object().cloned().unwrap_or_default();
        merged.insert("id".into(), json!(id));
        merged.insert(
            "attributions".into(),
            json!(group
                .iter()
                .map(|f| {
                    let mut m = Map::new();
                    m.insert("reviewer".into(), f["reviewer"].clone());
                    m.insert("dimension".into(), f["dimension"].clone());
                    if f["id"].as_str().is_some_and(|s| !s.is_empty()) {
                        m.insert("findingId".into(), f["id"].clone());
                    }
                    Value::Object(m)
                })
                .collect::<Vec<_>>()),
        );
        findings.push(Value::Object(merged));
        if group
            .iter()
            .map(|f| f["verdict"].as_str().unwrap_or(""))
            .collect::<HashSet<_>>()
            .len()
            > 1
        {
            conflicts.push(json!({"findingIds":[id],"resolution":format!("Prioritize the more severe disposition and preserve all specialist attribution: {}.",
                group.iter().map(|f|format!("{}={}",f["reviewer"].as_str().unwrap_or(""),f["verdict"].as_str().unwrap_or(""))).collect::<Vec<_>>().join(", "))}));
        }
    }
    let mut actions=findings.iter().filter(|f|f["verdict"]!="pass").map(|f|{
        json!({"priority":priority(f),"action":f["recommendation"].as_str().map(str::to_owned)
            .unwrap_or_else(||format!("Address: {}",f["summary"].as_str().unwrap_or(""))),
            "findingIds":[f["id"]],"rationale":f["evidence"].as_str().map(str::to_owned)
                .unwrap_or_else(||format!("Raised by {} for {}.",f["reviewer"].as_str().unwrap_or(""),f["dimension"].as_str().unwrap_or("")))})
    }).collect::<Vec<_>>();
    actions.sort_by(|a, b| {
        a["priority"]
            .as_str()
            .cmp(&b["priority"].as_str())
            .then_with(|| a["action"].as_str().cmp(&b["action"].as_str()))
    });
    let covered = reviews
        .iter()
        .filter_map(|r| r["dimension"].as_str())
        .collect::<HashSet<_>>();
    let missing = panel
        .iter()
        .filter(|m| !covered.contains(m["dimension"].as_str().unwrap_or("")))
        .map(|m| m["dimension"].clone())
        .collect::<Vec<_>>();
    let unresolved = findings
        .iter()
        .filter(|f| f["verdict"] == "blocked")
        .cloned()
        .collect::<Vec<_>>();
    Ok(
        json!({"target":t,"panel":panel,"findings":findings,"conflicts":conflicts,"actions":actions,"unresolved":unresolved,
        "needsAdditionalSpecialist":!missing.is_empty(),"missingDimensions":missing}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_untrusted_specialist() {
        assert_eq!(
            parse_specialist_review(&json!({"verdict":"pass","findings":[]})).unwrap_err(),
            "Review target must be an object"
        );
    }
    #[test]
    fn unique_ids() {
        let t = json!({"artifact":"a","version":"1"});
        let r = json!({"target":t,"dimension":"security","reviewer":"s","findings":[{"id":"x","reviewer":"s","dimension":"security","verdict":"fail","summary":"foo"},{"id":"x","reviewer":"s","dimension":"security","verdict":"fail","summary":"bar"}]});
        let x = synthesize_review(&t, &[], &[r]).unwrap();
        assert_eq!(x["findings"][1]["id"], "x-2");
    }
}
