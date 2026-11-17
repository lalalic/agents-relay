// Node provenance: src/cli-artifact.ts. Native subset of Ajv JSON Schema
// validation, never a hidden lifecycle gate. No Node subprocess or write I/O.
// INCOMPLETE: Ajv schema compilation, custom formats, nonlocal $ref,
// and full dialect-specific edge cases are not yet parity-complete.
// Keep this module PARTIAL even when the recorded common-keyword fixtures pass.
use crate::cli_core_support::read_file_utf8;
use regex::Regex;
use serde_json::{json, Value};
use std::path::Path;

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
fn error(errors: &mut Vec<ArtifactValidationError>, path: &str, message: impl Into<String>) {
    errors.push(ArtifactValidationError {
        path: if path.is_empty() {
            "/".into()
        } else {
            path.into()
        },
        message: message.into(),
    });
}
fn path_child(parent: &str, child: &str) -> String {
    format!("{parent}/{}", child.replace('~', "~0").replace('/', "~1"))
}
fn json_len(s: &str) -> usize {
    s.chars().count()
}
fn type_match(value: &Value, ty: &str) -> bool {
    match ty {
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_f64().is_some_and(|f| f.fract() == 0.),
        "boolean" => value.is_boolean(),
        "null" => value.is_null(),
        _ => true,
    }
}
fn schema_target<'a>(root: &'a Value, ref_str: &str) -> Option<&'a Value> {
    let tail = ref_str.strip_prefix('#')?;
    if tail.is_empty() {
        return Some(root);
    }
    root.pointer(tail)
}
fn validate(
    value: &Value,
    schema: &Value,
    root: &Value,
    path: &str,
    errors: &mut Vec<ArtifactValidationError>,
    depth: usize,
) {
    if depth > 128 {
        return;
    }
    let Some(map) = schema.as_object() else {
        return;
    };
    if let Some(reference) = map.get("$ref").and_then(Value::as_str) {
        if let Some(target) = schema_target(root, reference) {
            validate(value, target, root, path, errors, depth + 1);
        }
        return;
    }
    // Ajv's allErrors codegen checks type before the value-independent
    // combinators. It continues evaluating applicable typed constraints.
    if let Some(types) = map.get("type") {
        let labels = if let Some(ty) = types.as_str() {
            vec![ty.to_string()]
        } else {
            types
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_string)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default()
        };
        if !labels.is_empty() && !labels.iter().any(|ty| type_match(value, ty)) {
            error(errors, path, format!("must be {}", labels.join(",")));
            // With Ajv allErrors, numeric/string/array/object keywords
            // independently apply to their matching instance type.
        }
    }
    if let Some(constant) = map.get("const") {
        if value != constant {
            error(errors, path, "must be equal to constant");
        }
    }
    if let Some(allowed) = map.get("enum").and_then(Value::as_array) {
        if !allowed.contains(value) {
            error(errors, path, "must be equal to one of the allowed values");
        }
    }
    if let Some(not) = map.get("not") {
        let mut probe = vec![];
        validate(value, not, root, path, &mut probe, depth + 1);
        if probe.is_empty() {
            error(errors, path, "must NOT be valid");
        }
    }
    if let Some(sets) = map.get("anyOf").and_then(Value::as_array) {
        let mut branch_errors = vec![];
        let mut accepted = false;
        for child in sets {
            let mut current = vec![];
            validate(value, child, root, path, &mut current, depth + 1);
            if current.is_empty() {
                accepted = true;
                break;
            } else {
                branch_errors.extend(current);
            }
        }
        if !accepted {
            errors.extend(branch_errors);
            error(errors, path, "must match a schema in anyOf");
        }
    }
    if let Some(sets) = map.get("oneOf").and_then(Value::as_array) {
        let mut branch_errors = vec![];
        let mut accepted = 0;
        for child in sets {
            let mut current = vec![];
            validate(value, child, root, path, &mut current, depth + 1);
            if current.is_empty() {
                accepted += 1;
            } else {
                branch_errors.extend(current);
            }
        }
        if accepted != 1 {
            if accepted == 0 {
                errors.extend(branch_errors);
            }
            error(errors, path, "must match exactly one schema in oneOf");
        }
    }
    if let Some(sets) = map.get("allOf").and_then(Value::as_array) {
        for child in sets {
            validate(value, child, root, path, errors, depth + 1);
        }
    }
    if let Some(condition) = map.get("if") {
        let mut probe = Vec::new();
        validate(value, condition, root, path, &mut probe, depth + 1);
        let (branch, name) = if probe.is_empty() {
            (map.get("then"), "then")
        } else {
            (map.get("else"), "else")
        };
        if let Some(branch) = branch {
            let before = errors.len();
            validate(value, branch, root, path, errors, depth + 1);
            if errors.len() != before {
                error(errors, path, format!("must match \"{name}\" schema"));
            }
        }
    }
    if let Some(number) = value.as_f64() {
        for (key, message, cmp) in [
            ("maximum", "must be <=", 0),
            ("minimum", "must be >=", 1),
            ("exclusiveMaximum", "must be <", 2),
            ("exclusiveMinimum", "must be >", 3),
        ] {
            if let Some(bound) = map.get(key).and_then(Value::as_f64) {
                let invalid = match cmp {
                    0 => number > bound,
                    1 => number < bound,
                    2 => number >= bound,
                    _ => number <= bound,
                };
                if invalid {
                    error(errors, path, format!("{message} {}", map[key]));
                }
            }
        }
        if let Some(divisor) = map.get("multipleOf").and_then(Value::as_f64) {
            if divisor > 0. && ((number / divisor) - (number / divisor).round()).abs() > 1e-12 {
                error(
                    errors,
                    path,
                    format!("must be multiple of {}", map["multipleOf"]),
                );
            }
        }
    }
    if let Some(text) = value.as_str() {
        if let Some(max) = map.get("maxLength").and_then(Value::as_u64) {
            if json_len(text) > max as usize {
                error(
                    errors,
                    path,
                    format!("must NOT have more than {max} characters"),
                );
            }
        }
        if let Some(min) = map.get("minLength").and_then(Value::as_u64) {
            if json_len(text) < min as usize {
                error(
                    errors,
                    path,
                    format!("must NOT have fewer than {min} characters"),
                );
            }
        }
        if let Some(pattern) = map.get("pattern").and_then(Value::as_str) {
            if let Ok(regex) = Regex::new(pattern) {
                if !regex.is_match(text) {
                    error(errors, path, format!("must match pattern \"{pattern}\""));
                }
            }
        }
    }
    if let Some(list) = value.as_array() {
        if let Some(max) = map.get("maxItems").and_then(Value::as_u64) {
            if list.len() > max as usize {
                error(errors, path, format!("must NOT have more than {max} items"));
            }
        }
        if let Some(min) = map.get("minItems").and_then(Value::as_u64) {
            if list.len() < min as usize {
                error(
                    errors,
                    path,
                    format!("must NOT have fewer than {min} items"),
                );
            }
        }
        if let Some(contains) = map.get("contains") {
            let mut failed = Vec::new();
            let mut matching = 0;
            for (i, item) in list.iter().enumerate() {
                let mut candidate_errors = Vec::new();
                validate(
                    item,
                    contains,
                    root,
                    &path_child(path, &i.to_string()),
                    &mut candidate_errors,
                    depth + 1,
                );
                if candidate_errors.is_empty() {
                    matching += 1;
                } else {
                    failed.extend(candidate_errors);
                }
            }
            // Ajv's default draft-07 contains only requires one match. The
            // minContains/maxContains 2019 keywords are ignored by this Ajv.
            if matching == 0 {
                errors.extend(failed);
                error(errors, path, "must contain at least 1 valid item(s)");
            }
        }
        if map.get("uniqueItems") == Some(&Value::Bool(true)) {
            'pairs: for later in (0..list.len()).rev() {
                for earlier in (0..later).rev() {
                    if list[earlier] == list[later] {
                        error(errors,path,format!("must NOT have duplicate items (items ## {earlier} and {later} are identical)"));
                        break 'pairs;
                    }
                }
            }
        }
        if let Some(items) = map.get("items") {
            if let Some(tuple) = items.as_array() {
                for (index, item) in list.iter().enumerate().take(tuple.len()) {
                    validate(
                        item,
                        &tuple[index],
                        root,
                        &path_child(path, &index.to_string()),
                        errors,
                        depth + 1,
                    );
                }
                if map.get("additionalItems") == Some(&Value::Bool(false))
                    && list.len() > tuple.len()
                {
                    error(
                        errors,
                        path,
                        format!("must NOT have more than {} items", tuple.len()),
                    );
                } else if let Some(rest) = map.get("additionalItems").filter(|v| v.is_object()) {
                    for (index, item) in list.iter().enumerate().skip(tuple.len()) {
                        validate(
                            item,
                            rest,
                            root,
                            &path_child(path, &index.to_string()),
                            errors,
                            depth + 1,
                        );
                    }
                }
            } else if items.is_object() {
                for (index, item) in list.iter().enumerate() {
                    validate(
                        item,
                        items,
                        root,
                        &path_child(path, &index.to_string()),
                        errors,
                        depth + 1,
                    );
                }
            }
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(max) = map.get("maxProperties").and_then(Value::as_u64) {
            if object.len() > max as usize {
                error(
                    errors,
                    path,
                    format!("must NOT have more than {max} properties"),
                );
            }
        }
        if let Some(min) = map.get("minProperties").and_then(Value::as_u64) {
            if object.len() < min as usize {
                error(
                    errors,
                    path,
                    format!("must NOT have fewer than {min} properties"),
                );
            }
        }
        if let Some(required) = map.get("required").and_then(Value::as_array) {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) {
                    error(
                        errors,
                        path,
                        format!("must have required property '{name}'"),
                    );
                }
            }
        }
        if let Some(property_names) = map.get("propertyNames") {
            for name in object.keys() {
                let mut probe = Vec::new();
                validate(
                    &Value::String(name.clone()),
                    property_names,
                    root,
                    path,
                    &mut probe,
                    depth + 1,
                );
                if !probe.is_empty() {
                    errors.extend(probe);
                    error(errors, path, "property name must be valid");
                }
            }
        }
        let properties = map.get("properties").and_then(Value::as_object);
        let patterns = map.get("patternProperties").and_then(Value::as_object);
        if let Some(additional) = map.get("additionalProperties") {
            for name in object.keys() {
                let matched = patterns.is_some_and(|p| {
                    p.keys()
                        .any(|pattern| Regex::new(pattern).is_ok_and(|r| r.is_match(name)))
                });
                if !properties.is_some_and(|p| p.contains_key(name)) && !matched {
                    if additional == &Value::Bool(false) {
                        error(errors, path, "must NOT have additional properties");
                    } else if additional.is_object() {
                        validate(
                            &object[name],
                            additional,
                            root,
                            &path_child(path, name),
                            errors,
                            depth + 1,
                        );
                    }
                }
            }
        }
        if let Some(dependencies) = map.get("dependencies").and_then(Value::as_object) {
            for (property, dependency) in dependencies {
                if !object.contains_key(property) {
                    continue;
                }
                if let Some(names) = dependency.as_array() {
                    for name in names.iter().filter_map(Value::as_str) {
                        if !object.contains_key(name) {
                            error(
                                errors,
                                path,
                                format!(
                                    "must have property {name} when property {property} is present"
                                ),
                            );
                        }
                    }
                } else {
                    validate(value, dependency, root, path, errors, depth + 1);
                }
            }
        }
        if let Some(props) = properties {
            for (name, child) in props {
                if let Some(val) = object.get(name) {
                    validate(val, child, root, &path_child(path, name), errors, depth + 1);
                }
            }
        }
        if let Some(patterns) = patterns {
            for (pattern, child) in patterns {
                if let Ok(regex) = Regex::new(pattern) {
                    for (name, val) in object {
                        if regex.is_match(name) {
                            validate(val, child, root, &path_child(path, name), errors, depth + 1);
                        }
                    }
                }
            }
        }
    }
}

/// Match the Ajv compile-time errors that the original Node API raises
/// before validating data. Unsupported dialect features remain PARTIAL.
fn compile_schema(schema: &Value) -> Result<(), String> {
    fn walk(
        node: &Value,
        root: &Value,
        path: &str,
        errors: &mut Vec<String>,
    ) -> Result<(), String> {
        let Some(obj) = node.as_object() else {
            return Ok(());
        };
        if let Some(reference) = obj.get("$ref").and_then(Value::as_str) {
            if schema_target(root, reference).is_none() {
                return Err(format!("can't resolve reference {reference} from id #"));
            }
        }
        const TYPES: &[&str] = &[
            "array", "object", "string", "number", "integer", "boolean", "null",
        ];
        if let Some(ty) = obj.get("type") {
            if let Some(t) = ty.as_str() {
                if !TYPES.contains(&t) {
                    errors.push(format!(
                        "data{path}/type must be equal to one of the allowed values"
                    ));
                    errors.push(format!("data{path}/type must be array"));
                    errors.push(format!("data{path}/type must match a schema in anyOf"));
                }
            } else if let Some(a) = ty.as_array() {
                let bad = a
                    .iter()
                    .enumerate()
                    .filter(|(_, v)| !v.as_str().is_some_and(|t| TYPES.contains(&t)))
                    .collect::<Vec<_>>();
                let mut seen = std::collections::HashMap::new();
                let dupe = a
                    .iter()
                    .enumerate()
                    .find_map(|(i, v)| seen.insert(v.to_string(), i).map(|j| (j, i)));
                if !bad.is_empty() || dupe.is_some() || a.is_empty() {
                    errors.push(format!(
                        "data{path}/type must be equal to one of the allowed values"
                    ));
                    if a.is_empty() {
                        errors.push(format!("data{path}/type must NOT have fewer than 1 items"));
                    }
                    for (i, _) in bad {
                        errors.push(format!(
                            "data{path}/type/{i} must be equal to one of the allowed values"
                        ));
                    }
                    if let Some((j, i)) = dupe {
                        errors.push(format!("data{path}/type must NOT have duplicate items (items ## {j} and {i} are identical)"));
                    }
                    errors.push(format!("data{path}/type must match a schema in anyOf"));
                }
            } else {
                errors.push(format!(
                    "data{path}/type must be equal to one of the allowed values"
                ));
                errors.push(format!("data{path}/type must be array"));
                errors.push(format!("data{path}/type must match a schema in anyOf"));
            }
        }
        for k in [
            "minLength",
            "maxLength",
            "minItems",
            "maxItems",
            "minProperties",
            "maxProperties",
        ] {
            if let Some(v) = obj.get(k) {
                if !v.is_u64() {
                    let m = if v.as_f64().is_some_and(|f| f < 0.) {
                        "must be >= 0"
                    } else {
                        "must be integer"
                    };
                    errors.push(format!("data{path}/{k} {m}"));
                }
            }
        }
        for k in ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] {
            if obj.get(k).is_some_and(|v| !v.is_number()) {
                errors.push(format!("data{path}/{k} must be number"));
            }
        }
        if let Some(v) = obj.get("multipleOf") {
            if !v.is_number() {
                errors.push(format!("data{path}/multipleOf must be number"));
            } else if v.as_f64().is_some_and(|f| f <= 0.) {
                errors.push(format!("data{path}/multipleOf must be > 0"));
            }
        }
        if let Some(v) = obj.get("required") {
            if let Some(a) = v.as_array() {
                for (i, val) in a.iter().enumerate() {
                    if !val.is_string() {
                        errors.push(format!("data{path}/required/{i} must be string"));
                    }
                }
            } else {
                errors.push(format!("data{path}/required must be array"));
            }
        }
        if let Some(v) = obj.get("enum") {
            if let Some(a) = v.as_array() {
                if a.is_empty() {
                    errors.push(format!("data{path}/enum must NOT have fewer than 1 items"));
                }
            } else {
                errors.push(format!("data{path}/enum must be array"));
            }
        }
        for key in ["properties", "patternProperties", "definitions", "$defs"] {
            if let Some(m) = obj.get(key).and_then(Value::as_object) {
                for (name, child) in m {
                    let escaped = name.replace('~', "~0").replace('/', "~1");
                    walk(child, root, &format!("{path}/{key}/{escaped}"), errors)?;
                }
            }
        }
        for key in [
            "items",
            "additionalItems",
            "additionalProperties",
            "contains",
            "not",
            "if",
            "then",
            "else",
            "propertyNames",
        ] {
            if let Some(value) = obj.get(key) {
                if let Some(a) = value.as_array() {
                    for (i, child) in a.iter().enumerate() {
                        walk(child, root, &format!("{path}/{key}/{i}"), errors)?;
                    }
                } else {
                    walk(value, root, &format!("{path}/{key}"), errors)?;
                }
            }
        }
        for key in ["allOf", "anyOf", "oneOf"] {
            if let Some(a) = obj.get(key).and_then(Value::as_array) {
                for (i, child) in a.iter().enumerate() {
                    walk(child, root, &format!("{path}/{key}/{i}"), errors)?;
                }
            }
        }
        Ok(())
    }
    let mut errors = vec![];
    walk(schema, schema, "", &mut errors)?;
    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("schema is invalid: {}", errors.join(", ")))
    }
}

pub fn validate_artifact(
    artifact_path: &str,
    schema_path: &str,
) -> Result<ArtifactValidationResult, String> {
    if artifact_path.is_empty() || schema_path.is_empty() {
        return Err("artifact validate requires --artifact and --schema".into());
    }
    let artifact: Value =
        serde_json::from_str(&read_file_utf8(artifact_path)?).map_err(|e| e.to_string())?;
    let schema: Value =
        serde_json::from_str(&read_file_utf8(schema_path)?).map_err(|e| e.to_string())?;
    if !schema.is_object() {
        return Err("Schema must be a JSON object".into());
    }
    if schema.get("$async").is_some() {
        return Err("Async schemas are not supported".into());
    }
    compile_schema(&schema)?;
    let mut errors = vec![];
    validate(&artifact, &schema, &schema, "", &mut errors, 0);
    Ok(ArtifactValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}
pub fn result_json(result: &ArtifactValidationResult) -> Value {
    json!({"valid":result.valid,"errors":result.errors.iter().map(|e|json!({"path":e.path,"message":e.message})).collect::<Vec<_>>()})
}
/// Node stdout is emitted even when invalid; the CLI then exits with its
/// exact error instead of merging the error into the JSON stdout.
pub fn run_artifact_command<F: FnMut(String)>(
    action: &str,
    args: &[String],
    mut output: F,
) -> Result<(), String> {
    if action != "validate" {
        return Err("artifact supports only validate".into());
    }
    let read = |flag| {
        args.iter()
            .position(|s| s == flag)
            .and_then(|i| args.get(i + 1))
            .cloned()
            .unwrap_or_default()
    };
    let result = validate_artifact(&read("--artifact"), &read("--schema"))?;
    output(serde_json::to_string_pretty(&result_json(&result)).unwrap());
    if !result.valid {
        return Err("Artifact validation failed".into());
    }
    Ok(())
}
pub fn path_exists(path: &Path) -> bool {
    path.exists()
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_validation_honors_ajv_error_order() {
        let schema = json!({"type":"string","enum":["y"],"minLength":3,"pattern":"^z$"});
        let mut errors = vec![];
        validate(&json!("x"), &schema, &schema, "", &mut errors, 0);
        assert_eq!(
            errors
                .iter()
                .map(|v| v.message.as_str())
                .collect::<Vec<_>>(),
            vec![
                "must be equal to one of the allowed values",
                "must NOT have fewer than 3 characters",
                "must match pattern \"^z$\""
            ]
        );
    }
    #[test]
    fn nested_paths_escape_json_pointer() {
        let schema = json!({"properties":{"a/b":{"type":"number"}}});
        let mut errors = vec![];
        validate(
            &json!({"a/b":"wrong"}),
            &schema,
            &schema,
            "",
            &mut errors,
            0,
        );
        assert_eq!(errors[0].path, "/a~1b");
    }
}
