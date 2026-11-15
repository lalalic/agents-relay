//! Read-only Node-shaped platform CLI commands.
use regex::Regex;
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;

fn option(args: &[String], key: &str) -> Result<String, String> {
    if args.iter().filter(|arg| arg.as_str() == key).count() > 1 {
        return Err(format!("duplicate option {key}"));
    }
    let i = args
        .iter()
        .position(|arg| arg == key)
        .ok_or_else(|| format!("missing {key}"))?;
    args.get(i + 1)
        .filter(|value| !value.starts_with("--"))
        .cloned()
        .ok_or_else(|| format!("missing value for {key}"))
}

#[derive(Default)]
struct Errors(Vec<Value>);

fn pointer(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}

fn type_matches(value: &Value, expected: &str) -> bool {
    match expected {
        "null" => value.is_null(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        _ => true,
    }
}

fn add(errors: &mut Errors, path: &str, message: impl Into<String>) {
    errors
        .0
        .push(json!({"path": if path.is_empty() { "/" } else { path }, "message": message.into()}));
}

fn validate(value: &Value, schema: &Value, path: &str, errors: &mut Errors) -> Result<(), String> {
    let object = schema.as_object().ok_or("Schema must be a JSON object")?;
    if object.contains_key("$async") {
        return Err("Async schemas are not supported".into());
    }
    let known = [
        "$schema",
        "$id",
        "$ref",
        "$async",
        "title",
        "description",
        "default",
        "examples",
        "type",
        "enum",
        "const",
        "required",
        "properties",
        "additionalProperties",
        "items",
        "minItems",
        "maxItems",
        "uniqueItems",
        "minimum",
        "maximum",
        "exclusiveMinimum",
        "exclusiveMaximum",
        "multipleOf",
        "minLength",
        "maxLength",
        "pattern",
    ];
    if let Some(keyword) = object.keys().find(|key| !known.contains(&key.as_str())) {
        return Err(format!("Unsupported JSON Schema keyword {keyword}"));
    }
    if object.contains_key("$ref") {
        return Err("JSON Schema $ref is not supported".into());
    }
    if let Some(kind) = object.get("type") {
        let types: Vec<&str> = match kind {
            Value::String(s) => vec![s],
            Value::Array(a) => a.iter().filter_map(Value::as_str).collect(),
            _ => return Err("Invalid JSON Schema type".into()),
        };
        if !types.iter().any(|expected| type_matches(value, expected)) {
            let display = if types.len() == 1 {
                if types[0] == "integer" {
                    "integer".to_owned()
                } else {
                    format!("type \"{}\"", types[0])
                }
            } else {
                format!(
                    "type [{}]",
                    types
                        .iter()
                        .map(|s| format!("\"{s}\""))
                        .collect::<Vec<_>>()
                        .join(",")
                )
            };
            add(errors, path, format!("must be {display}"));
            return Ok(());
        }
    }
    if let Some(values) = object.get("enum").and_then(Value::as_array) {
        if !values.contains(value) {
            add(errors, path, "must be equal to one of the allowed values");
        }
    }
    if let Some(expected) = object.get("const") {
        if value != expected {
            add(errors, path, "must be equal to constant");
        }
    }
    if let Some(required) = object.get("required").and_then(Value::as_array) {
        if let Some(props) = value.as_object() {
            for key in required.iter().filter_map(Value::as_str) {
                if !props.contains_key(key) {
                    add(errors, path, format!("must have required property '{key}'"));
                }
            }
        }
    }
    if let Some(properties) = object.get("properties").and_then(Value::as_object) {
        if let Some(values) = value.as_object() {
            if object.get("additionalProperties") == Some(&Value::Bool(false))
                && values.keys().any(|key| !properties.contains_key(key))
            {
                add(errors, path, "must NOT have additional properties");
            }
            for (key, child_schema) in properties {
                if let Some(child) = values.get(key) {
                    validate(child, child_schema, &pointer(path, key), errors)?;
                }
            }
        }
    }
    if let Some(items) = value.as_array() {
        for keyword in ["minItems", "maxItems"] {
            if let Some(limit) = object.get(keyword).and_then(Value::as_u64) {
                let bad = if keyword == "minItems" {
                    items.len() < limit as usize
                } else {
                    items.len() > limit as usize
                };
                if bad {
                    add(
                        errors,
                        path,
                        format!(
                            "must NOT have {} items",
                            if keyword == "minItems" {
                                format!("fewer than {limit}")
                            } else {
                                format!("more than {limit}")
                            }
                        ),
                    );
                }
            }
        }
        if let Some(item_schema) = object.get("items") {
            for (i, item) in items.iter().enumerate() {
                validate(item, item_schema, &format!("{path}/{i}"), errors)?;
            }
        }
        if object.get("uniqueItems") == Some(&Value::Bool(true)) {
            'outer: for i in 0..items.len() {
                for j in 0..i {
                    if items[j] == items[i] {
                        add(errors,path,format!("must NOT have duplicate items (items ## {i} and {j} are identical)"));
                        break 'outer;
                    }
                }
            }
        }
    }
    if let Some(text) = value.as_str() {
        for keyword in ["minLength", "maxLength"] {
            if let Some(limit) = object.get(keyword).and_then(Value::as_u64) {
                let length = text.chars().count() as u64;
                if (keyword == "minLength" && length < limit)
                    || (keyword == "maxLength" && length > limit)
                {
                    add(
                        errors,
                        path,
                        format!(
                            "must NOT have {} characters",
                            if keyword == "minLength" {
                                format!("fewer than {limit}")
                            } else {
                                format!("more than {limit}")
                            }
                        ),
                    );
                }
            }
        }
        if let Some(pattern) = object.get("pattern").and_then(Value::as_str) {
            let re = Regex::new(pattern).map_err(|error| format!("Invalid pattern: {error}"))?;
            if !re.is_match(text) {
                add(errors, path, format!("must match pattern \"{pattern}\""));
            }
        }
    }
    if let Some(number) = value.as_f64() {
        for (keyword, mode, text) in [
            ("minimum", 0, ">="),
            ("maximum", 1, "<="),
            ("exclusiveMinimum", 2, ">"),
            ("exclusiveMaximum", 3, "<"),
        ] {
            if let Some(bound) = object.get(keyword).and_then(Value::as_f64) {
                let fails = match mode {
                    0 => number < bound,
                    1 => number > bound,
                    2 => number <= bound,
                    _ => number >= bound,
                };
                if fails {
                    add(errors, path, format!("must be {} {}", text, bound));
                }
            }
        }
        if let Some(multiple) = object.get("multipleOf").and_then(Value::as_f64) {
            if multiple != 0.0 && (number / multiple - (number / multiple).round()).abs() > 1e-10 {
                add(errors, path, format!("must be multiple of {multiple}"));
            }
        }
    }
    Ok(())
}

pub fn run(args: &[String]) -> Result<(), String> {
    if args.first().map(String::as_str) != Some("validate") {
        return Err("artifact supports only validate".into());
    }
    let allowed = ["--artifact", "--schema"];
    for arg in args.iter().filter(|arg| arg.starts_with("--")) {
        if !allowed.contains(&arg.as_str()) {
            return Err(format!("unrecognized artifact option {arg}"));
        }
    }
    let artifact_path = PathBuf::from(option(args, "--artifact")?);
    let schema_path = PathBuf::from(option(args, "--schema")?);
    let artifact: Value = serde_json::from_slice(
        &fs::read(&artifact_path).map_err(|e| format!("artifact file: {e}"))?,
    )
    .map_err(|e| format!("artifact JSON: {e}"))?;
    let schema: Value =
        serde_json::from_slice(&fs::read(&schema_path).map_err(|e| format!("schema file: {e}"))?)
            .map_err(|e| format!("schema JSON: {e}"))?;
    if !schema.is_object() {
        return Err("Schema must be a JSON object".into());
    }
    if schema.get("$async").is_some() {
        return Err("Async schemas are not supported".into());
    }
    let mut errors = Errors::default();
    validate(&artifact, &schema, "", &mut errors)?;
    let valid = errors.0.is_empty();
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({"valid":valid,"errors":errors.0}))
            .map_err(|e| e.to_string())?
    );
    if !valid {
        return Err("Artifact validation failed".into());
    }
    Ok(())
}

pub fn dispatch(args: &[String]) -> Result<(), String> {
    let command = args.first().map(String::as_str).unwrap_or("");
    if command == "artifact" {
        return run(&args[1..]);
    }
    if [
        "agent-discover",
        "agent-register",
        "context",
        "prompt",
        "blocker",
        "projection",
        "migrate-local-repositories",
        "plan",
    ]
    .contains(&command)
    {
        return Err(format!(
            "{command} has no native Rust parity yet; this command is intentionally unimplemented"
        ));
    }
    Err("unknown native platform CLI command".into())
}
