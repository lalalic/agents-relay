// Direct port of Node src/task-title.ts: preserve title prefix cleaning, JS whitespace and UTF-16 length limits.
use crate::js_text::{collapse_js_whitespace, is_js_whitespace, trim_js};

fn remove_prefix(value: &str) -> &str {
    // Sequential replacements in Node: heading, then bullet, then enumerated list.
    let heading_marks = value.chars().take_while(|&ch| ch == '#').count();
    let after_heading = if (1..=6).contains(&heading_marks) {
        &value[heading_marks..]
    } else {
        value
    };
    let mut current = if heading_marks > 0
        && heading_marks <= 6
        && after_heading.chars().next().is_some_and(is_js_whitespace)
    {
        after_heading.trim_start_matches(is_js_whitespace)
    } else {
        value
    };

    if current.starts_with(['-', '*', '+']) {
        let next = &current[1..];
        if next.chars().next().is_some_and(is_js_whitespace) {
            current = next.trim_start_matches(is_js_whitespace);
        }
    }
    let digits = current.bytes().take_while(u8::is_ascii_digit).count();
    if digits > 0 && current[digits..].starts_with(['.', ')']) {
        let suffix = &current[digits + 1..];
        if suffix.chars().next().is_some_and(is_js_whitespace) {
            current = suffix.trim_start_matches(is_js_whitespace);
        }
    }
    current
}

pub fn derive_task_title(input: &str, fallback: &str) -> Vec<u16> {
    let first = input
        .split('\n')
        .map(trim_js)
        .find(|line| !line.is_empty())
        .unwrap_or(fallback);
    let cleaned = collapse_js_whitespace(remove_prefix(first));
    let cleaned = trim_js(&cleaned);
    let title = if cleaned.is_empty() {
        fallback
    } else {
        cleaned
    };
    let mut units: Vec<u16> = title.encode_utf16().collect();
    if units.len() <= 96 {
        return units;
    }
    // Node .slice(0, 93) can leave a single high surrogate. Preserve UTF-16
    // code units verbatim; Rust String cannot represent that JS string.
    units.truncate(93);
    while units
        .last()
        .is_some_and(|&unit| char::from_u32(u32::from(unit)).is_some_and(is_js_whitespace))
    {
        units.pop();
    }
    units.extend(['.' as u16; 3]);
    units
}

/// Serialize JS UTF-16 code units without altering unmatched surrogate code units.
pub fn json_string_from_utf16(units: &[u16]) -> String {
    let mut output = String::from("\"");
    for unit in units {
        output.push_str(&format!("\\u{unit:04x}"));
    }
    output.push('"');
    output
}
