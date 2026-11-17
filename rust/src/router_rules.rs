// Direct port of src/router-rules.ts: parse only explicit choices and preserve routing instruction bytes.
use crate::js_text::trim_js;
use regex::Regex;
use serde_json::{json, Value};
use std::collections::HashSet;

pub fn append_routing_instruction(question: &str, instruction: &str) -> String {
    if instruction.is_empty() {
        question.to_string()
    } else {
        format!("{question}\n\n{instruction}")
    }
}

pub fn append_agent_model_preference(question: &str, preference: Option<&Value>) -> String {
    let model = preference
        .and_then(|v| v.get("model"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    let reasoning = preference
        .and_then(|v| v.get("reasoning"))
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty());
    if model.is_none() && reasoning.is_none() {
        return question.to_string();
    }
    let mut lines = vec!["Agent model preference (advisory only; lower priority than user routing instructions and all hard constraints):".to_string()];
    if let Some(model) = model {
        lines.push(format!("Prefer model: {model}"));
    }
    if let Some(reasoning) = reasoning {
        lines.push(format!("Prefer reasoning: {reasoning}"));
    }
    lines.push("Choose only among the existing eligible routes. Do not invent or enable a route to satisfy this preference.".to_string());
    append_routing_instruction(question, &lines.join("\n"))
}

fn raw_section_body(text: &str, name: &str) -> Option<String> {
    // Unlike Rust regex multiline anchors, JS /^...$/gm treats CR, LF,
    // U+2028 and U+2029 as distinct line boundaries. This byte-offset scanner
    // reproduces Node's first matching header and exact untrimmed body.
    let header =
        Regex::new(r"(?i)^[ \t]*\[([a-z][a-z0-9-]*)\][ \t]*$").expect("fixed header regex");
    let mut found = Vec::<(String, usize, usize)>::new();
    let mut start = 0;
    for (offset, ch) in text.char_indices() {
        if !matches!(ch, '\r' | '\n' | '\u{2028}' | '\u{2029}') {
            continue;
        }
        let line = &text[start..offset];
        if let Some(capture) = header.captures(line) {
            // The Node /\r?$/ suffix consumes the CR in a CRLF header.
            let match_end = if ch == '\r' { offset + 1 } else { offset };
            found.push((capture[1].to_ascii_lowercase(), start, match_end));
        }
        start = offset + ch.len_utf8();
    }
    if let Some(capture) = header.captures(&text[start..]) {
        found.push((capture[1].to_ascii_lowercase(), start, text.len()));
    }
    let position = found.iter().position(|entry| entry.0 == name)?;
    let mut body_start = found[position].2;
    if text.as_bytes().get(body_start) == Some(&b'\r') {
        body_start += 1;
    }
    if text.as_bytes().get(body_start) == Some(&b'\n') {
        body_start += 1;
    }
    let body_end = found
        .get(position + 1)
        .map(|entry| entry.1)
        .unwrap_or(text.len());
    text.get(body_start..body_end).map(str::to_string)
}

fn choice_key(choice: &Value) -> String {
    [
        choice.get("worker").and_then(Value::as_str).unwrap_or(""),
        choice.get("provider").and_then(Value::as_str).unwrap_or(""),
        choice.get("model").and_then(Value::as_str).unwrap_or(""),
        choice
            .get("reasoning")
            .and_then(Value::as_str)
            .unwrap_or(""),
    ]
    .join("\0")
}

pub fn parse_router_rules(text: &str) -> Value {
    let section_header = Regex::new(r"(?i)^\[([a-z][a-z0-9-]*)\]$").expect("fixed section regex");
    let explicit_route = Regex::new(
        r"^([A-Za-z0-9._/-]+)::([A-Za-z0-9._-]+):([A-Za-z0-9._/-]+)(?:@([A-Za-z0-9._-]+))?$",
    )
    .expect("fixed route regex");
    // JavaScript \s differs from Rust Unicode \s: FEFF belongs, U+0085 does not.
    // JS dot also excludes U+2028/U+2029, even when the input uses LF line splitting.
    const JS_WS: &str = r"[\x09-\x0D\x20\u{00A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}]";
    let provider_route = Regex::new(&format!(
        r"^{JS_WS}*([A-Za-z0-9._-]+){JS_WS}*:{JS_WS}*([^\r\n\u{{2028}}\u{{2029}}]+)[\u{{2028}}\u{{2029}}]?$"
    )).expect("fixed JS-compatible provider regex");
    let mut choices = Vec::new();
    let mut seen = HashSet::new();
    let mut section = "".to_string();
    for line in text.split('\n') {
        let raw_line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(header) = section_header.captures(trim_js(raw_line)) {
            section = header[1].to_ascii_lowercase();
            continue;
        }
        if section != "choices" {
            continue;
        }
        let trimmed = trim_js(raw_line);
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some(route) = explicit_route.captures(trimmed) {
            let mut choice = json!({"worker":route[1],"provider":route[2],"model":route[3]});
            if let Some(reasoning) = route.get(4) {
                choice["reasoning"] = json!(reasoning.as_str().to_ascii_lowercase());
            }
            if seen.insert(choice_key(&choice)) {
                choices.push(choice);
            }
            continue;
        }
        if let Some(route) = provider_route.captures(raw_line) {
            let provider = trim_js(&route[1]);
            for segment in route[2].split(',') {
                let tokens = trim_js(segment)
                    .split(crate::js_text::is_js_whitespace)
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>();
                if tokens.is_empty() {
                    continue;
                }
                let mut choice = json!({"provider":provider,"model":tokens[0]});
                if let Some(reasoning) = tokens.get(1) {
                    choice["reasoning"] = json!(reasoning.to_ascii_lowercase());
                }
                if seen.insert(choice_key(&choice)) {
                    choices.push(choice);
                }
            }
        }
    }
    json!({"choices":choices,"routingInstruction":raw_section_body(text,"routing-instruction").unwrap_or_default()})
}
