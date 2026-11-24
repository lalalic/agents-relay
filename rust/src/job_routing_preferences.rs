//! Durable Job routing *hints*, never Task routing constraints.
//! These exact identifiers only rank already-eligible worker/model routes.
use serde_json::{json, Map, Value};

const KEYS: [(&str, &str); 5] = [
    ("--prefer-adapter", "adapter"),
    ("--prefer-provider", "provider"),
    ("--prefer-model", "model"),
    ("--prefer-profile", "profile"),
    ("--prefer-reasoning", "reasoning"),
];

pub fn validate(value: &Value) -> Result<(), String> {
    let Some(map) = value.as_object() else {
        return Err("Job routingPreferences must be an object".into());
    };
    for (key, raw) in map {
        if !KEYS.iter().any(|(_, allowed)| *allowed == key) {
            return Err(format!("Unknown Job routing preference {key}"));
        }
        let Some(s) = raw
            .as_str()
            .filter(|s| !s.trim().is_empty() && s.trim() == *s)
        else {
            return Err(format!(
                "Job routing preference {key} must be a nonempty exact identifier"
            ));
        };
        if key == "adapter" && !matches!(s, "codex") {
            return Err("--prefer-adapter must be codex (use --profile neo for ChatGPT-backed execution)".into());
        }
    }
    Ok(())
}

/// None means no change; Some(null) explicitly clears; other values are merged.
pub fn from_cli(args: &[String], previous: Option<&Value>) -> Result<Option<Value>, String> {
    let clear = args.iter().any(|x| x == "--clear-routing-preferences");
    let supplied = KEYS.iter().any(|(flag, _)| args.iter().any(|x| x == flag || x.starts_with(&format!("{flag}="))));
    if clear && supplied {
        return Err("--clear-routing-preferences conflicts with --prefer-* flags".into());
    }
    if clear {
        return Ok(Some(Value::Null));
    }
    if !supplied {
        return Ok(None);
    }
    let mut merged = previous
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_else(Map::new);
    for (flag, key) in KEYS {
        if let Some((pos, token)) = args.iter().enumerate()
            .find(|(_, x)| *x == flag || x.starts_with(&format!("{flag}="))) {
            let raw = if let Some((_, inline)) = token.split_once('=') {
                inline
            } else {
                args.get(pos + 1).map(String::as_str)
                    .filter(|s| !s.starts_with("--"))
                    .ok_or_else(|| format!("{flag} requires an exact identifier"))?
            };
            merged.insert(key.into(), json!(raw));
        }
    }
    let result = Value::Object(merged);
    validate(&result)?;
    Ok(Some(result))
}

pub fn reject_task_flags(args: &[String]) -> Result<(), String> {
    if args.iter().any(|flag| flag == "--clear-routing-preferences"
        || KEYS.iter().any(|(key, _)| flag == key || flag.starts_with(&format!("{key}=")))) {
        return Err("--prefer-* and --clear-routing-preferences are Job-only options".into());
    }
    Ok(())
}

pub fn match_score(preference: &Value, adapter: &str, model: &Value) -> u32 {
    let Some(pref) = preference.as_object() else {
        return 0;
    };
    let mut score = 0;
    for (key, weight) in [
        ("adapter", 32),
        ("provider", 8),
        ("model", 8),
        ("profile", 4),
        ("reasoning", 2),
    ] {
        let Some(want) = pref.get(key).and_then(Value::as_str) else {
            continue;
        };
        let actual = if key == "adapter" {
            adapter
        } else {
            model.get(key).and_then(Value::as_str).unwrap_or("")
        };
        if actual == want {
            score += weight;
        }
    }
    score
}
