// Node provenance: src/cli-artifact.ts; reads JSON files and performs explicit project-schema validation.
use serde_json::{json, Value};
use std::{fs, path::Path};

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactValidationResult {
    pub valid: bool,
    pub errors: Vec<ArtifactValidationError>,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactValidationError {
    pub path: String,
    pub message: String,
}

pub fn validate_artifact(
    artifact_path: &str,
    schema_path: &str,
) -> Result<ArtifactValidationResult, String> {
    if artifact_path.is_empty() || schema_path.is_empty() {
        return Err("artifact validate requires --artifact and --schema".into());
    }
    let artifact: Value =
        serde_json::from_str(&fs::read_to_string(artifact_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    let schema: Value =
        serde_json::from_str(&fs::read_to_string(schema_path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if !schema.is_object() {
        return Err("Schema must be a JSON object".into());
    }
    if schema.get("$async").is_some() {
        return Err("Async schemas are not supported".into());
    }
    let mut errors = Vec::new();
    validate_value(&artifact, &schema, "", &mut errors);
    Ok(ArtifactValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}
fn validate_value(
    value: &Value,
    schema: &Value,
    path: &str,
    errors: &mut Vec<ArtifactValidationError>,
) {
    let ty = schema.get("type").and_then(Value::as_str);
    let matches = match ty {
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("string") => value.is_string(),
        Some("number") => value.is_number(),
        Some("integer") => value.as_i64().is_some() || value.as_u64().is_some(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => true,
    };
    if !matches {
        errors.push(ArtifactValidationError {
            path: if path.is_empty() {
                "/".into()
            } else {
                path.into()
            },
            message: format!("must be {}", ty.unwrap_or("valid")),
        });
        return;
    }
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if value.get(key).is_none() {
                errors.push(ArtifactValidationError {
                    path: if path.is_empty() {
                        "/".into()
                    } else {
                        path.into()
                    },
                    message: format!("must have required property '{key}'"),
                });
            }
        }
    }
    if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
        if let (Some(props), Some(obj)) = (
            schema.get("properties").and_then(Value::as_object),
            value.as_object(),
        ) {
            for k in obj.keys() {
                if !props.contains_key(k) {
                    errors.push(ArtifactValidationError {
                        path: if path.is_empty() {
                            "/".into()
                        } else {
                            path.into()
                        },
                        message: "must NOT have additional properties".into(),
                    });
                }
            }
        }
    }
    if let (Some(props), Some(obj)) = (
        schema.get("properties").and_then(Value::as_object),
        value.as_object(),
    ) {
        for (key, sub) in props {
            if let Some(v) = obj.get(key) {
                validate_value(
                    v,
                    sub,
                    &format!("{path}/{}", key.replace('~', "~0").replace('/', "~1")),
                    errors,
                );
            }
        }
    }
    if let (Some(s), Some(min)) = (
        value.as_str(),
        schema.get("minLength").and_then(Value::as_u64),
    ) {
        if s.chars().count() < min as usize {
            errors.push(ArtifactValidationError {
                path: if path.is_empty() {
                    "/".into()
                } else {
                    path.into()
                },
                message: format!("must NOT have fewer than {min} characters"),
            });
        }
    }
    if let Some(enums) = schema.get("enum").and_then(Value::as_array) {
        if !enums.contains(value) {
            errors.push(ArtifactValidationError {
                path: if path.is_empty() {
                    "/".into()
                } else {
                    path.into()
                },
                message: "must be equal to one of the allowed values".into(),
            });
        }
    }
}
pub fn result_json(r: &ArtifactValidationResult) -> Value {
    json!({"valid":r.valid,"errors":r.errors.iter().map(|e|json!({"path":e.path,"message":e.message})).collect::<Vec<_>>()})
}
pub fn run_artifact_command(action: &str, args: &[String]) -> Result<String, String> {
    if action != "validate" {
        return Err("artifact supports only validate".into());
    }
    let get = |flag: &str| {
        args.iter()
            .position(|x| x == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_default()
    };
    let r = validate_artifact(&get("--artifact"), &get("--schema"))?;
    Ok(serde_json::to_string_pretty(&result_json(&r)).unwrap()
        + if r.valid {
            ""
        } else {
            "\nArtifact validation failed"
        })
}
pub fn path_exists(path: &Path) -> bool {
    path.exists()
}
