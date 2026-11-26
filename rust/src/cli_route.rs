//! Detached, caller-owned choice contract. No Job, store, daemon or launch.
use crate::decision::{
    decide_choice_with, execution_decision_engine, validate_decision_request, JevDecisionEngine,
};
use serde_json::{json, Value};
use std::io::Read;

const MAX_INPUT_BYTES: u64 = 1024 * 1024;

fn read_request(args: &[String], stdin: Option<&str>) -> Result<Value, String> {
    let [flag, path] = args else {
        return Err("Usage: agents-relay route --input-file REQUEST.json|-".into());
    };
    if flag != "--input-file" || path.is_empty() {
        return Err("Usage: agents-relay route --input-file REQUEST.json|-".into());
    }
    let mut bytes = Vec::new();
    if path == "-" {
        if let Some(input) = stdin {
            if input.len() as u64 > MAX_INPUT_BYTES {
                return Err("Decision input exceeds 1 MiB".into());
            }
            bytes.extend_from_slice(input.as_bytes());
        } else {
            std::io::stdin()
                .lock()
                .take(MAX_INPUT_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|e| format!("Cannot read decision input: {e}"))?;
        }
    } else {
        std::fs::File::open(path)
            .map_err(|e| format!("Cannot open decision input: {e}"))?
            .take(MAX_INPUT_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("Cannot read decision input: {e}"))?;
    }
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err("Decision input exceeds 1 MiB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid decision JSON: {e}"))
}

pub fn choose_with(
    input: &Value,
    decide: impl FnOnce(&Value, &Value) -> Result<Value, String>,
) -> Result<Value, String> {
    let fields = input
        .as_object()
        .ok_or("Decision input must be an object")?;
    if fields
        .keys()
        .any(|k| !matches!(k.as_str(), "facts" | "contract" | "fallback"))
    {
        return Err("Unexpected decision input field".into());
    }
    if !input["facts"].is_object() {
        return Err("Decision facts must be an object".into());
    }
    let request = json!({"facts":input["facts"]});
    let contract = &input["contract"];
    validate_decision_request(&request, contract)?;
    let fallback = if let Some(value) = input.get("fallback") {
        let name = value.as_str().ok_or("Fallback must be a choice string")?;
        if !contract["choices"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == name))
        {
            return Err("Fallback is outside the decision contract".into());
        }
        Some(name)
    } else {
        None
    };
    match decide_choice_with(&request, contract, decide) {
        Ok(answer) => {
            let mut evidence = json!({"mode":"active","engine":JevDecisionEngine::NAME,
                "fallback":false,"bypassed":answer["bypassed"]==true});
            for key in ["probabilities", "usage", "latencyMs", "model"] {
                if let Some(value) = answer.get(key) {
                    evidence[key] = value.clone();
                }
            }
            Ok(json!({"type":"choice","choice":answer["choice"],"evidence":evidence}))
        }
        Err(error) => {
            let reason = crate::decision_audit::route_reason(&error);
            if let Some(choice) = fallback {
                Ok(json!({"type":"choice","choice":choice,"evidence":{
                    "mode":"active","engine":JevDecisionEngine::NAME,
                    "fallback":true,"bypassed":false,"error":reason}}))
            } else {
                Err(format!("Decision failed: {reason}"))
            }
        }
    }
}

pub fn run(args: &[String], stdin: Option<&str>) -> Result<Value, String> {
    let input = read_request(args, stdin)?;
    choose_with(&input, |request, contract| {
        execution_decision_engine().decide(request, contract)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn input() -> Value {
        json!({"facts":{"vision":true},"contract":{"type":"choice","question":"Choose one eligible profile","choices":["a","b"]}})
    }

    #[test]
    fn same_engine_contract_and_validated_result() {
        let out = choose_with(&input(), |request, contract| {
            assert_eq!(request["facts"]["vision"], true);
            assert_eq!(contract["choices"], json!(["a","b"]));
            Ok(json!({"type":"choice","choice":"b","probabilities":{"a":0.1,"b":0.9},"latencyMs":17}))
        }).unwrap();
        assert_eq!(out["choice"], "b");
        assert_eq!(out["evidence"]["probabilities"]["b"], 0.9);
        assert_eq!(out["evidence"]["latencyMs"], 17);
        assert_eq!(out["evidence"]["fallback"], false);
    }

    #[test]
    fn fallback_is_explicit_and_never_outside_contract() {
        let mut i = input();
        assert!(choose_with(&i, |_, _| Err("unavailable".into())).is_err());
        i["fallback"] = json!("a");
        let out = choose_with(&i, |_, _| Ok(json!({"choice":"not-offered"}))).unwrap();
        assert_eq!(out["choice"], "a");
        assert_eq!(out["evidence"]["fallback"], true);
        i["fallback"] = json!("not-offered");
        assert!(choose_with(&i, |_, _| panic!("invalid fallback must fail before call")).is_err());
    }

    #[test]
    fn singleton_bypasses_engine_and_bad_inputs_never_call_it() {
        let mut i = input();
        i["contract"]["choices"] = json!(["a"]);
        let out = choose_with(&i, |_, _| panic!("single eligible choice")).unwrap();
        assert_eq!(out["choice"], "a");
        assert_eq!(out["evidence"]["bypassed"], true);
        i["contract"]["choices"] = json!(["a", "a"]);
        assert!(choose_with(&i, |_, _| panic!("duplicate choices")).is_err());
        i["contract"]["choices"] = json!(["a"]);
        i["facts"] = json!("wrong");
        assert!(choose_with(&i, |_, _| panic!("invalid facts")).is_err());
    }
}
